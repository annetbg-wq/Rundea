import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const fixtureRef = process.env.RUNDEA_ACCEPTANCE_FIXTURE_REF ?? "main";
const expectedFixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
const hostPort = Number(process.env.RUNDEA_ACCEPTANCE_HOST_PORT ?? "18081");
const terminal = new Set(["READY", "FAILED", "CANCELLED", "ROLLED_BACK"]);
const imageIdPattern = /^sha256:[0-9a-f]{64}$/;

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("invalid acceptance host port");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const serviceName = `acceptance-${Date.now().toString(36)}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-acceptance-"));
let agent;
const deploymentIds = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function poll(label, fn, timeoutMs = 180_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value?.done) return value.value;
      last = value?.last ?? last;
    } catch (error) {
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
  return (await deployments()).find((item) => item.id === id);
}

async function waitDeployment(id, label) {
  return await poll(label, async () => {
    const row = await deployment(id);
    if (!row) return { last: "deployment not visible yet" };
    if (row.status === "READY") return { done: true, value: row };
    if (terminal.has(row.status)) throw new Error(`${label} reached ${row.status}`);
    return { last: row.status };
  }, 240_000, 1500);
}

async function createDeployment() {
  const body = await request("/v0/deployments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      serviceName,
      nodeId,
      sourceRepository: fixtureRepository,
      sourceRef: fixtureRef,
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
    }),
  });
  deploymentIds.push(body.id);
  return body.id;
}

function assertArtifact(row, label) {
  if (row.source_commit_sha !== expectedFixtureSha) {
    throw new Error(`${label} resolved unexpected source SHA ${row.source_commit_sha}; expected ${expectedFixtureSha}`);
  }
  if (!imageIdPattern.test(row.image_id ?? "")) throw new Error(`${label} has invalid image identity ${row.image_id}`);
  if (!row.environment_snapshot_at) throw new Error(`${label} has no immutable environment snapshot`);
  if (row.healthcheck_path !== "/") throw new Error(`${label} resolved unexpected healthcheck ${row.healthcheck_path}`);
}

async function assertService(label) {
  const response = await fetch(`http://127.0.0.1:${hostPort}/`);
  const body = await response.text();
  if (!response.ok || !body.includes("Hello from Render!")) {
    throw new Error(`${label} service check failed: ${response.status} ${body.slice(0, 160)}`);
  }
}

async function restart(deploymentId) {
  const action = await request(`/v0/deployments/${deploymentId}/restart`, { method: "POST", headers });
  return await poll("restart action", async () => {
    const body = await request("/v0/runtime-actions", { headers });
    const row = body.actions.find((item) => item.id === action.id);
    if (!row) return { last: "action not visible yet" };
    if (row.status === "SUCCEEDED") return { done: true, value: row };
    if (row.status === "FAILED") throw new Error(`restart failed: ${row.error ?? "unknown error"}`);
    return { last: row.status };
  }, 120_000, 1000);
}

async function rollback(targetId, label) {
  const created = await request(`/v0/deployments/${targetId}/rollback`, { method: "POST", headers });
  deploymentIds.push(created.id);
  return await waitDeployment(created.id, label);
}

let nodeId;
try {
  const health = await fetch(`${api}/health`);
  if (!health.ok) throw new Error(`control plane health returned ${health.status}`);

  const node = await request("/v0/nodes", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `acceptance-${process.pid}` }),
  });
  nodeId = node.id;

  agent = spawn(agentBinary, [
    "--control-plane", api,
    "--node-id", node.id,
    "--token", node.token,
    "--work-dir", workDir,
  ], { stdio: ["ignore", "inherit", "inherit"] });

  await poll("agent online", async () => {
    const nodes = await request("/v0/nodes", { headers });
    const row = nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.status ?? "missing" };
  }, 45_000, 500);

  const firstId = await createDeployment();
  const first = await waitDeployment(firstId, "first deployment");
  assertArtifact(first, "first deployment");
  await assertService("first deployment");

  await restart(firstId);
  await assertService("restart");

  const secondId = await createDeployment();
  const second = await waitDeployment(secondId, "second deployment");
  assertArtifact(second, "second deployment");
  await assertService("second deployment");

  const rollbackOne = await rollback(firstId, "rollback to first revision");
  assertArtifact(rollbackOne, "rollback to first revision");
  await assertService("rollback to first revision");

  const secondAfterRollback = await deployment(secondId);
  if (secondAfterRollback?.status !== "ROLLED_BACK") {
    throw new Error(`second deployment should be ROLLED_BACK, got ${secondAfterRollback?.status}`);
  }

  const rollbackTwo = await rollback(secondId, "rollback chain to second revision");
  assertArtifact(rollbackTwo, "rollback chain to second revision");
  await assertService("rollback chain");

  console.log(JSON.stringify({
    ok: true,
    nodeId,
    serviceName,
    fixtureSha: expectedFixtureSha,
    deployments: deploymentIds,
    verified: ["agent-online", "node-auto-build", "artifact-identity", "http-health", "restart", "exact-rollback", "rollback-chain"],
  }, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => agent.once("exit", resolve)),
      sleep(3000),
    ]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  spawnSync("docker", ["rm", "-f", `rundea-${serviceName}`], { stdio: "ignore" });
  spawnSync("docker", ["rm", "-f", `rundea-${serviceName}-rollback-backup`], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true });
}
