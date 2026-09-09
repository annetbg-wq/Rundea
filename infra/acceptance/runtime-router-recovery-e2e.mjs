import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
const hostPort = Number(process.env.RUNDEA_RECOVERY_HOST_PORT ?? "18083");
const markerHeader = "x-rundea-deployment";

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!/^[0-9a-f]{40}$/.test(fixtureSha)) throw new Error("RUNDEA_ACCEPTANCE_FIXTURE_SHA must be a full Git SHA");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const serviceName = `router-recovery-${Date.now().toString(36)}`;
const containerBase = `rundea-${serviceName}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-router-recovery-"));
const deploymentIds = [];
let nodeId = "";
let nodeToken = "";
let agent;

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

async function poll(label, fn, timeoutMs = 180_000, intervalMs = 500) {
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

function spawnAgent(postSwitchDelay = "") {
  return spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: nodeId,
      RUNDEA_NODE_TOKEN: nodeToken,
      RUNDEA_WORK_DIR: workDir,
      RUNDEA_METRICS_INTERVAL: "2s",
      ...(postSwitchDelay ? { RUNDEA_TEST_POST_SWITCH_DELAY: postSwitchDelay } : {}),
    },
  });
}

async function stopAgent() {
  if (!agent || agent.exitCode !== null) return;
  agent.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
  if (agent.exitCode === null) agent.kill("SIGKILL");
}

async function waitNodeStatus(status) {
  return await poll(`node ${status}`, async () => {
    const nodes = await request("/v0/nodes", { headers });
    const row = nodes.find((item) => item.id === nodeId);
    if (!row) return { last: "missing" };
    return row.status === status ? { done: true, value: row } : { last: row.status };
  }, 45_000, 250);
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

async function createDeployment() {
  const body = await request("/v0/deployments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      serviceName,
      nodeId,
      sourceRepository: fixtureRepository,
      sourceRef: fixtureSha,
      sourceDelivery: "DIRECT",
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
    }),
  });
  deploymentIds.push(body.id);
  return body.id;
}

async function waitStatus(id, status, label, timeoutMs = 240_000) {
  return await poll(label, async () => {
    const row = await deployment(id);
    if (!row) return { last: "missing" };
    if (row.status === status) return { done: true, value: row };
    if (status === "READY" && ["CANCELLED", "ROLLED_BACK"].includes(row.status)) {
      throw new FatalPollError(`${label} reached terminal ${row.status}`);
    }
    return { last: row.status };
  }, timeoutMs, 400);
}

async function stableRoute() {
  const response = await fetch(`http://127.0.0.1:${hostPort}/`);
  const body = await response.text();
  return { ok: response.ok, status: response.status, marker: response.headers.get(markerHeader), body };
}

async function assertStableRoute(expectedDeploymentId, label) {
  const result = await stableRoute();
  if (!result.ok || result.marker !== expectedDeploymentId || !result.body.includes("Hello from Render!")) {
    throw new Error(`${label}: status=${result.status} marker=${result.marker} body=${result.body.slice(0, 160)}`);
  }
}

function revisionName(deploymentId) {
  return `${containerBase}-rev-${deploymentId.replaceAll("-", "").toLowerCase().slice(0, 12)}`;
}

try {
  const node = await request("/v0/nodes", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `router-recovery-${process.pid}` }),
  });
  nodeId = node.id;
  nodeToken = await activateNodeCredential(api, node.id, node.token);

  agent = spawnAgent();
  await waitNodeStatus("ONLINE");

  const firstId = await createDeployment();
  await waitStatus(firstId, "READY", "baseline READY");
  await assertStableRoute(firstId, "baseline stable route");

  // Reconnect once with a test-only delay after a route switch has been
  // committed but before the Agent emits the final READY status. This creates
  // the exact crash window that runtimeRecovered must reconcile.
  await stopAgent();
  await waitNodeStatus("OFFLINE");
  await assertStableRoute(firstId, "runtime router survives agent stop");

  agent = spawnAgent("15s");
  await waitNodeStatus("ONLINE");
  const secondId = await createDeployment();

  await poll("second route committed before READY acknowledgement", async () => {
    const row = await deployment(secondId);
    if (!row) return { last: "missing" };
    const routed = await stableRoute();
    if (routed.ok && routed.marker === secondId && routed.body.includes("Hello from Render!") && row.status === "HEALTHCHECK") {
      return { done: true, value: row };
    }
    if (row.status === "READY") throw new FatalPollError("test delay did not preserve the post-switch/pre-READY window");
    if (row.status === "FAILED") throw new FatalPollError(`second deployment failed before crash window: ${JSON.stringify(await deploymentEvents(secondId))}`);
    return { last: { status: row.status, marker: routed.marker } };
  }, 240_000, 200);

  await stopAgent();
  await waitNodeStatus("OFFLINE");
  await waitStatus(secondId, "FAILED", "disconnect reconciliation to FAILED", 45_000);

  // The router and backend are separate Docker processes; traffic must stay on
  // the committed second revision even though the Agent is completely down.
  for (let i = 0; i < 20; i += 1) {
    await assertStableRoute(secondId, `agent-down request ${i + 1}`);
    await sleep(50);
  }

  agent = spawnAgent();
  await waitNodeStatus("ONLINE");
  const recovered = await waitStatus(secondId, "READY", "runtimeRecovered FAILED→READY reconciliation", 45_000);
  await assertStableRoute(secondId, "recovered stable route");

  const events = await deploymentEvents(secondId);
  if (!events.some((event) => event.kind === "STATUS" && event.status === "READY" && event.message === "live runtime route recovered after agent reconnect")) {
    throw new Error(`Control Plane did not record recovered live route: ${JSON.stringify(events.slice(-20))}`);
  }
  if (!/^[0-9a-f]{64}$/.test(recovered.runtime_container_id ?? "")) {
    throw new Error(`recovered deployment has invalid container identity ${recovered.runtime_container_id}`);
  }

  console.log(JSON.stringify({
    ok: true,
    nodeId,
    serviceName,
    firstId,
    secondId,
    verified: [
      "bootstrap-to-permanent-node-credential",
      "runtime-router-survives-agent-stop",
      "committed-route-serves-with-agent-offline",
      "disconnect-marks-post-switch-healthcheck-failed",
      "agent-reconnect-verifies-committed-route",
      "control-plane-reconciles-failed-to-ready-only-after-live-route-proof",
    ],
  }, null, 2));
} finally {
  await stopAgent();
  for (const id of deploymentIds) {
    spawnSync("docker", ["rm", "-f", revisionName(id)], { stdio: "ignore" });
  }
  spawnSync("docker", ["rm", "-f", "rundea-runtime-router"], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true });
}
