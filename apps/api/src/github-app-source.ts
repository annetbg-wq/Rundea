import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readSourceArchiveResponse } from "./source-archive";

const fullCommitPattern = /^[0-9a-f]{40}$/;
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const githubApiBase = "https://api.github.com";
const githubArchiveHost = "codeload.github.com";
const githubApiVersion = "2022-11-28";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type GitHubAppConfig = {
  appId: string;
  privateKeyPem: string;
};

export type GitHubArchiveResult = {
  archive: Buffer;
  authMode: "PUBLIC" | "GITHUB_APP";
};

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
