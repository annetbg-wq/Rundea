import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { Pool } from "pg";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const databaseUrl = process.env.RUNDEA_ACCEPTANCE_DATABASE_URL ?? "postgres://rundea:rundea@127.0.0.1:5432/rundea";
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const db = new Pool({ connectionString: databaseUrl });
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const fixtureSha = "039c34770852fb07cef7f9f0f8534c5de408b207";
const fixtureRepositoryFullName = "render-examples/express-hello-world";
const fixtureRepository = `https://github.com/${fixtureRepositoryFullName}.git`;

const requiredCapabilities = [
  "artifactRetention",
  "buildArgs",
  "buildGuardrails",
  "continuousHealth",
  "managedIngress",
  "managedRedis",
  "nodeCapacity",
  "nodeDiskMetrics",
  "persistentVolumes",
  "privateNetworking",
  "resourceGuardrails",
  "runtimeMetrics",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawRequest(path, init = {}) {
  const response = await fetch(api + path, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}

async function request(path, init = {}) {
  const result = await rawRequest(path, init);
  if (!result.response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${result.response.status}: ${result.text}`);
  }
  return result.body;
}

async function poll(label, fn, timeoutMs = 15000, intervalMs = 150) {
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

function wsUrl() {
  return api.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/v0/agent/ws";
}

async function connectAgent(nodeId, token, hello) {
  const received = [];
  let closeInfo = null;
  const socket = new WebSocket(wsUrl(), {
    headers: {
      authorization: `Bearer ${token}`,
      "x-rundea-node-id": nodeId,
    },
  });
  socket.on("message", (data) => {
    try { received.push(JSON.parse(String(data))); } catch { received.push(String(data)); }
  });
  socket.on("close", (code, reason) => {
    closeInfo = { code, reason: String(reason) };
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Agent websocket open timeout")), 5000);
    socket.once("error", reject);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.send(JSON.stringify(hello));
      resolve();
    });
  });
  return { socket, received, getCloseInfo: () => closeInfo };
}

async function createWorkspace(name) {
  return request("/v0/workspaces", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `${name}-${suffix}`.slice(0, 63), name }),
  });
}

async function createProject(workspaceId, slug, name) {
  return request(`/v0/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `${slug}-${suffix}`.slice(0, 63), name }),
  });
}

async function createService(projectId, slug, name) {
  return request(`/v0/projects/${projectId}/services`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug, name }),
  });
}

async function createNode(workspaceId, name) {
  return request(`/v0/workspaces/${workspaceId}/nodes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
}

async function nodeState(workspaceId, nodeId, includeArchived = true) {
  const body = await request(
    `/v0/workspaces/${workspaceId}/nodes?includeArchived=${includeArchived ? "true" : "false"}`,
    { headers },
  );
  return body.nodes.find((node) => node.id === nodeId);
}

async function createDeployment(serviceId) {
  return request(`/v0/services/${serviceId}/deployments`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      sourceRepository: fixtureRepository,
      sourceRef: fixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      healthcheckPath: "/",
    }),
  });
}

async function installSourceConfig(projectId, serviceId, path) {
  await db.query(
    `INSERT INTO service_source_configs(
       service_id,project_id,repository_full_name,selected_branch,revision_sha,source_path,dockerfile,
       container_port,healthcheck_path,build_variable_names,runtime_variable_names
     ) VALUES($1,$2,$3,'main',$4,$5,NULL,3001,'/','[]'::jsonb,'[]'::jsonb)`,
    [serviceId, projectId, fixtureRepositoryFullName, fixtureSha, path],
  );
}

async function sendMetric(socket, deploymentId, cpuPercent) {
  socket.send(JSON.stringify({
    type: "metric",
    deploymentId,
    cpuPercent,
    memoryUsageBytes: 1024 * 1024,
    memoryLimitBytes: 256 * 1024 * 1024,
    networkRxBytes: cpuPercent * 10,
    networkTxBytes: cpuPercent * 20,
    at: new Date().toISOString(),
  }));
}

let goodSocket;
let incompatibleSocket;
try {
  const workspace = await createWorkspace("Foundation Gate");

  // Prove stale/duplicate node archive is fail-closed and excluded from selection.
  const staleNode = await createNode(workspace.id, "foundation-node");
  const archived = await request(`/v0/nodes/${staleNode.id}/archive`, { method: "POST", headers });
  assert.equal(archived.lifecycleStatus, "ARCHIVED");
  assert.equal(archived.status, "OFFLINE");

  // Intentionally incompatible Agent: authenticate successfully, then fail capability admission.
  const incompatibleNode = await createNode(workspace.id, "incompatible-node");
  const incompatibleToken = await activateNodeCredential(api, incompatibleNode.id, incompatibleNode.token);
  const incompatible = await connectAgent(incompatibleNode.id, incompatibleToken, {
    type: "hello",
    agentVersion: "0.1.14",
    buildSha: "development",
    capabilities: requiredCapabilities.filter((value) => value !== "managedRedis"),
  });
  incompatibleSocket = incompatible.socket;

  await poll("incompatible Agent rejection", async () => {
    const row = await nodeState(workspace.id, incompatibleNode.id);
    if (row?.status === "OFFLINE" && String(row.compatibilityError ?? "").includes("managedRedis")) {
      return { done: true, value: row };
    }
    return { last: row };
  });
  await poll("incompatible Agent websocket close", async () => {
    const info = incompatible.getCloseInfo();
    return info ? { done: true, value: info } : { last: "still open" };
  });
  assert.equal(incompatible.received.some((message) => message?.type === "deploy"), false, "incompatible Agent received a deployment");

  // Compatible Agent becomes the only dispatch-ready node in this workspace.
  const goodNode = await createNode(workspace.id, "foundation-node");
  const goodToken = await activateNodeCredential(api, goodNode.id, goodNode.token);
  const good = await connectAgent(goodNode.id, goodToken, {
    type: "hello",
    agentVersion: "0.1.14",
    buildSha: "development",
    capabilities: requiredCapabilities,
  });
  goodSocket = good.socket;
  await poll("compatible Agent ONLINE", async () => {
    const row = await nodeState(workspace.id, goodNode.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row };
  });

  const projectA = await createProject(workspace.id, "alpha", "Alpha");
  const projectB = await createProject(workspace.id, "bravo", "Bravo");
  const serviceA = await createService(projectA.id, "api", "api");
  const serviceB = await createService(projectB.id, "api", "api");
  assert.notEqual(serviceA.id, serviceB.id);

  // Same key, same human service name, different projects: values must remain isolated.
  await Promise.all([
    request(`/v0/services/${serviceA.id}/config/variables`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ variables: [{ key: "PROJECT_MARKER", value: "alpha", secret: false }] }),
    }),
    request(`/v0/services/${serviceB.id}/config/variables`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ variables: [{ key: "PROJECT_MARKER", value: "bravo", secret: false }] }),
    }),
  ]);
  const [variablesA, variablesB] = await Promise.all([
    request(`/v0/services/${serviceA.id}/config/variables`, { headers }),
    request(`/v0/services/${serviceB.id}/config/variables`, { headers }),
  ]);
  assert.deepEqual(variablesA.variables, [{ key: "PROJECT_MARKER", secret: false, value: "alpha" }]);
  assert.deepEqual(variablesB.variables, [{ key: "PROJECT_MARKER", secret: false, value: "bravo" }]);

  // Concurrent canonical deploy requests must select the compatible ACTIVE node and reserve distinct ports.
  const [deploymentA, deploymentB] = await Promise.all([
    createDeployment(serviceA.id),
    createDeployment(serviceB.id),
  ]);
  assert.equal(deploymentA.nodeId, goodNode.id);
  assert.equal(deploymentB.nodeId, goodNode.id);
  assert.notEqual(deploymentA.nodeId, staleNode.id);
  assert.notEqual(deploymentA.nodeId, incompatibleNode.id);

  const portRows = await db.query(
    "SELECT id,service_id,node_id,host_port FROM deployments WHERE id=ANY($1::uuid[]) ORDER BY id",
    [[deploymentA.id, deploymentB.id]],
  );
  assert.equal(portRows.rowCount, 2);
  const ports = portRows.rows.map((row) => Number(row.host_port));
  assert.equal(new Set(ports).size, 2, `managed host port collision: ${ports.join(",")}`);
  for (const port of ports) assert.ok(port >= 18000 && port <= 29999);

  // Promote only inside the acceptance database so domain/metric read paths can be proven without building fixture images.
  await db.query(
    "UPDATE deployments SET status='READY',runtime_health='HEALTHY',updated_at=now() WHERE id=ANY($1::uuid[])",
    [[deploymentA.id, deploymentB.id]],
  );

  const [deploymentsA, deploymentsB] = await Promise.all([
    request(`/v0/services/${serviceA.id}/deployments`, { headers }),
    request(`/v0/services/${serviceB.id}/deployments`, { headers }),
  ]);
  assert.deepEqual(deploymentsA.deployments.map((row) => row.id), [deploymentA.id]);
  assert.deepEqual(deploymentsB.deployments.map((row) => row.id), [deploymentB.id]);
  assert.equal(deploymentsA.deployments[0].service_id, serviceA.id);
  assert.equal(deploymentsB.deployments[0].service_id, serviceB.id);

  // Canonical autodeploy is keyed by service_id, not the shared human name "api".
  await Promise.all([
    installSourceConfig(projectA.id, serviceA.id, "."),
    installSourceConfig(projectB.id, serviceB.id, "."),
  ]);
  await Promise.all([
    request(`/v0/services/${serviceA.id}/push-autodeploy`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    }),
    request(`/v0/services/${serviceB.id}/push-autodeploy`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    }),
  ]);
  const [autodeployA, autodeployB] = await Promise.all([
    request(`/v0/services/${serviceA.id}/push-autodeploy`, { headers }),
    request(`/v0/services/${serviceB.id}/push-autodeploy`, { headers }),
  ]);
  assert.equal(autodeployA.autodeploy.serviceId, serviceA.id);
  assert.equal(autodeployB.autodeploy.serviceId, serviceB.id);
  const autodeployRows = await db.query(
    "SELECT service_id,host_port FROM service_autodeploys WHERE service_id=ANY($1::uuid[]) ORDER BY service_id",
    [[serviceA.id, serviceB.id]],
  );
  assert.equal(autodeployRows.rowCount, 2);

  // Domains remain service scoped even though both services are named api.
  const [domainA, domainB] = await Promise.all([
    request(`/v0/services/${serviceA.id}/domains`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ hostname: `alpha-${suffix}.example.test` }),
    }),
    request(`/v0/services/${serviceB.id}/domains`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ hostname: `bravo-${suffix}.example.test` }),
    }),
  ]);
  assert.equal(domainA.service_id, serviceA.id);
  assert.equal(domainB.service_id, serviceB.id);
  const [domainsA, domainsB] = await Promise.all([
    request(`/v0/services/${serviceA.id}/domains`, { headers }),
    request(`/v0/services/${serviceB.id}/domains`, { headers }),
  ]);
  assert.deepEqual(domainsA.domains.map((row) => row.id), [domainA.id]);
  assert.deepEqual(domainsB.domains.map((row) => row.id), [domainB.id]);

  // Metrics are accepted only for this authenticated node/deployment and remain isolated per immutable deployment.
  await sendMetric(goodSocket, deploymentA.id, 11);
  await sleep(150);
  await sendMetric(goodSocket, deploymentB.id, 22);
  const [metricsA, metricsB] = await Promise.all([
    poll("service A metric", async () => {
      const body = await request(`/v0/deployments/${deploymentA.id}/metrics?minutes=5`, { headers });
      return body.latest ? { done: true, value: body } : { last: body };
    }),
    poll("service B metric", async () => {
      const body = await request(`/v0/deployments/${deploymentB.id}/metrics?minutes=5`, { headers });
      return body.latest ? { done: true, value: body } : { last: body };
    }),
  ]);
  assert.equal(metricsA.latest.cpuPercent, 11);
  assert.equal(metricsB.latest.cpuPercent, 22);

  const archivedAfter = await nodeState(workspace.id, staleNode.id, true);
  assert.equal(archivedAfter.lifecycleStatus, "ARCHIVED");
  const incompatibleAfter = await nodeState(workspace.id, incompatibleNode.id, true);
  assert.equal(incompatibleAfter.status, "OFFLINE");
  assert.ok(String(incompatibleAfter.compatibilityError ?? "").includes("managedRedis"));

  console.log(JSON.stringify({
    ok: true,
    workspaceId: workspace.id,
    services: [serviceA.id, serviceB.id],
    nodeId: goodNode.id,
    archivedNodeId: staleNode.id,
    incompatibleNodeId: incompatibleNode.id,
    ports,
    verified: [
      "same-name-service-variable-isolation",
      "same-name-service-deployment-isolation",
      "same-name-service-domain-isolation",
      "same-name-service-autodeploy-isolation",
      "same-name-service-metric-isolation",
      "incompatible-agent-not-dispatch-ready",
      "incompatible-agent-received-no-deploy-command",
      "concurrent-managed-port-reservations-do-not-collide",
      "archived-stale-node-excluded-from-auto-selection",
      "automatic-selection-uses-compatible-active-online-node",
    ],
  }, null, 2));
} finally {
  for (const socket of [goodSocket, incompatibleSocket]) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  }
  await db.end().catch(() => undefined);
}
