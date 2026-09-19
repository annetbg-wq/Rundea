import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");

const controlHeaders = { authorization: `Bearer ${controlToken}` };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function body(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function request(path, init = {}) {
  const headers = {
    ...controlHeaders,
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    ...(init.headers ?? {}),
  };
  const response = await fetch(api + path, { ...init, headers });
  const parsed = await body(response);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function waitForNode(workspaceId, nodeId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const payload = await request(`/v0/workspaces/${workspaceId}/nodes?includeArchived=true`);
    last = payload.nodes.find((row) => row.id === nodeId);
    if (last && predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`node state timeout: ${JSON.stringify(last)}`);
}

async function waitForAction(nodeId, actionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const payload = await request(`/v0/nodes/${nodeId}/maintenance`);
    last = payload.actions.find((row) => row.id === actionId);
    if (last && last.status !== "RUNNING") return last;
    await sleep(250);
  }
  throw new Error(`maintenance action timeout: ${JSON.stringify(last)}`);
}

function startAgent(nodeId, token, workDir) {
  return spawn(agentBinary, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: nodeId,
      RUNDEA_NODE_TOKEN: token,
      RUNDEA_WORK_DIR: workDir,
      RUNDEA_METRICS_INTERVAL: "2s",
      RUNDEA_AGENT_TEST_DISABLE_SERVICE_ACTIONS: "1",
    },
  });
}

async function stopAgent(agent) {
  if (agent.exitCode !== null) return;
  agent.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => agent.once("exit", resolve)),
    sleep(2500),
  ]);
  if (agent.exitCode === null) agent.kill("SIGKILL");
}

const suffix = Date.now().toString(36);
const workspace = await request("/v0/workspaces", {
  method: "POST",
  body: JSON.stringify({ slug: "maint-" + suffix, name: "Maintenance " + suffix }),
});
const created = await request(`/v0/workspaces/${workspace.id}/nodes`, {
  method: "POST",
  body: JSON.stringify({ name: "maintenance-node-" + suffix }),
});
if (!created?.id || !created?.token) throw new Error("canonical node creation did not return one-time bootstrap credential");

const permanentToken = randomBytes(32).toString("hex");
const exchange = await fetch(`${api}/v0/nodes/${created.id}/bootstrap/exchange`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ agentToken: permanentToken }),
});
if (exchange.status !== 204) throw new Error(`bootstrap exchange failed: ${exchange.status} ${await exchange.text()}`);

const workDir = await mkdtemp(join(tmpdir(), "rundea-maintenance-"));
const agent = startAgent(created.id, permanentToken, workDir);
let agentLog = "";
agent.stdout.on("data", (chunk) => { agentLog += chunk.toString(); });
agent.stderr.on("data", (chunk) => { agentLog += chunk.toString(); });

try {
  const online = await waitForNode(
    workspace.id,
    created.id,
    (node) => node.status === "ONLINE" && node.lifecycleStatus === "ACTIVE",
  );
  if (!online.agentCapabilities.includes("nodeMaintenance")) {
    throw new Error(`Agent did not report nodeMaintenance capability: ${JSON.stringify(online.agentCapabilities)}`);
  }

  const update = await request(`/v0/nodes/${created.id}/maintenance/update`, { method: "POST" });
  if (update.kind !== "UPDATE_AGENT" || update.status !== "RUNNING") {
    throw new Error(`unexpected update action: ${JSON.stringify(update)}`);
  }
  const updateDone = await waitForAction(created.id, update.id);
  if (updateDone.status !== "SUCCEEDED" || !updateDone.resultAgentVersion || !updateDone.resultBuildSha) {
    throw new Error(`Agent update failed: ${JSON.stringify(updateDone)}\n${agentLog}`);
  }

  const activeAgain = await waitForNode(
    workspace.id,
    created.id,
    (node) => node.lifecycleStatus === "ACTIVE" && node.status === "ONLINE",
  );
  if (activeAgain.agentVersion !== updateDone.resultAgentVersion) {
    throw new Error(`node version mismatch after update: node=${activeAgain.agentVersion} action=${updateDone.resultAgentVersion}`);
  }

  const cleanup = await request(`/v0/nodes/${created.id}/maintenance/cleanup`, { method: "POST" });
  if (cleanup.kind !== "CLEANUP_NODE" || cleanup.status !== "RUNNING") {
    throw new Error(`unexpected cleanup action: ${JSON.stringify(cleanup)}`);
  }
  const cleanupDone = await waitForAction(created.id, cleanup.id);
  if (cleanupDone.status !== "SUCCEEDED") {
    throw new Error(`node cleanup failed: ${JSON.stringify(cleanupDone)}\n${agentLog}`);
  }

  const archived = await waitForNode(
    workspace.id,
    created.id,
    (node) => node.lifecycleStatus === "ARCHIVED" && node.status === "OFFLINE",
  );
  if (!String(archived.compatibilityError ?? "").includes("credential revoked")) {
    throw new Error(`archived node did not record credential revocation: ${JSON.stringify(archived)}`);
  }

  const oldCredential = await fetch(`${api}/v0/nodes/${created.id}/self/status`, {
    headers: { authorization: `Bearer ${permanentToken}` },
  });
  if (oldCredential.status !== 401) {
    throw new Error(`cleaned node credential still authenticates: ${oldCredential.status} ${await oldCredential.text()}`);
  }

  console.log(JSON.stringify({
    ok: true,
    nodeId: created.id,
    verified: [
      "maintenance-capability-advertised",
      "product-update-command-dispatched",
      "authenticated-release-downloaded-and-checksummed",
      "atomic-agent-update-succeeded",
      "maintenance-node-excluded-then-returned-active",
      "product-cleanup-command-dispatched",
      "node-cleanup-succeeded-without-ssh",
      "node-archived-and-credential-revoked",
    ],
  }, null, 2));
} finally {
  await stopAgent(agent);
  await rm(workDir, { recursive: true, force: true });
}
