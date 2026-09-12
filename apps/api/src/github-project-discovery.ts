import type { GitHubRepositoryInspection } from "./github-app-source";

export type DiscoveryConfidence = "CONFIRMED" | "HIGH_CONFIDENCE" | "NEEDS_CONFIRMATION" | "MISSING" | "UNSUPPORTED";

export type DiscoveryValue<T> = Readonly<{
  value: T;
  confidence: DiscoveryConfidence;
  evidence: readonly string[];
}>;

export type GitHubProjectDiscovery = Readonly<{
  provider: "GITHUB";
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  repositoryUrl: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  defaultBranch: string;
  selectedBranch: string;
  revisionSha: string;
  reviewState: "READY_FOR_REVIEW" | "NEEDS_CONFIRMATION";
  discovery: Readonly<{
    runtimes: DiscoveryValue<readonly string[]>;
    dockerfile: DiscoveryValue<string | null>;
    buildCommand: DiscoveryValue<string | null>;
    startCommand: DiscoveryValue<string | null>;
    containerPorts: DiscoveryValue<readonly number[]>;
    monorepo: DiscoveryValue<boolean>;
    serviceCandidates: DiscoveryValue<readonly string[]>;
    manifestPaths: DiscoveryValue<readonly string[]>;
    environmentVariableNames: DiscoveryValue<readonly string[]>;
  }>;
}>;

type PackageManifest = {
  scripts?: Record<string, unknown>;
  workspaces?: unknown;
};

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function numericUniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function safePackageManifest(raw: string | undefined): PackageManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as PackageManifest) : null;
  } catch {
    return null;
  }
}

function packageWorkspaces(manifest: PackageManifest | null): string[] {
  if (!manifest) return [];
  const raw = manifest.workspaces;
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { packages?: unknown }).packages)
      ? (raw as { packages: unknown[] }).packages
      : [];
  return uniqueSorted(
    values.flatMap((value) =>
      typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n\u0000]/.test(value) ? [value] : [],
    ),
  );
}

function environmentNamesFromExample(raw: string | undefined): string[] {
  if (!raw) return [];
  const names: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const name = normalized.slice(0, equals).trim();
    if (environmentNamePattern.test(name)) names.push(name);
  }
  return uniqueSorted(names);
}

function environmentNamesFromDockerfile(raw: string | undefined): string[] {
  if (!raw) return [];
  const names: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const arg = trimmed.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1];
    if (arg) names.push(arg);
    const env = trimmed.match(/^ENV\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1];
    if (env) names.push(env);
  }
  return uniqueSorted(names);
}

function dockerPorts(raw: string | undefined): number[] {
  if (!raw) return [];
  const ports: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^EXPOSE\s+(.+)$/i);
    if (!match?.[1]) continue;
    for (const token of match[1].split(/\s+/)) {
      const numeric = Number(token.split("/")[0]);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535) ports.push(numeric);
    }
  }
  return numericUniqueSorted(ports);
}

function procfileStart(raw: string | undefined): boolean {
  return Boolean(raw?.split(/\r?\n/).some((line) => /^\s*web\s*:\s*\S/.test(line)));
}

function hasPackageScript(manifest: PackageManifest | null, script: string): boolean {
  const value = manifest?.scripts?.[script];
  return typeof value === "string" && value.trim().length > 0;
}

export function inferGitHubProjectDiscovery(inspection: GitHubRepositoryInspection): GitHubProjectDiscovery {
  const files = inspection.files;
  const rootEntries = new Set(inspection.rootEntries);
  const packageManifest = safePackageManifest(files["package.json"]);

  const runtimeCandidates: string[] = [];
  if (files["package.json"]) runtimeCandidates.push("nodejs");
  if (files["go.mod"]) runtimeCandidates.push("go");
  if (files["pom.xml"] || files["build.gradle"] || files["build.gradle.kts"]) runtimeCandidates.push("jvm");
  if (files["pyproject.toml"] || files["requirements.txt"]) runtimeCandidates.push("python");
  const runtimes = uniqueSorted(runtimeCandidates);
  const runtimeConfidence: DiscoveryConfidence =
    runtimes.length === 0 ? "MISSING" : runtimes.length === 1 ? "HIGH_CONFIDENCE" : "NEEDS_CONFIRMATION";

  const manifestPaths = uniqueSorted(
    [
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
    ].filter((path) => rootEntries.has(path)),
  );

  const dockerfile = rootEntries.has("Dockerfile") ? "Dockerfile" : null;
  const dockerfileValue: DiscoveryValue<string | null> = {
    value: dockerfile,
    confidence: dockerfile ? "CONFIRMED" : "MISSING",
    evidence: dockerfile ? ["Dockerfile"] : [],
  };

  let buildCommand: DiscoveryValue<string | null>;
  if (hasPackageScript(packageManifest, "build")) {
    buildCommand = { value: "npm run build", confidence: "CONFIRMED", evidence: ["package.json#scripts.build"] };
  } else if (files["go.mod"]) {
    buildCommand = { value: "go build ./...", confidence: "NEEDS_CONFIRMATION", evidence: ["go.mod"] };
  } else if (files["pom.xml"]) {
    buildCommand = { value: "mvn package", confidence: "NEEDS_CONFIRMATION", evidence: ["pom.xml"] };
  } else if (files["build.gradle"] || files["build.gradle.kts"]) {
    buildCommand = {
      value: rootEntries.has("gradlew") ? "./gradlew build" : "gradle build",
      confidence: "NEEDS_CONFIRMATION",
      evidence: [files["build.gradle.kts"] ? "build.gradle.kts" : "build.gradle"],
    };
  } else {
    buildCommand = {
      value: null,
      confidence: dockerfile ? "UNSUPPORTED" : "MISSING",
      evidence: dockerfile ? ["Dockerfile owns the build"] : [],
    };
  }

  let startCommand: DiscoveryValue<string | null>;
  if (hasPackageScript(packageManifest, "start")) {
    startCommand = { value: "npm start", confidence: "CONFIRMED", evidence: ["package.json#scripts.start"] };
  } else if (procfileStart(files["Procfile"])) {
    startCommand = { value: "Procfile:web", confidence: "CONFIRMED", evidence: ["Procfile#web"] };
  } else {
    startCommand = {
      value: null,
      confidence: dockerfile ? "UNSUPPORTED" : "MISSING",
      evidence: dockerfile ? ["Dockerfile owns the start command"] : [],
    };
  }

  const ports = dockerPorts(files["Dockerfile"]);
  const containerPorts: DiscoveryValue<readonly number[]> = {
    value: ports,
    confidence: ports.length === 0 ? "MISSING" : ports.length === 1 ? "HIGH_CONFIDENCE" : "NEEDS_CONFIRMATION",
    evidence: ports.length > 0 ? ["Dockerfile#EXPOSE"] : [],
  };

  const workspacePatterns = packageWorkspaces(packageManifest);
  const hasMonorepoMarker = workspacePatterns.length > 0 || rootEntries.has("pnpm-workspace.yaml");
  const monorepo: DiscoveryValue<boolean> = {
    value: hasMonorepoMarker,
    confidence: hasMonorepoMarker ? "CONFIRMED" : "HIGH_CONFIDENCE",
    evidence: [
      ...(workspacePatterns.length > 0 ? ["package.json#workspaces"] : []),
      ...(rootEntries.has("pnpm-workspace.yaml") ? ["pnpm-workspace.yaml"] : []),
    ],
  };
  const serviceCandidates: DiscoveryValue<readonly string[]> = hasMonorepoMarker
    ? {
        value: workspacePatterns.length > 0 ? workspacePatterns : [],
        confidence: "NEEDS_CONFIRMATION",
        evidence: monorepo.evidence,
      }
    : { value: ["."], confidence: "HIGH_CONFIDENCE", evidence: ["single root application"] };

  const environmentExamplePaths = [".env.example", ".env.sample", "example.env"].filter((path) => Boolean(files[path]));
  const environmentVariableNames = uniqueSorted([
    ...environmentExamplePaths.flatMap((path) => environmentNamesFromExample(files[path])),
    ...environmentNamesFromDockerfile(files["Dockerfile"]),
  ]);
  const environmentVariables: DiscoveryValue<readonly string[]> = {
    value: environmentVariableNames,
    confidence: environmentVariableNames.length > 0 ? "CONFIRMED" : "MISSING",
    evidence: [
      ...environmentExamplePaths,
      ...(environmentNamesFromDockerfile(files["Dockerfile"]).length > 0 ? ["Dockerfile#ARG/ENV names"] : []),
    ],
  };
  const manifestPathsDiscovery: DiscoveryValue<readonly string[]> = {
    value: Object.freeze([...manifestPaths]),
    confidence: manifestPaths.length > 0 ? "CONFIRMED" : "MISSING",
    evidence: manifestPaths,
  };

  const needsConfirmation =
    runtimeConfidence === "NEEDS_CONFIRMATION" ||
    runtimeConfidence === "MISSING" ||
    containerPorts.confidence === "NEEDS_CONFIRMATION" ||
    containerPorts.confidence === "MISSING" ||
    serviceCandidates.confidence === "NEEDS_CONFIRMATION" ||
    (!dockerfile && startCommand.confidence !== "CONFIRMED");

  return Object.freeze({
    provider: "GITHUB",
    installationId: inspection.installationId,
    repositoryId: inspection.repositoryId,
    repositoryFullName: inspection.repositoryFullName,
    repositoryUrl: inspection.repositoryUrl,
    visibility: inspection.visibility,
    defaultBranch: inspection.defaultBranch,
    selectedBranch: inspection.selectedBranch,
    revisionSha: inspection.revisionSha,
    reviewState: needsConfirmation ? "NEEDS_CONFIRMATION" : "READY_FOR_REVIEW",
    discovery: Object.freeze({
      runtimes: {
        value: Object.freeze(runtimes),
        confidence: runtimeConfidence,
        evidence: manifestPaths.filter((path) =>
          ["package.json", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "requirements.txt", "pyproject.toml"].includes(path),
        ),
      },
      dockerfile: dockerfileValue,
      buildCommand,
      startCommand,
      containerPorts: { ...containerPorts, value: Object.freeze([...containerPorts.value]) },
      monorepo,
      serviceCandidates: { ...serviceCandidates, value: Object.freeze([...serviceCandidates.value]) },
      manifestPaths: manifestPathsDiscovery,
      environmentVariableNames: { ...environmentVariables, value: Object.freeze([...environmentVariables.value]) },
    }),
  });
}
