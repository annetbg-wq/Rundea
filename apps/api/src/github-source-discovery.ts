export type DiscoveryConfidence =
  | "CONFIRMED"
  | "HIGH_CONFIDENCE"
  | "NEEDS_CONFIRMATION"
  | "MISSING"
  | "UNSUPPORTED";

export type DiscoveredValue<T> = Readonly<{
  value: T | null;
  confidence: DiscoveryConfidence;
  source: string;
  reason?: string;
}>;

export type GitHubRepositoryMetadata = Readonly<{
  fullName: string;
  htmlUrl: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
}>;

export type GitHubResolvedRevision = Readonly<{
  commitSha: string;
  treeSha: string;
}>;

export type GitHubTreeEntry = Readonly<{
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}>;

export interface GitHubRepositoryReader {
  repository(fullName: string): Promise<GitHubRepositoryMetadata>;
  resolveRevision(fullName: string, ref: string): Promise<GitHubResolvedRevision>;
  tree(fullName: string, treeSha: string): Promise<readonly GitHubTreeEntry[]>;
  readTextBlob(fullName: string, blobSha: string, maxBytes: number): Promise<string | null>;
}

export type RuntimeCandidate = Readonly<{
  runtime: "docker" | "node" | "go" | "java-maven" | "java-gradle" | "python";
  confidence: "CONFIRMED" | "HIGH_CONFIDENCE";
  source: string;
}>;

export type GitHubSourceDiscoveryProfile = Readonly<{
  repository: GitHubRepositoryMetadata;
  selectedRef: string;
  commitSha: string;
  dockerfiles: readonly string[];
  runtimeCandidates: readonly RuntimeCandidate[];
  buildCommand: DiscoveredValue<string>;
  startCommand: DiscoveredValue<string>;
  portCandidates: readonly number[];
  healthcheckPathCandidates: readonly string[];
  monorepo: DiscoveredValue<boolean>;
  serviceCandidates: readonly string[];
  environmentVariableNames: readonly string[];
  evidenceFiles: readonly string[];
}>;

const maxTreeEntries = 5000;
const maxRelevantBlobBytes = 64 * 1024;
const maxServiceCandidates = 50;
const maxEnvironmentNames = 200;
const maxPortCandidates = 20;
const maxHealthCandidates = 20;
const commandMaxLength = 500;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const manifestBasenames = new Set([
  "package.json",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
]);
const envTemplateBasenames = new Set([".env.example", ".env.sample", ".env.template"]);

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirname(path: string): string {
  const parts = path.split("/");
  return parts.length <= 1 ? "." : parts.slice(0, -1).join("/");
}

function boundedCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (!command || command.length > commandMaxLength || /[\r\n\u0000]/.test(command)) return null;
  return command;
}

function missing(source: string, reason: string): DiscoveredValue<string> {
  return { value: null, confidence: "MISSING", source, reason };
}

function runtimeCandidates(entries: readonly GitHubTreeEntry[]): RuntimeCandidate[] {
  const seen = new Set<string>();
  const candidates: RuntimeCandidate[] = [];
  const add = (runtime: RuntimeCandidate["runtime"], confidence: RuntimeCandidate["confidence"], source: string) => {
    if (seen.has(runtime)) return;
    seen.add(runtime);
    candidates.push({ runtime, confidence, source });
  };

  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const name = basename(entry.path);
    if (/^Dockerfile(?:\..+)?$/i.test(name)) add("docker", "CONFIRMED", entry.path);
    else if (name === "package.json") add("node", "HIGH_CONFIDENCE", entry.path);
    else if (name === "go.mod") add("go", "HIGH_CONFIDENCE", entry.path);
    else if (name === "pom.xml") add("java-maven", "HIGH_CONFIDENCE", entry.path);
    else if (name === "build.gradle" || name === "build.gradle.kts") add("java-gradle", "HIGH_CONFIDENCE", entry.path);
    else if (name === "requirements.txt" || name === "pyproject.toml") add("python", "HIGH_CONFIDENCE", entry.path);
  }
  return candidates;
}

function discoverServiceCandidates(entries: readonly GitHubTreeEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const name = basename(entry.path);
    if (manifestBasenames.has(name) || /^Dockerfile(?:\..+)?$/i.test(name)) dirs.add(dirname(entry.path));
  }
  return [...dirs].sort().slice(0, maxServiceCandidates);
}

function parseEnvNames(text: string): string[] {
  const names = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const name = match?.[1];
    if (name && envNamePattern.test(name)) names.add(name);
    if (names.size >= maxEnvironmentNames) break;
  }
  return [...names].sort();
}

function parseDockerfile(text: string): { ports: number[]; healthPaths: string[] } {
  const ports = new Set<number>();
  const healthPaths = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const expose = line.match(/^EXPOSE\s+(.+)$/i);
    if (expose) {
      for (const token of expose[1]!.split(/\s+/)) {
        const port = Number(token.split("/")[0]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
      }
    }
    if (/^HEALTHCHECK\b/i.test(line)) {
      for (const match of line.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)/gi)) {
        const path = match[1];
        if (path && path.length <= 256) healthPaths.add(path);
      }
    }
  }
  return {
    ports: [...ports].slice(0, maxPortCandidates),
    healthPaths: [...healthPaths].slice(0, maxHealthCandidates),
  };
}

function parsePackageJson(text: string): {
  buildCommand: string | null;
  startCommand: string | null;
  hasWorkspaces: boolean;
} {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const scripts = value.scripts && typeof value.scripts === "object" && !Array.isArray(value.scripts)
      ? value.scripts as Record<string, unknown>
      : {};
    return {
      buildCommand: boundedCommand(scripts.build),
      startCommand: boundedCommand(scripts.start),
      hasWorkspaces: Array.isArray(value.workspaces) || Boolean(value.workspaces && typeof value.workspaces === "object"),
    };
  } catch {
    return { buildCommand: null, startCommand: null, hasWorkspaces: false };
  }
}

export async function discoverGitHubSource(
  reader: GitHubRepositoryReader,
  fullName: string,
  requestedRef?: string,
): Promise<GitHubSourceDiscoveryProfile> {
  const repository = await reader.repository(fullName);
  const selectedRef = requestedRef?.trim() || repository.defaultBranch;
  if (!selectedRef || selectedRef.length > 256 || /[\r\n\u0000]/.test(selectedRef)) {
    throw new Error("GitHub source ref is invalid");
  }
  const revision = await reader.resolveRevision(repository.fullName, selectedRef);
  const entries = await reader.tree(repository.fullName, revision.treeSha);
  if (entries.length > maxTreeEntries) throw new Error("GitHub repository tree exceeds discovery limit");

  const blobs = entries.filter((entry) => entry.type === "blob");
  const dockerfiles = blobs
    .filter((entry) => /^Dockerfile(?:\..+)?$/i.test(basename(entry.path)))
    .map((entry) => entry.path)
    .sort();
  const services = discoverServiceCandidates(entries);
  const evidenceFiles = new Set<string>();
  const ports = new Set<number>();
  const healthPaths = new Set<string>();
  const envNames = new Set<string>();

  let buildCommand: DiscoveredValue<string> = missing("package.json", "no explicit build script discovered");
  let startCommand: DiscoveredValue<string> = missing("package.json", "no explicit start script discovered");
  let packageWorkspaces = false;

  const relevant = blobs.filter((entry) => {
    const name = basename(entry.path);
    return name === "package.json" || /^Dockerfile(?:\..+)?$/i.test(name) || envTemplateBasenames.has(name);
  });

  for (const entry of relevant) {
    if ((entry.size ?? 0) > maxRelevantBlobBytes) continue;
    const text = await reader.readTextBlob(repository.fullName, entry.sha, maxRelevantBlobBytes);
    if (text === null) continue;
    evidenceFiles.add(entry.path);
    const name = basename(entry.path);

    if (name === "package.json") {
      const parsed = parsePackageJson(text);
      packageWorkspaces ||= parsed.hasWorkspaces;
      if (dirname(entry.path) === ".") {
        if (parsed.buildCommand) {
          buildCommand = { value: `npm run build`, confidence: "HIGH_CONFIDENCE", source: entry.path, reason: "package.json defines scripts.build" };
        }
        if (parsed.startCommand) {
          startCommand = { value: `npm start`, confidence: "HIGH_CONFIDENCE", source: entry.path, reason: "package.json defines scripts.start" };
        }
      }
    } else if (/^Dockerfile(?:\..+)?$/i.test(name)) {
      const parsed = parseDockerfile(text);
      for (const port of parsed.ports) if (ports.size < maxPortCandidates) ports.add(port);
      for (const path of parsed.healthPaths) if (healthPaths.size < maxHealthCandidates) healthPaths.add(path);
    } else if (envTemplateBasenames.has(name)) {
      for (const variable of parseEnvNames(text)) if (envNames.size < maxEnvironmentNames) envNames.add(variable);
    }
  }

  const monorepoValue = packageWorkspaces || services.filter((candidate) => candidate !== ".").length > 1;
  const monorepo: DiscoveredValue<boolean> = {
    value: monorepoValue,
    confidence: packageWorkspaces ? "CONFIRMED" : "HIGH_CONFIDENCE",
    source: packageWorkspaces ? "package.json workspaces" : "repository tree",
    reason: packageWorkspaces ? "workspace configuration is present" : "inferred from multiple service roots",
  };

  return {
    repository,
    selectedRef,
    commitSha: revision.commitSha,
    dockerfiles,
    runtimeCandidates: runtimeCandidates(entries),
    buildCommand,
    startCommand,
    portCandidates: [...ports],
    healthcheckPathCandidates: [...healthPaths],
    monorepo,
    serviceCandidates: services,
    environmentVariableNames: [...envNames].sort(),
    evidenceFiles: [...evidenceFiles].sort(),
  };
}
