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
const hostPort = Number(process.env.RUNDEA_SAFE_PROMOTION_HOST_PORT ?? "18082");
const badHealthPath = "/__rundea_intentionally_missing_healthcheck__";
const markerHeader = "x-rundea-deployment";

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!/^[0-9a-f]{40}$/.test(fixtureSha)) throw new Error("RUNDEA_ACCEPTANCE_FIXTURE_SHA must be a full Git SHA");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("invalid safe-promotion host port");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const serviceName = `safe-promotion-${Date.now().toString(36)}`;
const containerBase = `rundea-${serviceName}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-safe-promotion-"));
let agent;
let nodeId = "";
let healthyDeploymentId = "";
let failedDeploymentId = "";

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

async function createDeployment(healthcheckPath) {
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
      healthcheckPath,
    }),
  });
  return body.id;
}

async function waitReady(id, label) {
  return await poll(label, async () => {
    const row = await deployment(id);
    if (!row) return { last: "missing" };
    if (row.status === "READY") return { done: true, value: row };
    if (["FAILED", "CANCELLED", "ROLLED_BACK"].includes(row.status)) {
      throw new FatalPollError(`${label} reached ${row.status}: ${JSON.stringify(await deploymentEvents(id))}`);
    }
    return { last: row.status };
  }, 240_000, 1000);
}

async function waitForHealthcheckState(id) {
  return await poll("bad backend to enter HEALTHCHECK", async () => {
    const row = await deployment(id);
    if (!row) return { last: "missing" };
    if (row.status === "HEALTHCHECK") return { done: true, value: row };
    if (row.status === "FAILED") throw new FatalPollError("backend failed before HEALTHCHECK state could be observed");
    return { last: row.status };
  }, 240_000, 250);
}

async function waitFailed(id) {
  return await poll("bad-healthcheck backend to fail", async () => {
    const row = await deployment(id);
    if (!row) return { last: "missing" };
    if (row.status === "FAILED") return { done: true, value: row };
    if (row.status === "READY") throw new FatalPollError("bad-healthcheck backend unexpectedly became READY");
    return { last: row.status };
  }, 180_000, 750);
}

async function assertStableRoute(label, expectedDeploymentId) {
  const response = await fetch(`http://127.0.0.1:${hostPort}/`);
  const body = await response.text();
  const marker = response.headers.get(markerHeader);
  if (!response.ok || !body.includes("Hello from Render!") || marker !== expectedDeploymentId) {
    throw new Error(`${label}: stable route mismatch status=${response.status} marker=${marker} body=${body.slice(0, 160)}`);
  }
}

function revisionName(deploymentId) {
  return `${containerBase}-rev-${deploymentId.replaceAll("-", "").toLowerCase().slice(0, 12)}`;
}

function inspectDeploymentLabel(name) {
  const result = spawnSync("docker", ["inspect", "--format", '{{ index .Config.Labels "rundea.deployment" }}', name], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker inspect ${name} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function assertContainerAbsent(name) {
  const result = spawnSync("docker", ["inspect", name], { stdio: "ignore" });
  if (result.status === 0) throw new Error(`temporary backend ${name} still exists after failed deployment cleanup`);
}

try {
  const node = await request("/v0/nodes", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `safe-promotion-${process.pid}` }),
  });
  nodeId = node.id;
  const nodeToken = await activateNodeCredential(api, node.id, node.token);

  agent = spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: node.id,
      RUNDEA_NODE_TOKEN: nodeToken,
      RUNDEA_WORK_DIR: workDir,
      RUNDEA_METRICS_INTERVAL: "2s",
    },
  });

  await poll("safe-promotion agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited with code ${agent.exitCode}`);
    const nodes = await request("/v0/nodes", { headers });
    const row = nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.status ?? "missing" };
  }, 45_000, 500);

  healthyDeploymentId = await createDeployment("/");
  await waitReady(healthyDeploymentId, "baseline deployment");
  await assertStableRoute("baseline deployment", healthyDeploymentId);
  if (inspectDeploymentLabel(revisionName(healthyDeploymentId)) !== healthyDeploymentId) {
    throw new Error("baseline backend does not carry the baseline deployment identity");
  }

  failedDeploymentId = await createDeployment(badHealthPath);
  await waitForHealthcheckState(failedDeploymentId);

  // The stable listener is owned by the runtime router. A failing backend is
  // validated on its own dynamic loopback port and therefore cannot replace
  // the previous committed route.
  await assertStableRoute("failed backend validation", healthyDeploymentId);

  await waitFailed(failedDeploymentId);
  await assertStableRoute("failed backend fallback", healthyDeploymentId);

  const events = await deploymentEvents(failedDeploymentId);
  if (!events.some((event) => typeof event.message === "string" && event.message.includes("current stable route remained live"))) {
    throw new Error(`failed backend did not record the expected routing safety event: ${JSON.stringify(events.slice(-20))}`);
  }
  assertContainerAbsent(revisionName(failedDeploymentId));

  console.log(JSON.stringify({
    ok: true,
    nodeId,
    serviceName,
    healthyDeploymentId,
    failedDeploymentId,
    verified: [
      "bootstrap-to-permanent-node-credential",
      "stable-port-owned-by-runtime-router",
      "backend-runs-on-dynamic-loopback-port",
      "previous-route-serves-during-bad-healthcheck",
      "bad-healthcheck-deployment-reaches-failed",
      "previous-route-remains-committed-after-failure",
      "failed-backend-cleaned-up",
    ],
  }, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  for (const id of [healthyDeploymentId, failedDeploymentId].filter(Boolean)) {
    spawnSync("docker", ["rm", "-f", revisionName(id)], { stdio: "ignore" });
  }
  spawnSync("docker", ["rm", "-f", "rundea-runtime-router"], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true });
}
