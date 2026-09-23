import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBuilderConfig } from "./config";

type Job = {
  id: string;
  service_id: string;
  source_commit_sha: string;
  source_path: string;
  dockerfile: string | null;
  build_args: Record<string, string>;
  registry_repository: string;
};

const config = resolveBuilderConfig();
const headers = {
  authorization: `Bearer ${config.token}`,
  "x-rundea-builder-id": config.workerId,
};
let stopping = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const mergedHeaders = new Headers(init.headers);
  mergedHeaders.set("authorization", headers.authorization);
  mergedHeaders.set("x-rundea-builder-id", headers["x-rundea-builder-id"]);
  return fetch(`${config.controlPlaneUrl}${path}`, { ...init, headers: mergedHeaders });
}

async function json(path: string, init: RequestInit = {}) {
  const response = await request(path, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

function docker(args: string[], options: Record<string, unknown> = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout ?? "").trim();
}

function registryHost(repository: string): string {
  return repository.split("/")[0]!;
}

async function ensureRegistryLogin(repository: string) {
  if (!config.registryUsername || config.registryPassword === null) return;
  const proc = spawnSync(
    "docker",
    ["login", registryHost(repository), "--username", config.registryUsername, "--password-stdin"],
    { input: config.registryPassword, encoding: "utf8" },
  );
  if (proc.status !== 0) throw new Error(`registry login failed: ${proc.stderr || proc.stdout}`);
}

async function downloadSource(job: Job, target: string) {
  const response = await request(`/v0/build-worker/jobs/${job.id}/source`);
  if (!response.ok) throw new Error(`source download failed: ${response.status} ${await response.text()}`);
  const expectedSha = response.headers.get("x-rundea-source-sha");
  if (expectedSha !== job.source_commit_sha) throw new Error("source archive commit identity mismatch");
  const archive = join(target, "source.tar.gz");
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const extractDir = join(target, "source");
  await chmod(target, 0o700);
  const mkdirResult = spawnSync("mkdir", ["-p", extractDir], { encoding: "utf8" });
  if (mkdirResult.status !== 0) throw new Error(`source directory creation failed: ${mkdirResult.stderr}`);
  const tarResult = spawnSync("tar", ["-xzf", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", extractDir], { encoding: "utf8" });
  if (tarResult.status !== 0) throw new Error(`source extraction failed: ${tarResult.stderr || tarResult.stdout}`);
  return extractDir;
}

function validateSourcePath(value: string): string {
  const normalized = value.trim().replace(/^\.\//, "").replace(/\/$/, "") || ".";
  if (normalized.startsWith("/") || normalized.split("/").includes("..") || /[\r\n\0]/.test(normalized)) {
    throw new Error("source path escapes repository root");
  }
  return normalized;
}

function sortedBuildArgs(args: Record<string, string>): string[] {
  return Object.keys(args ?? {}).sort().flatMap((key) => ["--build-arg", `${key}=${args[key]}`]);
}

async function runBuild(job: Job, sourceDir: string) {
  const contextDir = join(sourceDir, validateSourcePath(job.source_path));
  const tag = `${job.registry_repository}:build-${job.id.replaceAll("-", "")}`;
  const dockerfile = job.dockerfile ?? "Dockerfile";
  const buildArgs = [
    "build",
    "--memory", String(config.memoryBytes),
    "--cpu-period", String(config.cpuPeriod),
    "--cpu-quota", String(config.cpuQuota),
    "--file", dockerfile,
    "--tag", tag,
    ...sortedBuildArgs(job.build_args),
    ".",
  ];

  const child = spawn("docker", buildArgs, { cwd: contextDir, stdio: ["ignore", "inherit", "inherit"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), config.timeoutMs);
  const heartbeat = setInterval(() => {
    void request(`/v0/build-worker/jobs/${job.id}/heartbeat`, { method: "POST" }).catch(() => undefined);
  }, 30000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error(code === null ? "docker build timed out" : `docker build exited with code ${code}`);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }

  await ensureRegistryLogin(job.registry_repository);
  docker(["push", tag]);
  const repoDigests = JSON.parse(docker(["image", "inspect", "--format", "{{json .RepoDigests}}", tag])) as string[];
  const artifactImageRef = repoDigests.find((value) => value.startsWith(`${job.registry_repository}@sha256:`));
  if (!artifactImageRef || !/@sha256:[0-9a-f]{64}$/.test(artifactImageRef)) {
    throw new Error("registry push did not return immutable digest");
  }
  const imageId = artifactImageRef.slice(artifactImageRef.lastIndexOf("@") + 1);
  return { artifactImageRef, imageId, tag };
}

async function processJob(job: Job) {
  const dir = await mkdtemp(join(tmpdir(), "rundea-build-"));
  let localTag = "";
  try {
    await json(`/v0/build-worker/jobs/${job.id}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "isolated builder started" }),
    });
    const sourceDir = await downloadSource(job, dir);
    const built = await runBuild(job, sourceDir);
    localTag = built.tag;
    await json(`/v0/build-worker/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifactImageRef: built.artifactImageRef, imageId: built.imageId }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await request(`/v0/build-worker/jobs/${job.id}/fail`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: message }),
    }).catch(() => undefined);
    console.error(`build ${job.id} failed: ${message}`);
  } finally {
    if (localTag) spawnSync("docker", ["image", "rm", "-f", localTag], { stdio: "ignore" });
    await rm(dir, { recursive: true, force: true });
  }
}

async function loop() {
  while (!stopping) {
    try {
      const response = await request("/v0/build-worker/jobs/claim", { method: "POST" });
      if (response.status === 204) {
        await sleep(config.pollMs);
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`claim failed: ${response.status} ${text}`);
      const body = JSON.parse(text);
      await processJob(body.job as Job);
    } catch (error) {
      console.error(error);
      await sleep(config.pollMs);
    }
  }
}

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
await loop();
