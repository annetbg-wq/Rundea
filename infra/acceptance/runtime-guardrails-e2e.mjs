import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const lowDiskWorkDir = process.env.RUNDEA_LOW_DISK_WORK_DIR;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
if (!token) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!lowDiskWorkDir) throw new Error("RUNDEA_LOW_DISK_WORK_DIR is required");

const headers = { authorization: `Bearer ${token}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const suffix = `${Date.now().toString(36)}-${process.pid}`;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function request(path, init = {}) {
  const response = await fetch(api + path, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

async function poll(label, fn, timeoutMs = 120000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value?.done) return value.value;
    last = value?.last ?? last;
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out; last=${typeof last === "string" ? last : JSON.stringify(last)}`);
}

async function makeFixture(label) {
  const workspace = await request("/v0/workspaces", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ slug: `${label}-${suffix}`.slice(0, 63), name: label }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ slug: `project-${suffix}`.slice(0, 63), name: label + " project" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ slug: "api", name: "api" }),
  });
  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ name: label + " node" }),
  });
  const permanentToken = await activateNodeCredential(api, node.id, node.token);
  return { workspace, project, service, node, permanentToken };
}

function startAgent(fixture, workDir) {
  return spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: fixture.node.id,
      RUNDEA_NODE_TOKEN: fixture.permanentToken,
      RUNDEA_WORK_DIR: workDir,
    },
  });
}

async function waitOnline(fixture, agent) {
  await poll("Agent ONLINE", async () => {
    if (agent.exitCode !== null) throw new Error(`Agent exited early with code ${agent.exitCode}`);
    const body = await request(`/v0/workspaces/${fixture.workspace.id}/nodes?includeArchived=true`, { headers });
    const row = body.nodes.find((item) => item.id === fixture.node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row };
  }, 45000, 250);
}

async function deploy(fixture) {
  return request(`/v0/services/${fixture.service.id}/deployments`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({
      sourceRepository: fixtureRepository,
      sourceRef: fixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      healthcheckPath: "/",
    }),
  });
}

async function waitFailed(serviceId, deploymentId) {
  return poll("deployment failure", async () => {
    const body = await request(`/v0/services/${serviceId}/deployments`, { headers });
    const row = body.deployments.find((item) => item.id === deploymentId);
    if (!row) return { last: "missing" };
    if (row.status === "FAILED") return { done: true, value: row };
    if (row.status === "READY") throw new Error("guardrail fixture unexpectedly became READY");
    return { last: row.status };
  });
}

async function events(deploymentId) {
  return request(`/v0/deployments/${deploymentId}/events`, { headers });
}

async function assertControlPlaneHealthy(label) {
  const response = await fetch(api + "/health");
  if (!response.ok) throw new Error(`${label}: Control Plane health is ${response.status}`);
}

function stopAgent(agent) {
  if (!agent || agent.exitCode !== null) return;
  agent.kill("SIGTERM");
}

function parseMemTotalBytes(text) {
  const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new Error("MemTotal not found");
  return Number(match[1]) * 1024;
}

let memoryAgent;
let diskAgent;
let memoryWorkDir;
const dummyName = `rundea-capacity-fixture-${process.pid}`;
try {
  // Memory guardrail: reserve almost all accountable capacity with a managed
  // sleeping fixture. It consumes negligible RSS but advertises a hard limit,
  // exactly what admission control is designed to account for.
  const memoryFixture = await makeFixture("memory-gate");
  memoryWorkDir = await mkdtemp(join(tmpdir(), "rundea-memory-gate-"));
  memoryAgent = startAgent(memoryFixture, memoryWorkDir);
  await waitOnline(memoryFixture, memoryAgent);

  const totalBytes = parseMemTotalBytes(await readFile("/proc/meminfo", "utf8"));
  const reserveBytes = Math.max(768 * 1024 * 1024, Math.floor(totalBytes / 5));
  const buildIncoming = 1024 * 1024 * 1024;
  const targetCommitted = Math.max(16 * 1024 * 1024, totalBytes - reserveBytes - buildIncoming + 64 * 1024 * 1024);
  const memoryArg = String(targetCommitted);

  const pull = spawnSync("docker", ["pull", "alpine:3.20"], { encoding: "utf8" });
  if (pull.status !== 0) throw new Error(`docker pull alpine failed: ${pull.stderr}`);
  const started = spawnSync("docker", [
    "run", "-d", "--name", dummyName,
    "--memory", memoryArg, "--memory-swap", memoryArg,
    "--label", "rundea.managed=true",
    "--label", "rundea.backend=true",
    "--label", "rundea.kind=runtime",
    "alpine:3.20", "sleep", "600",
  ], { encoding: "utf8" });
  if (started.status !== 0) throw new Error(`capacity fixture failed: ${started.stderr}`);

  const memoryDeployment = await deploy(memoryFixture);
  await waitFailed(memoryFixture.service.id, memoryDeployment.id);
  const memoryEvents = await events(memoryDeployment.id);
  assert.ok(memoryEvents.some((event) => String(event.message ?? "").includes("node memory capacity is exhausted")),
    `memory guardrail failure not found in events: ${JSON.stringify(memoryEvents.slice(-8))}`);
  await assertControlPlaneHealthy("after memory rejection");

  spawnSync("docker", ["rm", "-f", dummyName], { stdio: "ignore" });
  stopAgent(memoryAgent);
  await sleep(500);

  // Disk guardrail: Agent workdir lives on a deliberately near-full dedicated
  // filesystem prepared by CI. Checkout must be refused before Docker build.
  const diskFixture = await makeFixture("disk-gate");
  diskAgent = startAgent(diskFixture, lowDiskWorkDir);
  await waitOnline(diskFixture, diskAgent);
  const diskDeployment = await deploy(diskFixture);
  await waitFailed(diskFixture.service.id, diskDeployment.id);
  const diskEvents = await events(diskDeployment.id);
  assert.ok(diskEvents.some((event) => {
    const message = String(event.message ?? "");
    return message.includes("node disk headroom is too low") || message.includes("source checkout admission");
  }), `disk guardrail failure not found in events: ${JSON.stringify(diskEvents.slice(-8))}`);
  await assertControlPlaneHealthy("after disk rejection");

  console.log(JSON.stringify({
    ok: true,
    verified: [
      "memory-hungry-managed-fixture-rejected-before-starving-control-plane",
      "control-plane-remains-healthy-after-memory-rejection",
      "low-disk-workdir-refuses-new-build-before-host-failure",
      "control-plane-remains-healthy-after-disk-rejection",
    ],
  }, null, 2));
} finally {
  spawnSync("docker", ["rm", "-f", dummyName], { stdio: "ignore" });
  stopAgent(memoryAgent);
  stopAgent(diskAgent);
  if (memoryWorkDir) await rm(memoryWorkDir, { recursive: true, force: true }).catch(() => undefined);
}
