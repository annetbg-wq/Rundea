import { createGitHubAppJwt, GitHubArchiveProvider, loadGitHubAppConfig, type GitHubAppConfig } from "./github-app-source";
import { inferGitHubProjectDiscovery, type GitHubProjectDiscovery } from "./github-project-discovery";

const githubApiBase = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const maxInstallations = 20;
const maxRepositoryPagesPerInstallation = 5;
const maxTreeEntries = 5000;
const maxDiscoveryFiles = 96;
const maxDiscoveryFileBytes = 256 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type TreeEntry = { path?: unknown; type?: unknown; size?: unknown };

export type GitHubRepositoryChoice = Readonly<{
  installationId: number;
  repositoryId: number;
  fullName: string;
  url: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  defaultBranch: string;
}>;

export type DiscoveredServiceCandidate = Readonly<{
  name: string;
  path: string;
  dockerfile: string | null;
  manifest: string | null;
  containerPorts: readonly number[];
  buildArgumentNames: readonly string[];
  environmentVariableNames: readonly string[];
  healthcheckPath: string | null;
  confidence: "CONFIRMED" | "HIGH_CONFIDENCE" | "NEEDS_CONFIRMATION";
  evidence: readonly string[];
}>;

export type EnrichedGitHubProjectDiscovery = Omit<GitHubProjectDiscovery, "discovery"> & {
  discovery: GitHubProjectDiscovery["discovery"] & Readonly<{
    services: readonly DiscoveredServiceCandidate[];
  }>;
};

function headers(authorization?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Rundea-Control-Plane",
    "X-GitHub-Api-Version": githubApiVersion,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

async function json(response: Response, label: string): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label} returned ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} is invalid`);
  return id;
}

function repositoryVisibility(body: any): "PUBLIC" | "PRIVATE" | "INTERNAL" {
  if (body?.visibility === "public") return "PUBLIC";
  if (body?.visibility === "private") return "PRIVATE";
  if (body?.visibility === "internal") return "INTERNAL";
  if (body?.private === true) return "PRIVATE";
  if (body?.private === false) return "PUBLIC";
  throw new Error("GitHub repository visibility is invalid");
}

function safeRepositoryUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub repository URL is invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub repository URL is invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function safeBranch(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub default branch is invalid");
  const branch = value.trim();
  if (!branch || branch.length > 255 || /[\r\n\u0000]/.test(branch)) throw new Error("GitHub default branch is invalid");
  return branch;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function normalizeTreePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 600 || /[\r\n\u0000]/.test(value)) return null;
  if (value.startsWith("/") || value.split("/").includes("..")) return null;
  return value;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function numericUnique(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function dockerPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  const result: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const expose = line.trim().match(/^EXPOSE\s+(.+)$/i)?.[1];
    if (!expose) continue;
    for (const token of expose.split(/\s+/)) {
      const port = Number(token.split("/")[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) result.push(port);
    }
  }
  return numericUnique(result);
}

function dockerNames(raw: string | undefined, instruction: "ARG" | "ENV"): string[] {
  if (!raw) return [];
  const values: string[] = [];
  const regex = instruction === "ARG" ? /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)\b/i : /^ENV\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(regex)?.[1];
    if (match) values.push(match);
  }
  return uniqueSorted(values);
}

function envExampleNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const values: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let value = line.trim();
    if (!value || value.startsWith("#")) continue;
    if (value.startsWith("export ")) value = value.slice(7).trim();
    const equals = value.indexOf("=");
    if (equals <= 0) continue;
    const name = value.slice(0, equals).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) values.push(name);
  }
  return uniqueSorted(values);
}

function dockerHealthcheck(raw: string | undefined): string | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*HEALTHCHECK\b/i.test(line));
  if (index === -1) return null;
  const statement = lines.slice(index, Math.min(lines.length, index + 4)).join(" ");
  const url = statement.match(/https?:\/\/[^\s"']+(\/[^\s"']*)/i)?.[1];
  if (url?.startsWith("/")) return url.replace(/[)\],;]+$/, "");
  const localPath = statement.match(/(?:curl|wget)[^\n]*?\s(\/[A-Za-z0-9_./?=&%-]+)/i)?.[1];
  return localPath?.startsWith("/") ? localPath.replace(/[)\],;]+$/, "") : null;
}

function workspacePatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as any;
    const value = parsed?.workspaces;
    const patterns = Array.isArray(value) ? value : Array.isArray(value?.packages) ? value.packages : [];
    return uniqueSorted(patterns.filter((item: unknown): item is string => typeof item === "string" && item.length <= 256));
  } catch {
    return [];
  }
}

function patternMatchesDirectory(pattern: string, directory: string): boolean {
  if (pattern === directory) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+?");
  return new RegExp(`^${escaped}$`).test(directory);
}

function relevantDiscoveryPath(path: string): boolean {
  const name = basename(path);
  if (name === "package.json" || name === ".env.example" || name === ".env.sample" || name === "example.env") return true;
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return true;
  return false;
}

export class GitHubProjectConnector {
  private readonly config: GitHubAppConfig;
  private readonly archiveProvider: GitHubArchiveProvider;

  constructor(
    config: GitHubAppConfig | null = loadGitHubAppConfig(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (!config) throw new Error("Rundea GitHub App is not configured");
    this.config = config;
    this.archiveProvider = new GitHubArchiveProvider(config, fetchImpl);
  }

  private appJwt(): string {
    return createGitHubAppJwt(this.config);
  }

  private async installationToken(installationId: number): Promise<string> {
    const response = await this.fetchImpl(`${githubApiBase}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      redirect: "error",
      headers: { ...headers(`Bearer ${this.appJwt()}`), "content-type": "application/json" },
      body: JSON.stringify({ permissions: { contents: "read" } }),
    });
    const body = await json(response, "GitHub installation token request");
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("GitHub installation token is invalid");
    return token;
  }

  async listRepositories(): Promise<GitHubRepositoryChoice[]> {
    const installationResponse = await this.fetchImpl(`${githubApiBase}/app/installations?per_page=100`, {
      method: "GET",
      redirect: "error",
      headers: headers(`Bearer ${this.appJwt()}`),
    });
    const installations = await json(installationResponse, "GitHub App installations");
    if (!Array.isArray(installations)) throw new Error("GitHub App installations response is invalid");
    if (installations.length > maxInstallations) throw new Error(`GitHub App has more than ${maxInstallations} installations; narrow the installation scope`);

    const repositories = new Map<number, GitHubRepositoryChoice>();
    for (const installation of installations) {
      const installationId = positiveId(installation?.id, "GitHub installation id");
      const token = await this.installationToken(installationId);
      for (let page = 1; page <= maxRepositoryPagesPerInstallation; page += 1) {
        const response = await this.fetchImpl(`${githubApiBase}/installation/repositories?per_page=100&page=${page}`, {
          method: "GET",
          redirect: "error",
          headers: headers(`Bearer ${token}`),
        });
        const body = await json(response, "GitHub installation repositories");
        if (!Array.isArray(body?.repositories)) throw new Error("GitHub installation repositories response is invalid");
        for (const repository of body.repositories) {
          const repositoryId = positiveId(repository?.id, "GitHub repository id");
          const fullName = typeof repository?.full_name === "string" ? repository.full_name.trim() : "";
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error("GitHub repository full name is invalid");
          repositories.set(repositoryId, {
            installationId,
            repositoryId,
            fullName,
            url: safeRepositoryUrl(repository?.html_url),
            visibility: repositoryVisibility(repository),
            defaultBranch: safeBranch(repository?.default_branch),
          });
        }
        if (body.repositories.length < 100) break;
      }
    }
    return [...repositories.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  private async recursiveFiles(repositoryFullName: string, revisionSha: string, installationId: number): Promise<Record<string, string>> {
    const [owner, repository] = repositoryFullName.split("/");
    if (!owner || !repository) throw new Error("GitHub repository identity is invalid");
    const token = await this.installationToken(installationId);
    const treeResponse = await this.fetchImpl(
      `${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${revisionSha}?recursive=1`,
      { method: "GET", redirect: "error", headers: headers(`Bearer ${token}`) },
    );
    const tree = await json(treeResponse, "GitHub recursive tree");
    if (!Array.isArray(tree?.tree) || tree?.truncated === true) throw new Error("GitHub recursive tree is unavailable or truncated");
    if (tree.tree.length > maxTreeEntries) throw new Error(`repository tree exceeds discovery limit of ${maxTreeEntries} entries`);

    const paths = (tree.tree as TreeEntry[])
      .flatMap((entry) => {
        const path = normalizeTreePath(entry.path);
        if (!path || entry.type !== "blob" || !relevantDiscoveryPath(path)) return [];
        const size = Number(entry.size ?? 0);
        if (!Number.isFinite(size) || size < 0 || size > maxDiscoveryFileBytes) return [];
        return [path];
      })
      .sort((left, right) => left.localeCompare(right));
    if (paths.length > maxDiscoveryFiles) throw new Error(`repository has more than ${maxDiscoveryFiles} discovery files`);

    const files: Record<string, string> = {};
    for (const path of paths) {
      const response = await this.fetchImpl(
        `${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodePath(path)}?ref=${revisionSha}`,
        { method: "GET", redirect: "error", headers: headers(`Bearer ${token}`) },
      );
      const body = await json(response, `GitHub discovery file ${path}`);
      if (body?.type !== "file" || body?.encoding !== "base64" || typeof body?.content !== "string") continue;
      const decoded = Buffer.from(body.content.replace(/\n/g, ""), "base64");
      if (decoded.length > maxDiscoveryFileBytes) continue;
      files[path] = decoded.toString("utf8");
    }
    return files;
  }

  async inspect(repositoryFullName: string, selectedBranch?: string): Promise<EnrichedGitHubProjectDiscovery> {
    const inspection = await this.archiveProvider.inspectRepository(repositoryFullName, selectedBranch);
    const base = inferGitHubProjectDiscovery(inspection);
    const nestedFiles = await this.recursiveFiles(inspection.repositoryFullName, inspection.revisionSha, inspection.installationId);
    const allFiles = { ...inspection.files, ...nestedFiles };
    const rootWorkspaces = workspacePatterns(allFiles["package.json"]);
    const packageDirectories = Object.keys(allFiles)
      .filter((path) => basename(path) === "package.json")
      .map(dirname);
    const dockerDirectories = Object.keys(allFiles)
      .filter((path) => basename(path) === "Dockerfile" || basename(path).startsWith("Dockerfile."))
      .map(dirname);

    const candidateDirectories = new Set<string>(dockerDirectories);
    for (const directory of packageDirectories) {
      if (directory === ".") continue;
      if (rootWorkspaces.some((pattern) => patternMatchesDirectory(pattern, directory))) candidateDirectories.add(directory);
    }
    if (candidateDirectories.size === 0) candidateDirectories.add(".");

    const services: DiscoveredServiceCandidate[] = [...candidateDirectories]
      .sort((left, right) => left.localeCompare(right))
      .map((directory) => {
        const prefix = directory === "." ? "" : `${directory}/`;
        const dockerfile = Object.keys(allFiles).find((path) => dirname(path) === directory && (basename(path) === "Dockerfile" || basename(path).startsWith("Dockerfile."))) ?? null;
        const manifest = allFiles[`${prefix}package.json`] !== undefined ? `${prefix}package.json` : null;
        const docker = dockerfile ? allFiles[dockerfile] : undefined;
        const envExample = [".env.example", ".env.sample", "example.env"]
          .map((name) => `${prefix}${name}`)
          .find((path) => allFiles[path] !== undefined);
        const ports = dockerPorts(docker);
        const buildArgs = dockerNames(docker, "ARG");
        const environmentNames = uniqueSorted([
          ...dockerNames(docker, "ENV"),
          ...envExampleNames(envExample ? allFiles[envExample] : undefined),
        ]);
        const healthcheckPath = dockerHealthcheck(docker);
        const evidence = [dockerfile, manifest, envExample].filter((value): value is string => Boolean(value));
        const confidence = dockerfile && ports.length === 1 ? "CONFIRMED" : dockerfile || manifest ? "HIGH_CONFIDENCE" : "NEEDS_CONFIRMATION";
        return Object.freeze({
          name: directory === "." ? repositoryFullName.split("/")[1]! : basename(directory),
          path: directory,
          dockerfile,
          manifest,
          containerPorts: Object.freeze(ports),
          buildArgumentNames: Object.freeze(buildArgs),
          environmentVariableNames: Object.freeze(environmentNames),
          healthcheckPath,
          confidence,
          evidence: Object.freeze(evidence),
        });
      });

    const servicePaths = services.map((service) => service.path);
    const allPorts = numericUnique(services.flatMap((service) => [...service.containerPorts]));
    const allEnvironmentNames = uniqueSorted(services.flatMap((service) => [...service.environmentVariableNames, ...service.buildArgumentNames]));
    const needsConfirmation = services.some((service) => service.confidence !== "CONFIRMED" || service.containerPorts.length !== 1);

    return Object.freeze({
      ...base,
      reviewState: needsConfirmation ? "NEEDS_CONFIRMATION" : base.reviewState,
      discovery: Object.freeze({
        ...base.discovery,
        monorepo: {
          value: services.length > 1 || base.discovery.monorepo.value,
          confidence: services.length > 1 ? "CONFIRMED" : base.discovery.monorepo.confidence,
          evidence: services.length > 1 ? Object.freeze(servicePaths) : base.discovery.monorepo.evidence,
        },
        serviceCandidates: {
          value: Object.freeze(servicePaths),
          confidence: services.length > 0 ? "CONFIRMED" : "MISSING",
          evidence: Object.freeze(services.flatMap((service) => [...service.evidence])),
        },
        containerPorts: {
          value: Object.freeze(allPorts),
          confidence: allPorts.length > 0 ? (services.every((service) => service.containerPorts.length === 1) ? "HIGH_CONFIDENCE" : "NEEDS_CONFIRMATION") : "MISSING",
          evidence: Object.freeze(services.flatMap((service) => service.dockerfile ? [`${service.dockerfile}#EXPOSE`] : [])),
        },
        environmentVariableNames: {
          value: Object.freeze(allEnvironmentNames),
          confidence: allEnvironmentNames.length > 0 ? "CONFIRMED" : "MISSING",
          evidence: Object.freeze(services.flatMap((service) => [...service.evidence])),
        },
        services: Object.freeze(services),
      }),
    });
  }
}
