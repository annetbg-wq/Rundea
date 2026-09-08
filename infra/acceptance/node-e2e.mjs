import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const githubWebhookSecret = process.env.RUNDEA_GITHUB_WEBHOOK_SECRET;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const fixtureRef = process.env.RUNDEA_ACCEPTANCE_FIXTURE_REF ?? "main";
const expectedFixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
const hostPort = Number(process.env.RUNDEA_ACCEPTANCE_HOST_PORT ?? "18081");
const terminal = new Set(["READY", "FAILED", "CANCELLED", "ROLLED_BACK"]);
const imageIdPattern = /^sha256:[0-9a-f]{64}$/;

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!githubWebhookSecret) throw new Error("RUNDEA_GITHUB_WEBHOOK_SECRET is required");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("invalid acceptance host port");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const serviceName = `acceptance-${Date.now().toString(36)}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-acceptance-"));
let agent;
const deploymentIds = [];

class FatalPollError extends Error {}

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
  return (await deployments()).find((item) => item.id === id);
}

async function deploymentEvents(id) {
  return await request(`/v0/deployments/${id}/events`, { headers });
}

async function waitDeployment(id, label) {
  return await poll(label, async () => {
    const row = await deployment(id);
    if (!row) return { last: "deployment not visible yet" };
    if (row.status === "READY") return { done: true, value: row };
    if (terminal.has(row.status)) throw new FatalPollError(`${label} reached ${row.status}`);
    return { last: row.status };
  }, 240_000, 1500);
}

async function createBrokeredDeployment() {
  const body = await request("/v0/deployments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      serviceName,
      nodeId,
      sourceRepository: fixtureRepository,
      sourceRef: expectedFixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
    }),
  });
  if (body.sourceDelivery !== "BROKER") {
    throw new Error(`brokered deployment was not accepted as BROKER: ${JSON.stringify(body)}`);
  }
  deploymentIds.push(body.id);
  return body.id;
}

async function configureAutodeploy() {
  const body = await request(`/v0/services/${serviceName}/autodeploy`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      nodeId,
      repository: fixtureRepository,
      branch: "main",
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
      enabled: true,
    }),
  });
  if (body.autodeploy?.repository_full_name !== "render-examples/express-hello-world" || body.autodeploy?.source_branch !== "main") {
    throw new Error(`unexpected autodeploy configuration: ${JSON.stringify(body)}`);
  }
}

async function signedPush(deliveryId) {
  const rawBody = JSON.stringify({
    ref: "refs/heads/main",
    after: expectedFixtureSha,
    deleted: false,
    repository: { full_name: "render-examples/express-hello-world" },
  });
  const signature = `sha256=${createHmac("sha256", githubWebhookSecret).update(rawBody).digest("hex")}`;
  const response = await fetch(`${api}/v0/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub webhook -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function createDeploymentFromPush() {
  await configureAutodeploy();
  const deliveryId = `acceptance-${Date.now().toString(36)}-${process.pid}`;
  const first = await signedPush(deliveryId);
  if (first.status !== "TRIGGERED" || first.deployments?.length !== 1 || first.deployments[0]?.serviceName !== serviceName) {
    throw new Error(`signed push did not trigger exactly one service deployment: ${JSON.stringify(first)}`);
  }
  const deploymentId = first.deployments[0].deploymentId;
  deploymentIds.push(deploymentId);

  const duplicate = await signedPush(deliveryId);
  if (duplicate.duplicate !== true || duplicate.status !== "TRIGGERED" || duplicate.deploymentCount !== 1) {
    throw new Error(`duplicate GitHub delivery was not idempotent: ${JSON.stringify(duplicate)}`);
  }

  const replayDeliveryId = `${deliveryId}-replay`;
  const replay = await signedPush(replayDeliveryId);
  if (replay.duplicate !== true || replay.status !== "TRIGGERED" || replay.deploymentCount !== 1 || replay.originalDeliveryId !== deliveryId) {
    throw new Error(`replayed signed GitHub body created a new event: ${JSON.stringify(replay)}`);
  }

  const deliveries = await request("/v0/github/deliveries", { headers });
  const recorded = deliveries.deliveries?.find((item) => item.delivery_id === deliveryId);
  if (!recorded || recorded.status !== "TRIGGERED" || Number(recorded.deployment_count) !== 1) {
    throw new Error(`GitHub delivery observability mismatch: ${JSON.stringify(recorded)}`);
  }
  if (!recorded.deployments?.some((item) => item.serviceName === serviceName && item.deploymentId === deploymentId)) {
    throw new Error(`GitHub delivery is not linked to triggered deployment: ${JSON.stringify(recorded)}`);
  }
  if (deliveries.deliveries?.some((item) => item.delivery_id === replayDeliveryId)) {
    throw new Error("replayed signed GitHub body should not create a second delivery record");
  }
  return deploymentId;
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

async function assertBrokeredSource(id) {
  const row = await deployment(id);
  if (row?.source_delivery !== "BROKER") {
    throw new Error(`deployment ${id} did not persist BROKER source delivery`);
  }
  const events = await deploymentEvents(id);
  if (!events.some((event) => event.kind === "LOG" && event.stream === "system" && event.message?.includes("source delivered through Rundea broker"))) {
    throw new Error("brokered deployment did not prove Agent bundle delivery path");
  }
}

async function restart(deploymentId) {
  const action = await request(`/v0/deployments/${deploymentId}/restart`, { method: "POST", headers });
  return await poll("restart action", async () => {
    const body = await request("/v0/runtime-actions", { headers });
    const row = body.actions.find((item) => item.id === action.id);
    if (!row) return { last: "action not visible yet" };
    if (row.status === "SUCCEEDED") return { done: true, value: row };
    if (row.status === "FAILED") throw new FatalPollError(`restart failed: ${row.error ?? "unknown error"}`);
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

  agent = spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: node.id,
      RUNDEA_NODE_TOKEN: node.token,
      RUNDEA_WORK_DIR: workDir,
    },
  });

  await poll("agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited before becoming ONLINE with code ${agent.exitCode}`);
    const nodes = await request("/v0/nodes", { headers });
    const row = nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.status ?? "missing" };
  }, 45_000, 500);

  const firstId = await createDeploymentFromPush();
  const first = await waitDeployment(firstId, "GitHub push deployment");
  assertArtifact(first, "GitHub push deployment");
  await assertService("GitHub push deployment");

  await restart(firstId);
  await assertService("restart");

  const secondId = await createBrokeredDeployment();
  const second = await waitDeployment(secondId, "brokered source deployment");
  assertArtifact(second, "brokered source deployment");
  await assertBrokeredSource(secondId);
  await assertService("brokered source deployment");

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
    verified: [
      "agent-online",
      "signed-github-push",
      "github-delivery-idempotency",
      "github-body-replay-protection",
      "github-delivery-observability",
      "exact-source-commit",
      "brokered-source-ticket",
      "brokered-source-extraction",
      "node-auto-build",
      "artifact-identity",
      "http-health",
      "restart",
      "exact-rollback",
      "rollback-chain",
    ],
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
