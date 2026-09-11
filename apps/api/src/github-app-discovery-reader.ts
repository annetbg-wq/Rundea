import {
  createGitHubAppJwt,
  loadGitHubAppConfig,
  type GitHubAppConfig,
} from "./github-app-source";
import type {
  GitHubRepositoryMetadata,
  GitHubRepositoryReader,
  GitHubResolvedRevision,
  GitHubTreeEntry,
} from "./github-source-discovery";

const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/i;
const maxJsonBytes = 4 * 1024 * 1024;
const tokenRefreshSkewMs = 60_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type CachedToken = Readonly<{
  token: string;
  expiresAtMs: number;
}>;

function repositoryIdentity(fullName: string): { owner: string; repository: string; fullName: string } {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !repoPartPattern.test(parts[0] ?? "") || !repoPartPattern.test(parts[1] ?? "")) {
    throw new Error("invalid GitHub repository identity");
  }
  return { owner: parts[0]!, repository: parts[1]!, fullName: `${parts[0]}/${parts[1]}` };
}

function headers(authorization: string): Record<string, string> {
  return {
    Authorization: authorization,
    Accept: "application/vnd.github+json",
    "User-Agent": "Rundea-Control-Plane",
    "X-GitHub-Api-Version": githubApiVersion,
  };
}

async function boundedJson(response: Response, maxBytes = maxJsonBytes): Promise<any> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("GitHub API response exceeds discovery limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("GitHub API response exceeds discovery limit");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`GitHub API returned invalid JSON (${response.status})`);
  }
}

export class GitHubAppDiscoveryReader implements GitHubRepositoryReader {
  private readonly tokenCache = new Map<string, CachedToken>();

  constructor(
    private readonly appConfig: GitHubAppConfig | null = loadGitHubAppConfig(),
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private requireAppConfig(): GitHubAppConfig {
    if (!this.appConfig) throw new Error("GitHub App is required for connected repository discovery");
    return this.appConfig;
  }

  private async installationToken(fullName: string): Promise<string> {
    const identity = repositoryIdentity(fullName);
    const cached = this.tokenCache.get(identity.fullName);
    if (cached && cached.expiresAtMs - tokenRefreshSkewMs > this.now()) return cached.token;

    const appConfig = this.requireAppConfig();
    const appJwt = createGitHubAppJwt(appConfig, this.now());
    const installationResponse = await this.fetchImpl(
      `${githubApiBase}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repository)}/installation`,
      { method: "GET", redirect: "error", headers: headers(`Bearer ${appJwt}`) },
    );
    if (!installationResponse.ok) {
      await installationResponse.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub App installation lookup returned ${installationResponse.status}`);
    }
    const installationBody = await boundedJson(installationResponse, 256 * 1024);
    const installationId = Number(installationBody?.id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("GitHub App installation response is invalid");

    const tokenResponse = await this.fetchImpl(`${githubApiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      redirect: "error",
      headers: {
        ...headers(`Bearer ${appJwt}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositories: [identity.repository], permissions: { contents: "read" } }),
    });
    if (tokenResponse.status !== 201) {
      await tokenResponse.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub App installation token request returned ${tokenResponse.status}`);
    }
    const tokenBody = await boundedJson(tokenResponse, 256 * 1024);
    const token = typeof tokenBody?.token === "string" ? tokenBody.token.trim() : "";
    const expiresAtMs = Date.parse(String(tokenBody?.expires_at ?? ""));
    if (!token || token.length > 4096 || /[\r\n\u0000]/.test(token) || !Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
      throw new Error("GitHub App installation token response is invalid");
    }
    this.tokenCache.set(identity.fullName, { token, expiresAtMs });
    return token;
  }

  private async get(fullName: string, path: string, maxBytes = maxJsonBytes): Promise<any> {
    const identity = repositoryIdentity(fullName);
    const token = await this.installationToken(identity.fullName);
    const response = await this.fetchImpl(
      `${githubApiBase}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repository)}${path}`,
      { method: "GET", redirect: "error", headers: headers(`Bearer ${token}`) },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub discovery request returned ${response.status}`);
    }
    return boundedJson(response, maxBytes);
  }

  async repository(fullName: string): Promise<GitHubRepositoryMetadata> {
    const identity = repositoryIdentity(fullName);
    const body = await this.get(identity.fullName, "", 512 * 1024);
    const returnedFullName = typeof body?.full_name === "string" ? body.full_name : "";
    const htmlUrl = typeof body?.html_url === "string" ? body.html_url : "";
    const defaultBranch = typeof body?.default_branch === "string" ? body.default_branch.trim() : "";
    const visibility = body?.visibility;
    if (
      returnedFullName.toLowerCase() !== identity.fullName.toLowerCase() ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(htmlUrl) ||
      !defaultBranch ||
      defaultBranch.length > 256 ||
      (visibility !== "public" && visibility !== "private" && visibility !== "internal")
    ) {
      throw new Error("GitHub repository metadata response is invalid");
    }
    return { fullName: returnedFullName, htmlUrl, visibility, defaultBranch };
  }

  async resolveRevision(fullName: string, ref: string): Promise<GitHubResolvedRevision> {
    if (!ref || ref.length > 256 || /[\r\n\u0000]/.test(ref)) throw new Error("GitHub source ref is invalid");
    const body = await this.get(fullName, `/commits/${encodeURIComponent(ref)}`, 1024 * 1024);
    const commitSha = typeof body?.sha === "string" ? body.sha : "";
    const treeSha = typeof body?.commit?.tree?.sha === "string" ? body.commit.tree.sha : "";
    if (!shaPattern.test(commitSha) || !shaPattern.test(treeSha)) throw new Error("GitHub commit metadata response is invalid");
    return { commitSha: commitSha.toLowerCase(), treeSha: treeSha.toLowerCase() };
  }

  async tree(fullName: string, treeSha: string): Promise<readonly GitHubTreeEntry[]> {
    if (!shaPattern.test(treeSha)) throw new Error("GitHub tree SHA is invalid");
    const body = await this.get(fullName, `/git/trees/${treeSha}?recursive=1`);
    if (body?.truncated === true) throw new Error("GitHub repository tree is truncated");
    if (!Array.isArray(body?.tree)) throw new Error("GitHub repository tree response is invalid");

    const entries: GitHubTreeEntry[] = [];
    for (const item of body.tree) {
      const path = typeof item?.path === "string" ? item.path : "";
      const type = item?.type;
      const sha = typeof item?.sha === "string" ? item.sha : "";
      const size = item?.size === undefined ? undefined : Number(item.size);
      if (!path || path.length > 1024 || /[\r\n\u0000]/.test(path) || (type !== "blob" && type !== "tree") || !shaPattern.test(sha)) {
        throw new Error("GitHub repository tree entry is invalid");
      }
      if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new Error("GitHub repository tree entry size is invalid");
      entries.push(size === undefined ? { path, type, sha: sha.toLowerCase() } : { path, type, sha: sha.toLowerCase(), size });
    }
    return entries;
  }

  async readTextBlob(fullName: string, blobSha: string, maxBytes: number): Promise<string | null> {
    if (!shaPattern.test(blobSha) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
      throw new Error("GitHub blob read request is invalid");
    }
    const body = await this.get(fullName, `/git/blobs/${blobSha}`, Math.min(maxJsonBytes, Math.ceil(maxBytes * 1.5) + 64 * 1024));
    if (body?.encoding !== "base64" || typeof body?.content !== "string") return null;
    const declaredSize = Number(body?.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxBytes) return null;
    const bytes = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
    if (bytes.byteLength !== declaredSize || bytes.byteLength > maxBytes || bytes.includes(0)) return null;
    return bytes.toString("utf8");
  }
}

export function createGitHubAppDiscoveryReaderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): GitHubAppDiscoveryReader {
  return new GitHubAppDiscoveryReader(loadGitHubAppConfig(env), fetchImpl);
}
