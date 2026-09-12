import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readSourceArchiveResponse } from "./source-archive";

const fullCommitPattern = /^[0-9a-f]{40}$/;
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const githubApiBase = "https://api.github.com";
const githubArchiveHost = "codeload.github.com";
const githubApiVersion = "2022-11-28";
const maxDiscoveryFileBytes = 1024 * 1024;

const discoveryFileAllowlist = Object.freeze([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "Procfile",
  ".env.example",
  ".env.sample",
  "example.env",
] as const);

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GitHubAppConfig = {
  appId: string;
  privateKeyPem: string;
};

export type GitHubArchiveResult = {
  archive: Buffer;
  authMode: "PUBLIC" | "GITHUB_APP";
};

export type GitHubRepositoryInspection = Readonly<{
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  repositoryUrl: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  defaultBranch: string;
  selectedBranch: string;
  revisionSha: string;
  rootEntries: readonly string[];
  files: Readonly<Record<string, string>>;
}>;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function githubHeaders(authorization?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Rundea-Control-Plane",
    "X-GitHub-Api-Version": githubApiVersion,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

function repositoryIdentity(fullName: string): { owner: string; repository: string } {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !repoPartPattern.test(parts[0] ?? "") || !repoPartPattern.test(parts[1] ?? "")) {
    throw new Error("invalid GitHub repository identity");
  }
  return { owner: parts[0]!, repository: parts[1]! };
}

function validateDiscoveryBranch(value: string): string {
  const branch = value.trim();
  if (!branch || branch.length > 255) throw new Error("GitHub branch is invalid");
  if (branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    throw new Error("GitHub branch is invalid");
  }
  if (/\s|[~^:?*\\[\x00-\x1f\x7f]/.test(branch) || branch.includes("..") || branch.includes("//") || branch.includes("@{")) {
    throw new Error("GitHub branch is invalid");
  }
  return branch;
}

function visibilityFrom(body: any): "PUBLIC" | "PRIVATE" | "INTERNAL" {
  if (body?.visibility === "public") return "PUBLIC";
  if (body?.visibility === "private") return "PRIVATE";
  if (body?.visibility === "internal") return "INTERNAL";
  if (body?.private === true) return "PRIVATE";
  if (body?.private === false) return "PUBLIC";
  throw new Error("GitHub repository visibility is invalid");
}

function validateRepositoryUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub repository URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub repository URL is invalid");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub repository URL is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.RUNDEA_GITHUB_APP_ID?.trim();
  const privateKeyBase64 = env.RUNDEA_GITHUB_APP_PRIVATE_KEY_BASE64?.trim();
  if (!appId && !privateKeyBase64) return null;
  if (!appId || !privateKeyBase64) {
    throw new Error("RUNDEA_GITHUB_APP_ID and RUNDEA_GITHUB_APP_PRIVATE_KEY_BASE64 must be configured together");
  }
  if (!/^[1-9][0-9]*$/.test(appId)) throw new Error("RUNDEA_GITHUB_APP_ID must be a positive integer");

  const privateKeyPem = Buffer.from(privateKeyBase64, "base64").toString("utf8").trim();
  if (!privateKeyPem.includes("PRIVATE KEY")) throw new Error("GitHub App private key is invalid");
  createPrivateKey(privateKeyPem);
  return { appId, privateKeyPem };
}

export function createGitHubAppJwt(config: GitHubAppConfig, nowMs = Date.now()): string {
  if (!/^[1-9][0-9]*$/.test(config.appId)) throw new Error("GitHub App ID is invalid");
  const now = Math.floor(nowMs / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 540, iss: config.appId });
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), createPrivateKey(config.privateKeyPem)).toString("base64url");
  return `${signingInput}.${signature}`;
}

function validateArchiveRedirect(location: string | null): URL {
  if (!location) throw new Error("GitHub archive response did not include a redirect location");
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error("GitHub archive redirect is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== githubArchiveHost ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("GitHub archive redirect host is not allowed");
  }
  return url;
}

async function jsonBody(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub API returned invalid JSON (${response.status})`);
  }
}

export class GitHubArchiveProvider {
  readonly appConfigured: boolean;

  constructor(
    private readonly appConfig: GitHubAppConfig | null = loadGitHubAppConfig(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.appConfigured = Boolean(appConfig);
  }

  private archiveApiUrl(owner: string, repository: string, commitSha: string): string {
    return `${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball/${commitSha}`;
  }

  private async downloadRedirect(location: string | null): Promise<Buffer> {
    const url = validateArchiveRedirect(location);
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        "User-Agent": "Rundea-Control-Plane",
        Accept: "application/gzip, application/octet-stream;q=0.9, */*;q=0.1",
      },
    });
    if (!response.ok) throw new Error(`GitHub archive download returned ${response.status}`);
    return await readSourceArchiveResponse(response);
  }

  private async publicArchive(owner: string, repository: string, commitSha: string): Promise<Buffer | null> {
    const response = await this.fetchImpl(this.archiveApiUrl(owner, repository, commitSha), {
      method: "GET",
      redirect: "manual",
      headers: githubHeaders(),
    });
    if (response.status === 302) return await this.downloadRedirect(response.headers.get("location"));
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403 || response.status === 404) return null;
    throw new Error(`GitHub source archive returned ${response.status}`);
  }

  private appJwt(): string {
    if (!this.appConfig) throw new Error("GitHub App is not configured for private source access");
    return createGitHubAppJwt(this.appConfig);
  }

  private async repositoryInstallation(owner: string, repository: string): Promise<number> {
    const response = await this.fetchImpl(`${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`, {
      method: "GET",
      redirect: "error",
      headers: githubHeaders(`Bearer ${this.appJwt()}`),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub App installation lookup returned ${response.status}`);
    }
    const body = await jsonBody(response);
    const installationId = Number(body?.id);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("GitHub App installation response is invalid");
    return installationId;
  }

  private async installationToken(installationId: number, repository: string): Promise<string> {
    const response = await this.fetchImpl(`${githubApiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      redirect: "error",
      headers: {
        ...githubHeaders(`Bearer ${this.appJwt()}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositories: [repository], permissions: { contents: "read" } }),
    });
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub App installation token request returned ${response.status}`);
    }
    const body = await jsonBody(response);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("GitHub App installation token response is invalid");
    return token;
  }

  private async authenticatedJson(url: string, token: string, label: string): Promise<any> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: githubHeaders(`Bearer ${token}`),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${label} returned ${response.status}`);
    }
    return await jsonBody(response);
  }

  private async discoveryFile(owner: string, repository: string, branch: string, file: string, token: string): Promise<string> {
    const url = `${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`;
    const body = await this.authenticatedJson(url, token, `GitHub repository file ${file}`);
    if (body?.type !== "file" || body?.encoding !== "base64" || typeof body?.content !== "string") {
      throw new Error(`GitHub repository file ${file} response is invalid`);
    }
    const size = Number(body?.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxDiscoveryFileBytes) {
      throw new Error(`GitHub repository file ${file} is too large for discovery`);
    }
    const bytes = Buffer.from(body.content.replace(/\n/g, ""), "base64");
    if (bytes.length > maxDiscoveryFileBytes) throw new Error(`GitHub repository file ${file} is too large for discovery`);
    return bytes.toString("utf8");
  }

  async inspectRepository(repositoryFullName: string, selectedBranch?: string): Promise<GitHubRepositoryInspection> {
    if (!this.appConfig) throw new Error("GitHub App is required for repository discovery");
    const { owner, repository } = repositoryIdentity(repositoryFullName);
    const installationId = await this.repositoryInstallation(owner, repository);
    const token = await this.installationToken(installationId, repository);
    const repositoryApi = `${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    const metadata = await this.authenticatedJson(repositoryApi, token, "GitHub repository metadata");

    const repositoryId = Number(metadata?.id);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error("GitHub repository ID is invalid");
    if (typeof metadata?.full_name !== "string" || metadata.full_name.toLowerCase() !== repositoryFullName.toLowerCase()) {
      throw new Error("GitHub repository identity changed during discovery");
    }
    const defaultBranch = validateDiscoveryBranch(typeof metadata?.default_branch === "string" ? metadata.default_branch : "");
    const branch = validateDiscoveryBranch(selectedBranch ?? defaultBranch);
    const repositoryUrl = validateRepositoryUrl(metadata?.html_url);
    const visibility = visibilityFrom(metadata);

    const commit = await this.authenticatedJson(
      `${repositoryApi}/commits/${encodeURIComponent(branch)}`,
      token,
      "GitHub repository revision",
    );
    const revisionSha = typeof commit?.sha === "string" ? commit.sha.toLowerCase() : "";
    if (!fullCommitPattern.test(revisionSha)) throw new Error("GitHub repository revision is invalid");

    const root = await this.authenticatedJson(
      `${repositoryApi}/contents?ref=${encodeURIComponent(branch)}`,
      token,
      "GitHub repository root contents",
    );
    if (!Array.isArray(root)) throw new Error("GitHub repository root contents response is invalid");
    const rootEntries = root
      .flatMap((entry: any) => (typeof entry?.name === "string" && !/[\r\n\u0000]/.test(entry.name) ? [entry.name] : []))
      .sort((left: string, right: string) => left.localeCompare(right));
    const rootSet = new Set(rootEntries);

    const files: Record<string, string> = {};
    for (const file of discoveryFileAllowlist) {
      if (!rootSet.has(file)) continue;
      files[file] = await this.discoveryFile(owner, repository, branch, file, token);
    }

    return Object.freeze({
      installationId,
      repositoryId,
      repositoryFullName: metadata.full_name.toLowerCase(),
      repositoryUrl,
      visibility,
      defaultBranch,
      selectedBranch: branch,
      revisionSha,
      rootEntries: Object.freeze(rootEntries),
      files: Object.freeze(files),
    });
  }

  private async privateArchive(owner: string, repository: string, commitSha: string): Promise<Buffer> {
    if (!this.appConfig) throw new Error("private GitHub repository requires a configured Rundea GitHub App");
    const installationId = await this.repositoryInstallation(owner, repository);
    const token = await this.installationToken(installationId, repository);
    const response = await this.fetchImpl(this.archiveApiUrl(owner, repository, commitSha), {
      method: "GET",
      redirect: "manual",
      headers: githubHeaders(`Bearer ${token}`),
    });
    if (response.status !== 302) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`authenticated GitHub source archive returned ${response.status}`);
    }
    // Deliberately do not pass the installation token to the temporary codeload URL.
    return await this.downloadRedirect(response.headers.get("location"));
  }

  async fetchArchive(repositoryFullName: string, commitSha: string): Promise<GitHubArchiveResult> {
    if (!fullCommitPattern.test(commitSha)) throw new Error("private source fetch requires an exact lowercase Git commit SHA");
    const { owner, repository } = repositoryIdentity(repositoryFullName);
    const publicArchive = await this.publicArchive(owner, repository, commitSha);
    if (publicArchive) return { archive: publicArchive, authMode: "PUBLIC" };
    return { archive: await this.privateArchive(owner, repository, commitSha), authMode: "GITHUB_APP" };
  }
}

export function createGitHubArchiveProviderFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): GitHubArchiveProvider {
  return new GitHubArchiveProvider(loadGitHubAppConfig(env), fetchImpl);
}
