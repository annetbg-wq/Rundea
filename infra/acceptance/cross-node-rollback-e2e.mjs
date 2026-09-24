import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4020";
const token = process.env.RUNDEA_CONTROL_TOKEN;
const databaseUrl = process.env.RUNDEA_ACCEPTANCE_DATABASE_URL;
const builderToken = process.env.RUNDEA_BUILDER_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const sourceSha = process.env.RUNDEA_ACCEPTANCE_SOURCE_SHA?.trim().toLowerCase();
const registryPort = Number(process.env.RUNDEA_BUILD_REGISTRY_PORT ?? "15012");

if (!token) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!databaseUrl) throw new Error("RUNDEA_ACCEPTANCE_DATABASE_URL is required");
if (!builderToken) throw new Error("RUNDEA_BUILDER_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("RUNDEA_ACCEPTANCE_SOURCE_SHA must be a full Git SHA");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const registryName = `rundea-cross-node-registry-${suffix}`;
const agentAWork = await mkdtemp(join(tmpdir(), "rundea-agent-a-"));
const agentBWork = await mkdtemp(join(tmpdir(), "rundea-agent-b-"));
let agentA;
let agentB;
let builder;
let targetDeploymentId = "";
let currentDeploymentId = "";
let rollbackDeploymentId = "";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding:"utf8", ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout ?? "").trim();
}

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

async function poll(label, fn, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result?.done) return result.value;
    last = result?.last ?? last;
    await sleep(750);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => proc.once("exit", resolve)), sleep(3000)]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

async function createNode(workspaceId, name, workDir) {
  const node = await request(`/v0/workspaces/${workspaceId}/nodes`, {
    method:"POST",
    body:JSON.stringify({ name }),
  });
  const permanentToken = await activateNodeCredential(api, node.id, node.token);
  const proc = spawn(agentBinary, [], {
    stdio:["ignore","inherit","inherit"],
    env:{
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL:api,
      RUNDEA_NODE_ID:node.id,
      RUNDEA_NODE_TOKEN:permanentToken,
      RUNDEA_WORK_DIR:workDir,
      RUNDEA_METRICS_INTERVAL:"2s",
    },
  });
  await poll(`${name} online`, async () => {
    if (proc.exitCode !== null) throw new Error(`${name} exited with code ${proc.exitCode}`);
    const body = await request(`/v0/workspaces/${workspaceId}/nodes`);
    const row = body.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done:true, value:row } : { last:row?.status ?? "missing" };
  }, 45000);
  return { node, proc };
}

async function queueBuild(serviceId) {
  const queued = await request(`/v0/services/${serviceId}/builds`, {
    method:"POST",
    body:JSON.stringify({ revisionSha:sourceSha, deployAfterPush:true }),
  });
  return queued.build.id;
}

async function waitBuildDeployment(serviceId, buildId) {
  return poll("build handoff", async () => {
    const body = await request(`/v0/services/${serviceId}/builds`);
    const row = body.builds.find((item) => item.id === buildId);
    if (!row) return { last:"missing build" };
    if (row.status === "FAILED") throw new Error(`build failed: ${row.error}`);
    return row.status === "PUSHED" && row.deployment_id ? { done:true, value:row } : { last:{status:row.status,deploymentId:row.deployment_id} };
  }, 240000);
}

async function waitReady(serviceId, deploymentId) {
  return poll("deployment READY", async () => {
    const body = await request(`/v0/services/${serviceId}/deployments`);
    const row = body.deployments.find((item) => item.id === deploymentId);
    if (!row) return { last:"missing deployment" };
    if (row.status === "FAILED") throw new Error(`deployment failed: ${JSON.stringify(row)}`);
    return row.status === "READY" ? { done:true, value:row } : { last:row.status };
  }, 180000);
}

try {
  docker(["run","-d","--name",registryName,"-p",`127.0.0.1:${registryPort}:5000`,"registry:2"]);
  await poll("cross-node registry", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${registryPort}/v2/`);
      return response.ok ? { done:true, value:true } : { last:response.status };
    } catch (error) {
      return { last:error instanceof Error ? error.message : String(error) };
    }
  }, 30000);

  const workspace = await request("/v0/workspaces", {
    method:"POST",
    body:JSON.stringify({ slug:`rollback-${Date.now().toString(36)}`.slice(0,63), name:`Cross Node Rollback ${suffix}` }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method:"POST",
    body:JSON.stringify({ slug:"rollback", name:"Rollback" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method:"POST",
    body:JSON.stringify({ slug:"rollback-app", name:"rollback-app" }),
  });

  const first = await createNode(workspace.id, `rollback-a-${suffix}`, agentAWork);
  agentA = first.proc;

  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query(
      `INSERT INTO service_source_configs(
         service_id,project_id,repository_full_name,selected_branch,revision_sha,source_path,dockerfile,
         container_port,healthcheck_path,build_variable_names,runtime_variable_names
       ) VALUES($1,$2,'annetbg-wq/Rundea','main',$3,'infra/acceptance/build-fixture','Dockerfile',80,'/','[]'::jsonb,'[]'::jsonb)`,
      [service.id, project.id, sourceSha],
    );
  } finally {
    await db.end();
  }

  await request(`/v0/services/${service.id}/push-autodeploy`, {
    method:"PUT",
    body:JSON.stringify({ nodeId:first.node.id, enabled:true }),
  });

  builder = spawn("npx", ["tsx","apps/builder/src/index.ts"], {
    stdio:["ignore","inherit","inherit"],
    env:{
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL:api,
      RUNDEA_BUILDER_TOKEN:builderToken,
      RUNDEA_BUILDER_ID:`cross-node-${suffix}`,
      RUNDEA_BUILD_POLL_MS:"250",
      RUNDEA_BUILD_TIMEOUT_SECONDS:"180",
      RUNDEA_BUILD_MEMORY_BYTES:"1073741824",
      RUNDEA_BUILD_CPU_QUOTA:"100000",
      RUNDEA_BUILD_CPU_PERIOD:"100000",
    },
  });

  const targetBuildId = await queueBuild(service.id);
  const targetBuild = await waitBuildDeployment(service.id, targetBuildId);
  targetDeploymentId = targetBuild.deployment_id;
  const target = await waitReady(service.id, targetDeploymentId);
  if (!target.artifact_image_ref || !/@sha256:[0-9a-f]{64}$/.test(target.artifact_image_ref)) {
    throw new Error(`target deployment has no immutable registry artifact: ${JSON.stringify(target)}`);
  }

  await stop(agentA);
  agentA = null;
  for (const id of docker(["ps","-aq","--filter",`label=rundea.deployment=${targetDeploymentId}`]).split(/\s+/).filter(Boolean)) {
    spawnSync("docker",["rm","-f",id],{stdio:"ignore"});
  }
  spawnSync("docker",["rm","-f","rundea-runtime-router"],{stdio:"ignore"});

  const second = await createNode(workspace.id, `rollback-b-${suffix}`, agentBWork);
  agentB = second.proc;
  await request(`/v0/services/${service.id}/push-autodeploy`, {
    method:"PUT",
    body:JSON.stringify({ nodeId:second.node.id, enabled:true }),
  });

  const currentBuildId = await queueBuild(service.id);
  const currentBuild = await waitBuildDeployment(service.id, currentBuildId);
  currentDeploymentId = currentBuild.deployment_id;
  const current = await waitReady(service.id, currentDeploymentId);
  if (current.node_id !== second.node.id) throw new Error(`current deployment landed on wrong node: ${JSON.stringify(current)}`);

  const afterMove = await request(`/v0/services/${service.id}/deployments`);
  const historicalTarget = afterMove.deployments.find((item) => item.id === targetDeploymentId);
  if (historicalTarget?.status !== "ROLLED_BACK") {
    throw new Error(`target was not superseded after node migration: ${JSON.stringify(historicalTarget)}`);
  }

  spawnSync("docker",["image","rm","-f",`rundea/${targetDeploymentId.toLowerCase()}:build`],{stdio:"ignore"});

  const rollback = await request(`/v0/deployments/${targetDeploymentId}/rollback`, { method:"POST" });
  rollbackDeploymentId = rollback.id;

  const rolledBack = await waitReady(service.id, rollbackDeploymentId);
  if (rolledBack.node_id !== second.node.id) {
    throw new Error(`cross-node rollback did not execute on current node: ${JSON.stringify(rolledBack)}`);
  }
  if (rolledBack.rollback_target_id !== targetDeploymentId) {
    throw new Error(`rollback target provenance mismatch: ${JSON.stringify(rolledBack)}`);
  }
  if (rolledBack.artifact_image_ref !== target.artifact_image_ref) {
    throw new Error(`rollback did not preserve immutable registry artifact: ${JSON.stringify(rolledBack)}`);
  }

  const events = await request(`/v0/deployments/${rollbackDeploymentId}/events`);
  if (!events.some((event) => event.kind === "LOG" && event.stream === "system" && event.message?.includes("pulling immutable rollback artifact from registry"))) {
    throw new Error("cross-node rollback never proved registry artifact recovery");
  }

  console.log(JSON.stringify({
    ok:true,
    targetDeploymentId,
    targetNodeId:first.node.id,
    currentDeploymentId,
    currentNodeId:second.node.id,
    rollbackDeploymentId,
    artifactImageRef:target.artifact_image_ref,
    verified:[
      "historical-target-on-node-a",
      "current-ready-on-node-b",
      "rollback-created-on-current-node-b",
      "target-local-retained-tag-absent",
      "immutable-registry-fallback",
      "rollback-target-provenance-preserved",
      "rollback-ready",
    ],
  }, null, 2));
} finally {
  await stop(builder);
  await stop(agentA);
  await stop(agentB);
  spawnSync("docker",["rm","-f",registryName],{stdio:"ignore"});
  spawnSync("docker",["rm","-f","rundea-runtime-router"],{stdio:"ignore"});
  for (const deploymentId of [targetDeploymentId,currentDeploymentId,rollbackDeploymentId].filter(Boolean)) {
    for (const id of docker(["ps","-aq","--filter",`label=rundea.deployment=${deploymentId}`], { stdio:["ignore","pipe","ignore"] }).split(/\s+/).filter(Boolean)) {
      spawnSync("docker",["rm","-f",id],{stdio:"ignore"});
    }
  }
  await rm(agentAWork,{recursive:true,force:true});
  await rm(agentBWork,{recursive:true,force:true});
}
