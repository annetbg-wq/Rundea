import WebSocket from "ws";
import { randomBytes } from "node:crypto";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");

const controlHeaders = { authorization: `Bearer ${controlToken}` };
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parse(response) {
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
  const parsed = await parse(response);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(parsed)}`);
  return { response, body: parsed };
}

async function createWorkspace(prefix) {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  return (await request("/v0/workspaces", {
    method: "POST",
    body: JSON.stringify({ slug: `${prefix}-${suffix}`, name: `${prefix} ${suffix}` }),
  })).body;
}

async function createNode(workspaceId, name) {
  return request(`/v0/workspaces/${workspaceId}/nodes`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

async function exchange(nodeId, bootstrapToken, permanentToken) {
  const response = await fetch(`${api}/v0/nodes/${nodeId}/bootstrap/exchange`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentToken: permanentToken }),
  });
  if (response.status !== 204) throw new Error(`bootstrap exchange failed: ${response.status} ${await response.text()}`);
}

async function waitForNode(workspaceId, nodeId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const payload = (await request(`/v0/workspaces/${workspaceId}/nodes?includeArchived=true`)).body;
    last = payload.nodes.find((node) => node.id === nodeId);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`node state timeout: ${JSON.stringify(last)}`);
}

async function waitForEvent(deploymentId, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (Date.now() < deadline) {
    events = (await request(`/v0/deployments/${deploymentId}/events`)).body;
    const found = events.find(predicate);
    if (found) return { found, events };
    await sleep(150);
  }
  throw new Error(`deployment event timeout: ${JSON.stringify(events.slice(-10))}`);
}

function connectFakeAgent(nodeId, token) {
  const wsUrl = api.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/v0/agent/ws";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-rundea-node-id": nodeId,
      },
    });
    const timer = setTimeout(() => reject(new Error("fake Agent websocket timeout")), 5000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        agentVersion: "0.1.14",
        buildSha: "development",
        capabilities: [
          "artifactRetention",
          "buildArgs",
          "buildGuardrails",
          "continuousHealth",
          "managedIngress",
          "managedRedis",
          "nodeCapacity",
          "nodeDiskMetrics",
          "nodeMaintenance",
          "persistentVolumes",
          "privateNetworking",
          "resourceGuardrails",
          "runtimeMetrics",
          "runtimeRecovery",
          "safePromotion",
        ],
      }));
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

const tokenWorkspace = await createWorkspace("token");
const tokenCreate = await createNode(tokenWorkspace.id, "one-time-token-node");
const bootstrapToken = tokenCreate.body.token;
if (!bootstrapToken) throw new Error("node creation did not return bootstrap credential");
if (!String(tokenCreate.response.headers.get("cache-control") ?? "").toLowerCase().includes("no-store")) {
  throw new Error("bootstrap credential response is cacheable");
}
if (String(tokenCreate.response.headers.get("pragma") ?? "").toLowerCase() !== "no-cache") {
  throw new Error("bootstrap credential response is missing pragma no-cache");
}

const firstRead = await request(`/v0/workspaces/${tokenWorkspace.id}/nodes?includeArchived=true`);
if (JSON.stringify(firstRead.body).includes(bootstrapToken) || "token" in firstRead.body.nodes[0]) {
  throw new Error("bootstrap credential was returned by node read API");
}

const permanentToken = randomBytes(32).toString("hex");
await exchange(tokenCreate.body.id, bootstrapToken, permanentToken);

const replay = await fetch(`${api}/v0/nodes/${tokenCreate.body.id}/bootstrap/exchange`, {
  method: "POST",
  headers: { authorization: `Bearer ${bootstrapToken}`, "content-type": "application/json" },
  body: JSON.stringify({ agentToken: randomBytes(32).toString("hex") }),
});
if (replay.status !== 401) throw new Error(`consumed bootstrap credential replay status=${replay.status}`);

const afterExchange = await request(`/v0/workspaces/${tokenWorkspace.id}/nodes?includeArchived=true`);
const readJson = JSON.stringify(afterExchange.body);
if (readJson.includes(bootstrapToken) || readJson.includes(permanentToken)) {
  throw new Error("node read API echoed a bootstrap or permanent credential");
}

const archive = await request(`/v0/nodes/${tokenCreate.body.id}/archive`, { method: "POST" });
if (archive.body.lifecycleStatus !== "ARCHIVED") throw new Error("offline credential test node was not archived");

const revoked = await fetch(`${api}/v0/nodes/${tokenCreate.body.id}/self/status`, {
  headers: { authorization: `Bearer ${permanentToken}` },
});
if (revoked.status !== 401) throw new Error(`archived node credential still authenticates: ${revoked.status}`);

const logWorkspace = await createWorkspace("logredact");
const project = (await request(`/v0/workspaces/${logWorkspace.id}/projects`, {
  method: "POST",
  body: JSON.stringify({ slug: "secure-project", name: "Secure Project" }),
})).body;
const service = (await request(`/v0/projects/${project.id}/services`, {
  method: "POST",
  body: JSON.stringify({ slug: "secure-service", name: "Secure Service" }),
})).body;
const logNodeCreate = await createNode(logWorkspace.id, "log-redaction-node");
const logPermanentToken = randomBytes(32).toString("hex");
await exchange(logNodeCreate.body.id, logNodeCreate.body.token, logPermanentToken);

const runtimeSecret = "runtime-secret-" + randomBytes(12).toString("hex");
await request(`/v0/services/${service.id}/config/variables`, {
  method: "PUT",
  body: JSON.stringify({ variables: [{ key: "ACCEPTANCE_SECRET", value: runtimeSecret, secret: true }] }),
});

const socket = await connectFakeAgent(logNodeCreate.body.id, logPermanentToken);
try {
  await waitForNode(logWorkspace.id, logNodeCreate.body.id, (node) => node.status === "ONLINE");

  const deployment = (await request(`/v0/services/${service.id}/deployments`, {
    method: "POST",
    body: JSON.stringify({
      nodeId: logNodeCreate.body.id,
      sourceRepository: "https://github.com/annetbg-wq/rundea-runtime-fixture.git",
      sourceRef: fixtureSha,
      sourceDelivery: "DIRECT",
      containerPort: 8080,
      healthcheckPath: "/health",
    }),
  })).body;

  const tokenShape = "github_pat_" + "a".repeat(30);
  const bearerShape = "Bearer " + "b".repeat(32);
  const urlPassword = "redis://default:credential-in-url@redis:6379/0";
  socket.send(JSON.stringify({
    type: "log",
    deploymentId: deployment.id,
    stream: "runtime",
    message: `secret=${runtimeSecret} token=${tokenShape} auth=${bearerShape} url=${urlPassword}`,
    at: new Date().toISOString(),
  }));

  const { found, events } = await waitForEvent(
    deployment.id,
    (event) => event.kind === "LOG" && String(event.message ?? "").includes("[REDACTED]"),
  );
  const serialized = JSON.stringify(events);
  for (const forbidden of [runtimeSecret, tokenShape, "b".repeat(32), "credential-in-url"]) {
    if (serialized.includes(forbidden)) throw new Error(`stored/read log leaked credential fragment: ${forbidden}`);
  }
  if (!String(found.message).includes("[REDACTED]")) throw new Error("redaction marker missing from persisted log");
} finally {
  socket.close();
}

console.log(JSON.stringify({
  ok: true,
  verified: [
    "bootstrap-token-display-response-no-store",
    "bootstrap-token-never-returned-by-read-api",
    "bootstrap-token-single-use-exchange",
    "permanent-node-token-never-returned-by-read-api",
    "archived-node-token-revoked",
    "submitted-runtime-secret-redacted-before-log-persistence",
    "provider-token-shapes-redacted-before-log-persistence",
    "credential-url-password-redacted-before-log-persistence",
  ],
}, null, 2));
