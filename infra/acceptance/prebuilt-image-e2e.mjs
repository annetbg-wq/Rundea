import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const sourceSha = (process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207").toLowerCase();
const hostPort = Number(process.env.RUNDEA_PREBUILT_HOST_PORT ?? "18085");
const registryPort = Number(process.env.RUNDEA_PREBUILT_REGISTRY_PORT ?? "15000");

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("RUNDEA_ACCEPTANCE_FIXTURE_SHA must be a full Git SHA");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("invalid prebuilt host port");
if (!Number.isInteger(registryPort) || registryPort < 1024 || registryPort > 65535) throw new Error("invalid registry port");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const serviceName = `prebuilt-${suffix}`;
const registryName = `rundea-prebuilt-registry-${suffix}`;
const repository = `localhost:${registryPort}/rundea-prebuilt`;
const sourceRepository = "https://github.com/annetbg-wq/Rundea.git";
const workDir = await mkdtemp(join(tmpdir(), "rundea-prebuilt-"));
const wrapperDir = await mkdtemp(join(tmpdir(), "rundea-docker-wrapper-"));
const dockerLog = join(wrapperDir, "docker.log");
let agent;
let nodeId = "";
let readyDeploymentId = "";
let failedDeploymentId = "";
let immutableImageRef = "";

class FatalPollError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function poll(label, fn, timeoutMs = 180_000, intervalMs = 750) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value?.done) return value.value;
      last = value?.last ?? last;
    } catch (error) {
      if (error instanceof FatalPollError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${last ? `; last=${typeof last === "string" ? last : JSON.stringify(last)}` : ""}`);
}

async function deployments() {
  return await request("/v0/deployments", { headers });
}

async function deployment(id) {
  return (await deployments()).find((row) => row.id === id);
}

async function deploymentEvents(id) {
  return await request(`/v0/deployments/${id}/events`, { headers });
}

async function createPrebuiltDeployment(imageRef) {
  const body = await request("/v0/deployments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      serviceName,
      nodeId,
      sourceRepository,
      sourceRef: sourceSha,
      sourceDelivery: "DIRECT",
      artifactImageRef: imageRef,
      artifactSourceCommitSha: sourceSha,
      containerPort: 80,
      hostPort,
      healthcheckPath: "/",
    }),
  });
  if (!body.artifactDelivery) throw new Error(`Control Plane did not acknowledge artifact delivery: ${JSON.stringify(body)}`);
  return body.id;
}

async function waitStatus(id, expected, label, timeoutMs = 180_000) {
  return await poll(label, async () => {
    const row = await deployment(id);
    if (!row) return { last: "missing" };
    if (row.status === expected) return { done: true, value: row };
    if (expected === "READY" && ["FAILED", "CANCELLED", "ROLLED_BACK"].includes(row.status)) {
      throw new FatalPollError(`${label} reached ${row.status}: ${JSON.stringify(await deploymentEvents(id))}`);
    }
    if (expected === "FAILED" && row.status === "READY") {
      throw new FatalPollError(`${label} unexpectedly reached READY`);
    }
    return { last: row.status };
  }, timeoutMs, 750);
}

async function assertStableRoute(expectedDeploymentId) {
  const response = await fetch(`http://127.0.0.1:${hostPort}/`);
  const body = await response.text();
  const marker = response.headers.get("x-rundea-deployment");
  if (!response.ok || !body.toLowerCase().includes("welcome to nginx") || marker !== expectedDeploymentId) {
    throw new Error(`stable route mismatch status=${response.status} marker=${marker} body=${body.slice(0, 200)}`);
  }
}

try {
  runDocker(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]);
  await poll("local registry", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${registryPort}/v2/`);
      return response.ok ? { done: true, value: true } : { last: response.status };
    } catch (error) {
      return { last: error instanceof Error ? error.message : String(error) };
    }
  }, 30_000, 500);

  runDocker(["pull", "nginx:alpine"]);
  runDocker(["tag", "nginx:alpine", `${repository}:acceptance`]);
  runDocker(["push", `${repository}:acceptance`]);

  const repoDigests = JSON.parse(runDocker(["image", "inspect", "--format", "{{json .RepoDigests}}", `${repository}:acceptance`]));
  immutableImageRef = repoDigests.find((value) => String(value).startsWith(`${repository}@sha256:`)) ?? "";
  if (!immutableImageRef.startsWith(`${repository}@sha256:`) || !/@sha256:[0-9a-f]{64}$/.test(immutableImageRef)) {
    throw new Error(`local registry did not produce immutable digest: ${JSON.stringify(repoDigests)}`);
  }

  const realDocker = spawnSync("/bin/bash", ["-lc", "command -v docker"], { encoding: "utf8" }).stdout.trim();
  if (!realDocker) throw new Error("real docker binary was not found");
  const wrapper = `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$RUNDEA_ACCEPTANCE_DOCKER_LOG"
printf '\\n' >> "$RUNDEA_ACCEPTANCE_DOCKER_LOG"
if [[ "\${1:-}" == "build" ]]; then
  echo "docker build is forbidden in prebuilt-image acceptance" >&2
  exit 97
fi
exec "$RUNDEA_ACCEPTANCE_REAL_DOCKER" "$@"
`;
  await writeFile(join(wrapperDir, "docker"), wrapper, "utf8");
  await chmod(join(wrapperDir, "docker"), 0o755);
  await writeFile(dockerLog, "", "utf8");

  const node = await request("/v0/nodes", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `prebuilt-${suffix}` }),
  });
  nodeId = node.id;
  const nodeToken = await activateNodeCredential(api, node.id, node.token);

  agent = spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PATH: `${wrapperDir}:${process.env.PATH}`,
      RUNDEA_ACCEPTANCE_REAL_DOCKER: realDocker,
      RUNDEA_ACCEPTANCE_DOCKER_LOG: dockerLog,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: node.id,
      RUNDEA_NODE_TOKEN: nodeToken,
      RUNDEA_WORK_DIR: workDir,
      RUNDEA_METRICS_INTERVAL: "2s",
    },
  });

  await poll("prebuilt Agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited with code ${agent.exitCode}`);
    const nodes = await request("/v0/nodes", { headers });
    const row = nodes.find((item) => item.id === node.id);
    if (row?.status !== "ONLINE") return { last: row?.status ?? "missing" };
    const capabilities = row.agent_capabilities ?? row.agentCapabilities;
    if (!Array.isArray(capabilities)) return { last: "capabilities missing" };
    if (!capabilities.includes("prebuiltImages")) throw new FatalPollError("Agent did not advertise prebuiltImages");
    return { done: true, value: row };
  }, 45_000, 500);

  readyDeploymentId = await createPrebuiltDeployment(immutableImageRef);
  const ready = await waitStatus(readyDeploymentId, "READY", "prebuilt deployment", 180_000);
  if (ready.artifact_image_ref !== immutableImageRef || ready.artifact_source_commit_sha !== sourceSha) {
    throw new Error(`immutable provenance was not persisted: ${JSON.stringify(ready)}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(ready.image_id ?? "")) {
    throw new Error(`prebuilt deployment did not persist Docker image identity: ${ready.image_id}`);
  }
  await assertStableRoute(readyDeploymentId);

  const readyEvents = await deploymentEvents(readyDeploymentId);
  if (!readyEvents.some((event) => typeof event.message === "string" && event.message.includes("using immutable prebuilt artifact"))) {
    throw new Error(`prebuilt artifact event is missing: ${JSON.stringify(readyEvents.slice(-20))}`);
  }

  const dockerCommands = await readFile(dockerLog, "utf8");
  if (/^build(?:\s|$)/m.test(dockerCommands)) {
    throw new Error(`production Agent invoked docker build during prebuilt deployment:\n${dockerCommands}`);
  }
  if (!/^pull(?:\s|$)/m.test(dockerCommands)) {
    throw new Error(`production Agent did not pull immutable artifact:\n${dockerCommands}`);
  }

  const badRef = `${repository}@sha256:${"b".repeat(64)}`;
  failedDeploymentId = await createPrebuiltDeployment(badRef);
  await waitStatus(failedDeploymentId, "FAILED", "missing digest deployment", 120_000);
  await assertStableRoute(readyDeploymentId);

  const failedEvents = await deploymentEvents(failedDeploymentId);
  if (!failedEvents.some((event) => event.status === "FAILED")) {
    throw new Error(`missing digest did not record FAILED event: ${JSON.stringify(failedEvents)}`);
  }

  const finalDockerCommands = await readFile(dockerLog, "utf8");
  if (/^build(?:\s|$)/m.test(finalDockerCommands)) {
    throw new Error(`production Agent invoked docker build:\n${finalDockerCommands}`);
  }

  console.log(JSON.stringify({
    ok: true,
    nodeId,
    serviceName,
    immutableImageRef,
    readyDeploymentId,
    failedDeploymentId,
    verified: [
      "immutable-digest-persisted",
      "exact-source-provenance-persisted",
      "agent-pulls-prebuilt-image",
      "agent-never-invokes-docker-build",
      "prebuilt-candidate-reaches-ready",
      "missing-digest-fails",
      "previous-ready-route-survives-pull-failure",
    ],
  }, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  spawnSync("docker", ["rm", "-f", registryName], { stdio: "ignore" });
  for (const id of [readyDeploymentId, failedDeploymentId].filter(Boolean)) {
    const revision = `rundea-${serviceName}-rev-${id.replaceAll("-", "").toLowerCase().slice(0, 12)}`;
    spawnSync("docker", ["rm", "-f", revision], { stdio: "ignore" });
  }
  spawnSync("docker", ["rm", "-f", "rundea-runtime-router"], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true });
  await rm(wrapperDir, { recursive: true, force: true });
}
