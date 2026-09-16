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
const workDir = await mkdtemp(join(tmpdir(), "rundea-volume-acceptance-"));
const marker = `persistent-${suffix}`;
let agent;
let dockerVolumeName = "";
const backendContainers = new Set();

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

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return (result.stdout ?? "").trim();
}

function backendFor(deploymentId) {
  const names = docker([
    "ps", "-a",
    "--filter", "label=rundea.managed=true",
    "--filter", `label=rundea.deployment=${deploymentId}`,
    "--filter", "label=rundea.backend=true",
    "--format", "{{.Names}}",
  ]).split("\n").map((value) => value.trim()).filter(Boolean);
  if (names.length !== 1) throw new Error(`expected exactly one backend for ${deploymentId}, found ${names.length}: ${names.join(",")}`);
  backendContainers.add(names[0]);
  return names[0];
}

function readMarker(containerName) {
  return docker(["exec", containerName, "node", "-e", "process.stdout.write(require('fs').readFileSync('/data/rundea-marker','utf8'))"]);
}

async function serviceDeployment(serviceId, deploymentId) {
  const body = await request(`/v0/services/${serviceId}/deployments`, { headers });
  return body.deployments.find((item) => item.id === deploymentId);
}

async function waitReady(serviceId, deploymentId, label) {
  return poll(label, async () => {
    const row = await serviceDeployment(serviceId, deploymentId);
    if (!row) return { last: "missing from canonical service scope" };
    if (row.status === "READY") return { done: true, value: row };
    if (["FAILED", "CANCELLED"].includes(row.status)) throw new FatalPollError(`${deploymentId} reached ${row.status}`);
    return { last: row.status };
  });
}

async function createDeployment(serviceId, nodeId) {
  return request(`/v0/services/${serviceId}/deployments`, {
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
}

try {
  const workspace = await request("/v0/workspaces", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `pv-${suffix}`.slice(0, 63), name: "Persistent volume acceptance" }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `pv-project-${suffix}`.slice(0, 63), name: "Persistent volume project" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `pv-service-${suffix}`.slice(0, 63), name: `persistent-${suffix}`.slice(0, 80) }),
  });
  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `pv-node-${process.pid}` }),
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

  await poll("persistent-volume Agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited before ONLINE with code ${agent.exitCode}`);
    const body = await request(`/v0/workspaces/${workspace.id}/nodes`, { headers });
    const row = body.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.compatibilityError ?? row?.status ?? "missing" };
  }, 45_000, 500);

  const volume = await request(`/v0/services/${service.id}/volumes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: "data", mountPath: "/data" }),
  });
  if (volume.nodeId !== null) throw new Error(`new pre-deploy volume should not yet be node-pinned: ${JSON.stringify(volume)}`);

  const first = await createDeployment(service.id, node.id);
  const firstReady = await waitReady(service.id, first.id, "first stateful deployment READY");
  if (firstReady.service_id !== service.id) throw new Error(`first deployment escaped canonical service scope: ${firstReady.service_id}`);

  const volumesAfterFirst = await request(`/v0/services/${service.id}/volumes`, { headers });
  const bound = volumesAfterFirst.volumes.find((item) => item.id === volume.id);
  if (bound?.nodeId !== node.id) throw new Error(`persistent volume was not pinned to deployment node: ${JSON.stringify(bound)}`);

  dockerVolumeName = docker([
    "volume", "ls", "--quiet",
    "--filter", "label=rundea.managed=true",
    "--filter", `label=rundea.volume=${volume.id}`,
  ]);
  if (!dockerVolumeName) throw new Error("Rundea-owned Docker volume was not created");

  const firstContainer = backendFor(first.id);
  const mountedName = docker(["inspect", "--format", "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Name}}{{end}}{{end}}", firstContainer]);
  if (mountedName !== dockerVolumeName) throw new Error(`first backend mounted unexpected volume ${mountedName}`);
  docker(["exec", firstContainer, "node", "-e", `require('fs').writeFileSync('/data/rundea-marker',${JSON.stringify(marker)})`]);
  if (readMarker(firstContainer) !== marker) throw new Error("marker write did not persist in first backend");

  const second = await createDeployment(service.id, node.id);
  await waitReady(service.id, second.id, "stateful redeployment READY");
  const secondContainer = backendFor(second.id);
  if (readMarker(secondContainer) !== marker) throw new Error("persistent data did not survive redeploy");

  const restart = await request(`/v0/deployments/${second.id}/restart`, { method: "POST", headers });
  await poll("stateful runtime restart succeeds", async () => {
    const body = await request("/v0/runtime-actions", { headers });
    const action = body.actions.find((item) => item.id === restart.id);
    if (action?.status === "FAILED") throw new FatalPollError(`restart failed: ${action.error ?? "unknown"}`);
    return action?.status === "SUCCEEDED" ? { done: true, value: action } : { last: action?.status ?? "missing" };
  }, 90_000, 500);
  if (readMarker(secondContainer) !== marker) throw new Error("persistent data did not survive runtime restart");

  const rollback = await request(`/v0/deployments/${first.id}/rollback`, { method: "POST", headers });
  const rollbackReady = await waitReady(service.id, rollback.id, "stateful rollback READY");
  if (rollbackReady.service_id !== service.id) {
    throw new Error(`rollback lost canonical service_id: expected ${service.id}, got ${rollbackReady.service_id}`);
  }
  if (rollbackReady.rollback_target_id !== first.id) throw new Error("rollback target identity changed");
  const rollbackContainer = backendFor(rollback.id);
  if (readMarker(rollbackContainer) !== marker) throw new Error("persistent data did not survive rollback");
  const rollbackMountedName = docker(["inspect", "--format", "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Name}}{{end}}{{end}}", rollbackContainer]);
  if (rollbackMountedName !== dockerVolumeName) throw new Error(`rollback mounted a different volume: ${rollbackMountedName}`);

  await request(`/v0/services/${service.id}/archive`, { method: "POST", headers });
  const stillPresent = docker(["volume", "ls", "--quiet", "--filter", `name=^${dockerVolumeName}$`]);
  if (stillPresent !== dockerVolumeName) throw new Error("normal service archive destructively removed persistent volume");

  console.log(JSON.stringify({
    ok: true,
    serviceId: service.id,
    nodeId: node.id,
    volumeId: volume.id,
    dockerVolumeName,
    deployments: { first: first.id, second: second.id, rollback: rollback.id },
    verified: [
      "canonical-service-volume",
      "node-pinning",
      "rundea-owned-docker-volume",
      "same-volume-after-redeploy",
      "data-survives-redeploy",
      "data-survives-restart",
      "rollback-preserves-service-id",
      "same-volume-after-rollback",
      "data-survives-rollback",
      "service-archive-does-not-delete-volume",
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
  if (dockerVolumeName) spawnSync("docker", ["volume", "rm", "-f", dockerVolumeName], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}