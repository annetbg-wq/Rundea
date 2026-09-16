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

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-private-network-acceptance-"));
const backendContainers = new Set();
const networks = new Set();
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

async function poll(label, fn, timeoutMs = 240_000, intervalMs = 750) {
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

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function expectedNetwork(projectId) {
  return `rundea-project-${projectId.replaceAll("-", "").toLowerCase()}`;
}

function backendFor(deploymentId) {
  const result = docker([
    "ps", "-a",
    "--filter", "label=rundea.managed=true",
    "--filter", `label=rundea.deployment=${deploymentId}`,
    "--filter", "label=rundea.backend=true",
    "--format", "{{.Names}}",
  ]).stdout;
  const names = result.split("\n").map((value) => value.trim()).filter(Boolean);
  if (names.length !== 1) throw new Error(`expected exactly one backend for ${deploymentId}, found ${names.length}: ${names.join(",")}`);
  backendContainers.add(names[0]);
  return names[0];
}

function containerNetworks(containerName) {
  const raw = docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerName]).stdout;
  return JSON.parse(raw);
}

function assertOwnedNetwork(projectId) {
  const name = expectedNetwork(projectId);
  networks.add(name);
  const labels = docker([
    "network", "inspect", "--format",
    '{{ index .Labels "rundea.managed" }}|{{ index .Labels "rundea.kind" }}|{{ index .Labels "rundea.project" }}',
    name,
  ]).stdout;
  if (labels !== `true|project-network|${projectId.toLowerCase()}`) {
    throw new Error(`unexpected ownership labels for ${name}: ${labels}`);
  }
  return name;
}

async function waitReady(serviceId, deploymentId, label) {
  return poll(label, async () => {
    const body = await request(`/v0/services/${serviceId}/deployments`, { headers });
    const row = body.deployments.find((item) => item.id === deploymentId);
    if (!row) return { last: "missing" };
    if (row.status === "READY") return { done: true, value: row };
    if (["FAILED", "CANCELLED"].includes(row.status)) throw new FatalPollError(`${deploymentId} reached ${row.status}`);
    return { last: row.status };
  });
}

async function deploy(serviceId, nodeId) {
  const deployment = await request(`/v0/services/${serviceId}/deployments`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      nodeId,
      sourceRepository: fixtureRepository,
      sourceRef: fixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      healthcheckPath: "/",
    }),
  });
  await waitReady(serviceId, deployment.id, `${serviceId} READY`);
  return deployment;
}

try {
  const workspace = await request("/v0/workspaces", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `net-${suffix}`.slice(0, 63), name: "Private network acceptance" }),
  });
  const projectA = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `net-a-${suffix}`.slice(0, 63), name: "Private network project A" }),
  });
  const projectB = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `net-b-${suffix}`.slice(0, 63), name: "Private network project B" }),
  });
  const apiA = await request(`/v0/projects/${projectA.id}/services`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: "api", name: `api-a-${suffix}`.slice(0, 80) }),
  });
  const workerA = await request(`/v0/projects/${projectA.id}/services`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: "worker", name: `worker-a-${suffix}`.slice(0, 80) }),
  });
  const apiB = await request(`/v0/projects/${projectB.id}/services`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: "api", name: `api-b-${suffix}`.slice(0, 80) }),
  });
  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `network-node-${process.pid}` }),
  });
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

  await poll("private-network Agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited before ONLINE with code ${agent.exitCode}`);
    const body = await request(`/v0/workspaces/${workspace.id}/nodes`, { headers });
    const row = body.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.compatibilityError ?? row?.status ?? "missing" };
  }, 45_000, 500);

  const apiADeployment = await deploy(apiA.id, node.id);
  const workerADeployment = await deploy(workerA.id, node.id);
  const apiBDeployment = await deploy(apiB.id, node.id);

  const apiAContainer = backendFor(apiADeployment.id);
  const workerAContainer = backendFor(workerADeployment.id);
  const apiBContainer = backendFor(apiBDeployment.id);
  const networkA = assertOwnedNetwork(projectA.id);
  const networkB = assertOwnedNetwork(projectB.id);
  if (networkA === networkB) throw new Error("different projects resolved to the same Docker network");

  const apiANetworks = containerNetworks(apiAContainer);
  const workerANetworks = containerNetworks(workerAContainer);
  const apiBNetworks = containerNetworks(apiBContainer);
  if (!apiANetworks[networkA] || !workerANetworks[networkA]) throw new Error("same-project services do not share the project network");
  if (apiANetworks[networkB] || workerANetworks[networkB]) throw new Error("project A backend leaked into project B network");
  if (!apiBNetworks[networkB] || apiBNetworks[networkA]) throw new Error("project B backend network isolation failed");

  const apiAIp = apiANetworks[networkA].IPAddress;
  const resolvedApiFromWorker = docker([
    "exec", workerAContainer, "node", "-e",
    "require('dns').lookup('api',(e,a)=>{if(e){console.error(e);process.exit(2)}process.stdout.write(a)})",
  ]).stdout;
  if (!apiAIp || resolvedApiFromWorker !== apiAIp) {
    throw new Error(`same-project Docker DNS mismatch: expected ${apiAIp}, got ${resolvedApiFromWorker}`);
  }

  const crossProjectLookup = docker([
    "exec", apiBContainer, "node", "-e",
    "require('dns').lookup('worker',(e)=>process.exit(e?0:3))",
  ], { allowFailure: true });
  if (crossProjectLookup.status !== 0) {
    throw new Error("project B resolved project A service alias; private network isolation failed");
  }

  const published = docker(["port", apiAContainer, "3001/tcp"]).stdout;
  if (!published.startsWith("127.0.0.1:")) throw new Error(`ingress publication escaped loopback: ${published}`);

  console.log(JSON.stringify({
    ok: true,
    nodeId: node.id,
    projectA: { id: projectA.id, network: networkA, services: ["api", "worker"] },
    projectB: { id: projectB.id, network: networkB, services: ["api"] },
    verified: [
      "rundea-owned-project-networks",
      "same-project-shared-network",
      "service-slug-dns-discovery",
      "cross-project-network-isolation",
      "cross-project-dns-isolation",
      "public-runtime-port-remains-loopback-only",
    ],
  }, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  for (const container of backendContainers) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  spawnSync("docker", ["rm", "-f", "rundea-runtime-router"], { stdio: "ignore" });
  for (const network of networks) spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}
