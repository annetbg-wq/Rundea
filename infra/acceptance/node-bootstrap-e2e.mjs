import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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

async function json(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function nodeStatus(nodeId) {
  const response = await fetch(`${api}/v0/nodes`, { headers: controlHeaders });
  if (!response.ok) throw new Error(`list nodes failed: ${response.status}`);
  const rows = await response.json();
  return rows.find((row) => row.id === nodeId)?.status ?? "MISSING";
}

async function waitForStatus(nodeId, expected, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "MISSING";
  while (Date.now() < deadline) {
    last = await nodeStatus(nodeId);
    if (last === expected) return;
    await sleep(250);
  }
  throw new Error(`node ${nodeId} did not reach ${expected}; last=${last}`);
}

function startAgent(nodeId, token, workDir) {
  return spawn(agentBinary, [], {
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: nodeId,
      RUNDEA_NODE_TOKEN: token,
      RUNDEA_WORK_DIR: workDir,
      RUNDEA_METRICS_INTERVAL: "2s",
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

const createdResponse = await fetch(`${api}/v0/nodes`, {
  method: "POST",
  headers: {
    ...controlHeaders,
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: `bootstrap-acceptance-${process.pid}` }),
});
const created = await json(createdResponse);
if (createdResponse.status !== 201 || !created?.id || !created?.token) {
  throw new Error(`node creation failed: ${createdResponse.status} ${JSON.stringify(created)}`);
}

// Bootstrap may fetch the pinned release, but it must not be an Agent
// credential. The acceptance Control Plane has no release provider configured,
// so reaching the provider check proves authentication succeeded.
const bootstrapReleaseResponse = await fetch(`${api}/v0/agent/releases/amd64/sha256`, {
  headers: {
    authorization: `Bearer ${created.token}`,
    "x-rundea-node-id": created.id,
  },
});
if (bootstrapReleaseResponse.status !== 503) {
  throw new Error(`bootstrap credential was not limited to release bootstrap path: ${bootstrapReleaseResponse.status}`);
}

const bootstrapWorkDir = await mkdtemp(join(tmpdir(), "rundea-bootstrap-rejected-"));
const bootstrapAgent = startAgent(created.id, created.token, bootstrapWorkDir);
try {
  await sleep(2200);
  const status = await nodeStatus(created.id);
  if (status !== "OFFLINE") {
    throw new Error(`bootstrap credential authenticated the Agent WebSocket; status=${status}`);
  }
} finally {
  await stopAgent(bootstrapAgent);
  await rm(bootstrapWorkDir, { recursive: true, force: true });
}

const permanentToken = randomBytes(32).toString("hex");
const exchangeResponse = await fetch(`${api}/v0/nodes/${encodeURIComponent(created.id)}/bootstrap/exchange`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ agentToken: permanentToken }),
});
if (exchangeResponse.status !== 204) {
  throw new Error(`bootstrap exchange failed: ${exchangeResponse.status} ${await exchangeResponse.text()}`);
}

const replayResponse = await fetch(`${api}/v0/nodes/${encodeURIComponent(created.id)}/bootstrap/exchange`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ agentToken: randomBytes(32).toString("hex") }),
});
if (replayResponse.status !== 401) {
  throw new Error(`consumed bootstrap credential was accepted again: ${replayResponse.status}`);
}

const oldCredentialResponse = await fetch(`${api}/v0/agent/releases/amd64/sha256`, {
  headers: {
    authorization: `Bearer ${created.token}`,
    "x-rundea-node-id": created.id,
  },
});
if (oldCredentialResponse.status !== 401) {
  throw new Error(`old bootstrap credential still authenticates after exchange: ${oldCredentialResponse.status}`);
}

const permanentCredentialResponse = await fetch(`${api}/v0/agent/releases/amd64/sha256`, {
  headers: {
    authorization: `Bearer ${permanentToken}`,
    "x-rundea-node-id": created.id,
  },
});
if (permanentCredentialResponse.status !== 503) {
  throw new Error(`permanent node credential was not accepted before release-provider check: ${permanentCredentialResponse.status}`);
}

const activeWorkDir = await mkdtemp(join(tmpdir(), "rundea-bootstrap-active-"));
const activeAgent = startAgent(created.id, permanentToken, activeWorkDir);
try {
  await waitForStatus(created.id, "ONLINE");
} finally {
  await stopAgent(activeAgent);
  await waitForStatus(created.id, "OFFLINE");
  await rm(activeWorkDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  nodeId: created.id,
  verified: [
    "bootstrap-release-download-authorized",
    "bootstrap-token-rejected-by-agent-websocket",
    "bootstrap-token-accepted-once-for-exchange",
    "bootstrap-token-invalid-after-exchange",
    "permanent-node-credential-activated",
    "permanent-node-credential-authenticates-agent-websocket",
  ],
}, null, 2));
