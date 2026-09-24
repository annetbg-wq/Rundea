import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4010";
const token = process.env.RUNDEA_CONTROL_TOKEN;
const databaseUrl = process.env.RUNDEA_ACCEPTANCE_DATABASE_URL;
const builderToken = process.env.RUNDEA_BUILDER_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const sourceSha = process.env.RUNDEA_ACCEPTANCE_SOURCE_SHA?.trim().toLowerCase();
const registryPort = Number(process.env.RUNDEA_BUILD_REGISTRY_PORT ?? "15011");
const registryUser = process.env.RUNDEA_REGISTRY_USERNAME ?? "acceptance";
const registryPassword = process.env.RUNDEA_REGISTRY_PASSWORD ?? "acceptance-password";
const registryPrefix = `localhost:${registryPort}/rundea-builds`;

if (!token) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!databaseUrl) throw new Error("RUNDEA_ACCEPTANCE_DATABASE_URL is required");
if (!builderToken) throw new Error("RUNDEA_BUILDER_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("RUNDEA_ACCEPTANCE_SOURCE_SHA must be a full Git SHA");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const registryName = `rundea-private-registry-${suffix}`;
const authDir = await mkdtemp(join(tmpdir(), "rundea-registry-auth-"));
const agentHome = await mkdtemp(join(tmpdir(), "rundea-agent-home-"));
const agentWork = await mkdtemp(join(tmpdir(), "rundea-agent-work-"));
let builder;
let agent;
let artifactRef = "";
let deploymentId = "";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
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

try {
  const htpasswd = spawnSync(
    "docker",
    ["run","--rm","--entrypoint","htpasswd","httpd:2.4-alpine","-Bbn",registryUser,registryPassword],
    { encoding:"utf8" },
  );
  if (htpasswd.status !== 0 || !htpasswd.stdout.includes(":")) {
    throw new Error(`could not generate registry htpasswd: ${htpasswd.stderr || htpasswd.stdout}`);
  }
  await writeFile(join(authDir, "htpasswd"), htpasswd.stdout, { mode:0o600 });

  docker([
    "run","-d","--name",registryName,
    "-p",`127.0.0.1:${registryPort}:5000`,
    "-e","REGISTRY_AUTH=htpasswd",
    "-e","REGISTRY_AUTH_HTPASSWD_REALM=Rundea Acceptance Registry",
    "-e","REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    "-v",`${authDir}:/auth:ro`,
    "registry:2",
  ]);

  await poll("private registry challenge", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${registryPort}/v2/`);
      return response.status === 401 ? { done:true, value:true } : { last:response.status };
    } catch (error) {
      return { last:error instanceof Error ? error.message : String(error) };
    }
  }, 30000);

  const workspace = await request("/v0/workspaces", {
    method:"POST",
    body:JSON.stringify({ slug:`registry-${Date.now().toString(36)}`.slice(0,63), name:`Registry Auth Acceptance ${suffix}` }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method:"POST",
    body:JSON.stringify({ slug:"private-registry", name:"Private Registry" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method:"POST",
    body:JSON.stringify({ slug:"private-image", name:"private-image" }),
  });
  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method:"POST",
    body:JSON.stringify({ name:`registry-agent-${suffix}` }),
  });
  const nodeToken = await activateNodeCredential(api, node.id, node.token);

  agent = spawn(agentBinary, [], {
    stdio:["ignore","inherit","inherit"],
    env:{
      ...process.env,
      HOME:agentHome,
      RUNDEA_CONTROL_PLANE_URL:api,
      RUNDEA_NODE_ID:node.id,
      RUNDEA_NODE_TOKEN:nodeToken,
      RUNDEA_WORK_DIR:agentWork,
      RUNDEA_METRICS_INTERVAL:"2s",
    },
  });

  await poll("private registry Agent online", async () => {
    if (agent.exitCode !== null) throw new Error(`Agent exited with code ${agent.exitCode}`);
    const nodes = await request(`/v0/workspaces/${workspace.id}/nodes`);
    const row = nodes.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done:true, value:row } : { last:row?.status ?? "missing" };
  }, 45000);

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
    body:JSON.stringify({ nodeId:node.id, enabled:true }),
  });

  const queued = await request(`/v0/services/${service.id}/builds`, {
    method:"POST",
    body:JSON.stringify({ revisionSha:sourceSha, deployAfterPush:true }),
  });

  builder = spawn("npx", ["tsx","apps/builder/src/index.ts"], {
    stdio:["ignore","inherit","inherit"],
    env:{
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL:api,
      RUNDEA_BUILDER_TOKEN:builderToken,
      RUNDEA_BUILDER_ID:`registry-auth-${suffix}`,
      RUNDEA_REGISTRY_USERNAME:registryUser,
      RUNDEA_REGISTRY_PASSWORD:registryPassword,
      RUNDEA_BUILD_POLL_MS:"250",
      RUNDEA_BUILD_TIMEOUT_SECONDS:"180",
      RUNDEA_BUILD_MEMORY_BYTES:"1073741824",
      RUNDEA_BUILD_CPU_QUOTA:"100000",
      RUNDEA_BUILD_CPU_PERIOD:"100000",
    },
  });

  const pushed = await poll("private build pushed and deployment linked", async () => {
    if (builder.exitCode !== null) throw new Error(`builder exited with code ${builder.exitCode}`);
    const body = await request(`/v0/services/${service.id}/builds`);
    const row = body.builds.find((item) => item.id === queued.build.id);
    if (!row) return { last:"missing" };
    if (row.status === "FAILED") throw new Error(`build failed: ${row.error}`);
    return row.status === "PUSHED" && row.deployment_id ? { done:true, value:row } : { last:{status:row.status,deploymentId:row.deployment_id} };
  });

  artifactRef = pushed.artifact_image_ref;
  deploymentId = pushed.deployment_id;
  if (!artifactRef?.startsWith(`${registryPrefix}/`) || !/@sha256:[0-9a-f]{64}$/.test(artifactRef)) {
    throw new Error(`private immutable artifact missing: ${artifactRef}`);
  }

  const ready = await poll("private registry deployment READY", async () => {
    const body = await request(`/v0/services/${service.id}/deployments`);
    const row = body.deployments.find((item) => item.id === deploymentId);
    if (!row) return { last:"missing" };
    if (row.status === "FAILED") throw new Error(`deployment failed: ${JSON.stringify(row)}`);
    return row.status === "READY" ? { done:true, value:row } : { last:row.status };
  }, 180000);

  const stored = new Client({ connectionString: databaseUrl });
  await stored.connect();
  let ticket;
  try {
    const result = await stored.query(
      "SELECT registry_host,consumed_at,expires_at FROM registry_pull_tickets WHERE deployment_id=$1 AND node_id=$2",
      [deploymentId,node.id],
    );
    ticket = result.rows[0];
  } finally {
    await stored.end();
  }
  if (!ticket?.consumed_at || ticket.registry_host !== `localhost:${registryPort}`) {
    throw new Error(`registry pull ticket was not single-use consumed: ${JSON.stringify(ticket)}`);
  }

  const events = await request(`/v0/deployments/${deploymentId}/events`);
  if (!events.some((event) => event.kind === "LOG" && event.stream === "system" && event.message?.includes("one-time brokered registry pull credentials"))) {
    throw new Error("Agent did not report brokered registry pull credentials");
  }

  const homeConfig = join(agentHome, ".docker", "config.json");
  const workConfig = join(agentWork, ".docker", "config.json");
  for (const path of [homeConfig,workConfig]) {
    try {
      await readFile(path, "utf8");
      throw new Error(`production Agent persisted registry credentials at ${path}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const runtime = await fetch(`http://127.0.0.1:${ready.host_port ?? 18000}/`).catch(() => null);
  if (runtime && runtime.ok) await runtime.body?.cancel();

  console.log(JSON.stringify({
    ok:true,
    buildId:queued.build.id,
    deploymentId,
    artifactRef,
    registryHost:ticket.registry_host,
    verified:[
      "private-registry-basic-auth",
      "builder-authenticated-push",
      "single-use-node-bound-pull-ticket",
      "control-plane-held-pull-secret",
      "temporary-agent-docker-config",
      "immutable-agent-pull",
      "runtime-ready",
      "no-persistent-agent-registry-credentials",
    ],
  }, null, 2));
} finally {
  if (builder && builder.exitCode === null) {
    builder.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => builder.once("exit",resolve)), sleep(3000)]);
    if (builder.exitCode === null) builder.kill("SIGKILL");
  }
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => agent.once("exit",resolve)), sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  spawnSync("docker",["rm","-f",registryName],{stdio:"ignore"});
  spawnSync("docker",["rm","-f","rundea-runtime-router"],{stdio:"ignore"});
  if (artifactRef) spawnSync("docker",["image","rm","-f",artifactRef],{stdio:"ignore"});
  await rm(authDir,{recursive:true,force:true});
  await rm(agentHome,{recursive:true,force:true});
  await rm(agentWork,{recursive:true,force:true});
}
