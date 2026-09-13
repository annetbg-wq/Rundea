import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createGitHubAppJwt, loadGitHubAppConfig, type GitHubAppConfig } from "./github-app-source";
import { readResponseBodyWithLimit } from "./source-archive";

const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const releaseTagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const maxAgentBytes = 64 * 1024 * 1024;
const maxManifestBytes = 1024 * 1024;

export type AgentArchitecture = "amd64" | "arm64";
export type AgentReleaseConfig = {
  repositoryFullName: string;
  tag: string;
  appConfig: GitHubAppConfig;
};
export type AgentRelease = {
  architecture: AgentArchitecture;
  filename: string;
  tag: string;
  sha256: string;
  binary: Buffer;
};
export type AgentReleaseProvider = { get(architecture: AgentArchitecture): Promise<AgentRelease> };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ReleaseAsset = { name: string; url: string; size: number };

function githubHeaders(authorization?: string, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    Accept: accept,
    "User-Agent": "Rundea-Control-Plane",
    "X-GitHub-Api-Version": githubApiVersion,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

function repositoryIdentity(fullName: string): { owner: string; repository: string } {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !repoPartPattern.test(parts[0] ?? "") || !repoPartPattern.test(parts[1] ?? "")) {
    throw new Error("RUNDEA_AGENT_RELEASE_REPOSITORY must be owner/repository");
  }
  return { owner: parts[0]!, repository: parts[1]! };
}

export function loadAgentReleaseConfig(env: NodeJS.ProcessEnv = process.env): AgentReleaseConfig | null {
  const repositoryFullName = env.RUNDEA_AGENT_RELEASE_REPOSITORY?.trim();
  const tag = env.RUNDEA_AGENT_RELEASE_TAG?.trim();
  if (!repositoryFullName && !tag) return null;
  if (!repositoryFullName || !tag) {
    throw new Error("RUNDEA_AGENT_RELEASE_REPOSITORY and RUNDEA_AGENT_RELEASE_TAG must be configured together");
  }
  repositoryIdentity(repositoryFullName);
  if (!releaseTagPattern.test(tag)) throw new Error("RUNDEA_AGENT_RELEASE_TAG contains unsupported characters");
  const appConfig = loadGitHubAppConfig(env);
  if (!appConfig) throw new Error("Agent release distribution requires the Rundea GitHub App configuration");
  return { repositoryFullName, tag, appConfig };
}

export function agentAssetName(architecture: AgentArchitecture): string {
  return `rundea-agent-linux-${architecture}`;
}

export function parseSha256Manifest(input: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?([A-Za-z0-9._-]+)$/.exec(line);
    if (!match) throw new Error("Agent SHA256SUMS contains an invalid line");
    const digest = match[1]!.toLowerCase();
    const filename = match[2]!;
    if (result.has(filename)) throw new Error(`Agent SHA256SUMS contains duplicate entry ${filename}`);
    result.set(filename, digest);
  }
  if (result.size === 0) throw new Error("Agent SHA256SUMS is empty");
  return result;
}

function validateReleaseRedirect(location: string | null): URL {
  if (!location) throw new Error("GitHub release asset response did not include a redirect");
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new Error("GitHub release asset redirect is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  const allowedHost = hostname === "objects.githubusercontent.com" || hostname === "release-assets.githubusercontent.com" || hostname.endsWith(".githubusercontent.com");
  if (url.protocol !== "https:" || !allowedHost || (url.port && url.port !== "443") || url.username || url.password || url.hash) {
    throw new Error("GitHub release asset redirect host is not allowed");
  }
  return url;
}

async function jsonBody(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub release API returned invalid JSON (${response.status})`);
  }
}

function validateAssetApiUrl(input: string, owner: string, repository: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("GitHub release asset API URL is invalid");
  }
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/assets/`;
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.github.com" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) {
    throw new Error("GitHub release asset API URL is not allowed");
  }
  return url;
}

export class GitHubAgentReleaseProvider implements AgentReleaseProvider {
  private readonly cache = new Map<AgentArchitecture, Promise<AgentRelease>>();

  constructor(
    readonly config: AgentReleaseConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async repositoryInstallation(owner: string, repository: string): Promise<number> {
    const response = await this.fetchImpl(`${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`, {
      method: "GET",
      redirect: "error",
      headers: githubHeaders(`Bearer ${createGitHubAppJwt(this.config.appConfig)}`),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Agent release GitHub App installation lookup returned ${response.status}`);
    }
    const body = await jsonBody(response);
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Agent release GitHub App installation response is invalid");
    return id;
  }

  private async installationToken(installationId: number, repository: string): Promise<string> {
    const response = await this.fetchImpl(`${githubApiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      redirect: "error",
      headers: { ...githubHeaders(`Bearer ${createGitHubAppJwt(this.config.appConfig)}`), "content-type": "application/json" },
      body: JSON.stringify({ repositories: [repository], permissions: { contents: "read" } }),
    });
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Agent release installation token request returned ${response.status}`);
    }
    const body = await jsonBody(response);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Agent release installation token response is invalid");
    return token;
  }

  private async releaseAssets(owner: string, repository: string, token: string): Promise<Map<string, ReleaseAsset>> {
    const response = await this.fetchImpl(`${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/releases/tags/${encodeURIComponent(this.config.tag)}`, {
      method: "GET",
      redirect: "error",
      headers: githubHeaders(`Bearer ${token}`),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Agent release lookup returned ${response.status}`);
    }
    const body = await jsonBody(response);
    if (!Array.isArray(body?.assets)) throw new Error("Agent release metadata has no assets array");
    const assets = new Map<string, ReleaseAsset>();
    for (const value of body.assets) {
      const name = typeof value?.name === "string" ? value.name : "";
      const url = typeof value?.url === "string" ? value.url : "";
      const size = Number(value?.size);
      if (!name || !url || !Number.isSafeInteger(size) || size < 0) continue;
      if (assets.has(name)) throw new Error(`Agent release contains duplicate asset ${name}`);
      validateAssetApiUrl(url, owner, repository);
      assets.set(name, { name, url, size });
    }
    return assets;
  }

  private async downloadAsset(asset: ReleaseAsset, owner: string, repository: string, token: string, maxBytes: number): Promise<Buffer> {
    if (asset.size > maxBytes) throw new Error(`Agent release asset ${asset.name} exceeds the size limit`);
    const apiUrl = validateAssetApiUrl(asset.url, owner, repository);
    const response = await this.fetchImpl(apiUrl, {
      method: "GET",
      redirect: "manual",
      headers: githubHeaders(`Bearer ${token}`, "application/octet-stream"),
    });
    if (response.status === 200) return await readResponseBodyWithLimit(response, maxBytes);
    if (![301, 302, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Agent release asset download returned ${response.status}`);
    }
    await response.body?.cancel().catch(() => undefined);
    const redirect = validateReleaseRedirect(response.headers.get("location"));
    const downloaded = await this.fetchImpl(redirect, {
      method: "GET",
      redirect: "error",
      headers: {
        "User-Agent": "Rundea-Control-Plane",
        Accept: "application/octet-stream",
      },
    });
    if (!downloaded.ok) throw new Error(`Agent release asset redirect returned ${downloaded.status}`);
    return await readResponseBodyWithLimit(downloaded, maxBytes);
  }

  private async load(architecture: AgentArchitecture): Promise<AgentRelease> {
    const { owner, repository } = repositoryIdentity(this.config.repositoryFullName);
    const installationId = await this.repositoryInstallation(owner, repository);
    const token = await this.installationToken(installationId, repository);
    const assets = await this.releaseAssets(owner, repository, token);
    const manifestAsset = assets.get("SHA256SUMS");
    const filename = agentAssetName(architecture);
    const binaryAsset = assets.get(filename);
    if (!manifestAsset || !binaryAsset) throw new Error(`Agent release ${this.config.tag} is missing required assets`);

    const manifestBuffer = await this.downloadAsset(manifestAsset, owner, repository, token, maxManifestBytes);
    const manifest = parseSha256Manifest(manifestBuffer.toString("utf8"));
    const expected = manifest.get(filename);
    if (!expected || !sha256Pattern.test(expected)) throw new Error(`Agent release manifest has no checksum for ${filename}`);

    const binary = await this.downloadAsset(binaryAsset, owner, repository, token, maxAgentBytes);
    const actual = createHash("sha256").update(binary).digest("hex");
    if (actual !== expected) throw new Error(`Agent release checksum mismatch for ${filename}`);
    return { architecture, filename, tag: this.config.tag, sha256: actual, binary };
  }

  get(architecture: AgentArchitecture): Promise<AgentRelease> {
    let cached = this.cache.get(architecture);
    if (!cached) {
      cached = this.load(architecture).catch((error) => {
        this.cache.delete(architecture);
        throw error;
      });
      this.cache.set(architecture, cached);
    }
    return cached;
  }
}

export class BundledAgentReleaseProvider implements AgentReleaseProvider {
  private readonly cache = new Map<AgentArchitecture, Promise<AgentRelease>>();

  constructor(readonly directory: string) {}

  private async load(architecture: AgentArchitecture): Promise<AgentRelease> {
    const filename = agentAssetName(architecture);
    const [binary, versionRaw] = await Promise.all([
      readFile(`${this.directory}/${filename}`),
      readFile(`${this.directory}/VERSION`, "utf8"),
    ]);
    if (binary.byteLength === 0 || binary.byteLength > maxAgentBytes) throw new Error(`Bundled Agent ${filename} has an invalid size`);
    const version = versionRaw.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Bundled Agent VERSION is invalid");
    const sha256 = createHash("sha256").update(binary).digest("hex");
    return { architecture, filename, tag: `agent-v${version}`, sha256, binary };
  }

  get(architecture: AgentArchitecture): Promise<AgentRelease> {
    let cached = this.cache.get(architecture);
    if (!cached) {
      cached = this.load(architecture).catch((error) => {
        this.cache.delete(architecture);
        throw error;
      });
      this.cache.set(architecture, cached);
    }
    return cached;
  }
}

function bundledProvider(env: NodeJS.ProcessEnv): BundledAgentReleaseProvider | null {
  if (env.RUNDEA_DISABLE_BUNDLED_AGENT_RELEASE === "1") return null;
  const directory = env.RUNDEA_AGENT_BUNDLE_DIR?.trim() || "/app/agent-release";
  if (!existsSync(`${directory}/VERSION`) || !existsSync(`${directory}/${agentAssetName("amd64")}`) || !existsSync(`${directory}/${agentAssetName("arm64")}`)) {
    return null;
  }
  return new BundledAgentReleaseProvider(directory);
}

export function createAgentReleaseProviderFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch): AgentReleaseProvider | null {
  const config = loadAgentReleaseConfig(env);
  if (config) return new GitHubAgentReleaseProvider(config, fetchImpl);
  return bundledProvider(env);
}
