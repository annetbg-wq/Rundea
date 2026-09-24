import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.RUNDEA_CONTROL_TOKEN;
const databaseUrl = process.env.RUNDEA_ACCEPTANCE_DATABASE_URL;
const builderToken = process.env.RUNDEA_BUILDER_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const sourceSha = process.env.RUNDEA_ACCEPTANCE_SOURCE_SHA?.trim().toLowerCase();
const registryPort = Number(process.env.RUNDEA_BUILD_REGISTRY_PORT ?? "15001");
const registryPrefix = `localhost:${registryPort}/rundea-builds`;

if (!token) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!databaseUrl) throw new Error("RUNDEA_ACCEPTANCE_DATABASE_URL is required");
if (!builderToken) throw new Error("RUNDEA_BUILDER_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("RUNDEA_ACCEPTANCE_SOURCE_SHA must be a full Git SHA");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const registryName = `rundea-build-registry-${suffix}`;
const wrapperDir = await mkdtemp(join(tmpdir(), "rundea-handoff-docker-"));
const dockerLog = join(wrapperDir, "docker.log");
let builder;
let agent;
let artifactRef = "";
let deploymentId = "";
let nodeId = "";

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
  docker(["run","-d","--name",registryName,"-p",`127.0.0.1:${registryPort}:5000`,"registry:2"]);
  await poll("registry", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${registryPort}/v2/`);
      return response.ok ? { done:true, value:true } : { last:response.status };
    } catch (error) {
      return { last:error instanceof Error ? error.message : String(error) };
    }
  }, 30000);

  const realDocker = spawnSync("/bin/bash", ["-lc", "command -v docker"], { encoding:"utf8" }).stdout.trim();
  if (!realDocker) throw new Error("real docker binary was not found");
  await writeFile(join(wrapperDir, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$RUNDEA_ACCEPTANCE_DOCKER_LOG"
printf '\\n' >> "$RUNDEA_ACCEPTANCE_DOCKER_LOG"
if [[ "\${1:-}" == "build" ]]; then
  echo "docker build is forbidden on production Agent during build handoff" >&2
  exit 97
fi
exec "$RUNDEA_ACCEPTANCE_REAL_DOCKER" "$@"
`, "utf8");
  await chmod(join(wrapperDir, "docker"), 0o755);
  await writeFile(dockerLog, "", "utf8");

  const workspace = await request("/v0/workspaces", {
    method:"POST",
    body:JSON.stringify({ slug:`handoff-${Date.now().toString(36)}`, name:`Handoff Acceptance ${suffix}` }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method:"POST",
    body:JSON.stringify({ slug:"build-handoff", name:"Build Handoff" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method:"POST",
    body:JSON.stringify({ slug:"build-fixture", name:"build-fixture" }),
  });

  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method:"POST",
    body:JSON.stringify({ name:`handoff-${suffix}` }),
  });
  nodeId = node.id;
  const nodeToken = await activateNodeCredential(api, node.id, node.token);
  agent = spawn(agentBinary, [], {
    stdio:["ignore","inherit","inherit"],
    env:{
      ...process.env,
      PATH:`${wrapperDir}:${process.env.PATH}`,
      RUNDEA_ACCEPTANCE_REAL_DOCKER:realDocker,
      RUNDEA_ACCEPTANCE_DOCKER_LOG:dockerLog,
      RUNDEA_CONTROL_PLANE_URL:api,
      RUNDEA_NODE_ID:node.id,
      RUNDEA_NODE_TOKEN:nodeToken,
      RUNDEA_WORK_DIR:await mkdtemp(join(tmpdir(), "rundea-handoff-agent-")),
      RUNDEA_METRICS_INTERVAL:"2s",
    },
  });

  await poll("handoff Agent online", async () => {
    if (agent.exitCode !== null) throw new Error(`Agent exited with code ${agent.exitCode}`);
    const nodes = await request(`/v0/workspaces/${workspace.id}/nodes`);
    const row = nodes.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done:true, value:row } : { last:row?.status ?? "missing" };
  }, 45000);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO service_source_configs(
         service_id,project_id,repository_full_name,selected_branch,revision_sha,source_path,dockerfile,
         container_port,healthcheck_path,build_variable_names,runtime_variable_names
       ) VALUES($1,$2,'annetbg-wq/Rundea','main',$3,'infra/acceptance/build-fixture','Dockerfile',80,'/','[]'::jsonb,'[]'::jsonb)`,
      [service.id, project.id, sourceSha],
    );
  } finally {
    await client.end();
  }

  await request(`/v0/services/${service.id}/push-autodeploy`, {
    method:"PUT",
    body:JSON.stringify({ nodeId:node.id, enabled:true }),
  });

  const queued = await request(`/v0/services/${service.id}/builds`, {
    method:"POST",
    body:JSON.stringify({ revisionSha:sourceSha, deployAfterPush:true }),
  });
  if (queued.build.status !== "QUEUED" || queued.build.deploy_after_push !== true) {
    throw new Error(`unexpected queued build ${JSON.stringify(queued.build)}`);
  }
  if (!String(queued.build.registry_repository).startsWith(`${registryPrefix}/svc-`)) {
    throw new Error(`unexpected registry repository ${queued.build.registry_repository}`);
  }

  builder = spawn("npx", ["tsx","apps/builder/src/index.ts"], {
    stdio:["ignore","inherit","inherit"],
    env:{
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL:api,
      RUNDEA_BUILDER_TOKEN:builderToken,
      RUNDEA_BUILDER_ID:`acceptance-${suffix}`,
      RUNDEA_BUILD_POLL_MS:"250",
      RUNDEA_BUILD_TIMEOUT_SECONDS:"120",
      RUNDEA_BUILD_MEMORY_BYTES:"1073741824",
      RUNDEA_BUILD_CPU_QUOTA:"100000",
      RUNDEA_BUILD_CPU_PERIOD:"100000",
    },
  });

  const pushed = await poll("build pushed and deployment linked", async () => {
    if (builder.exitCode !== null) throw new Error(`builder exited with code ${builder.exitCode}`);
    const body = await request(`/v0/services/${service.id}/builds`);
    const row = body.builds.find((item) => item.id === queued.build.id);
    if (!row) return { last:"missing" };
    if (row.status === "FAILED") throw new Error(`build failed: ${row.error}`);
    return row.status === "PUSHED" && row.deployment_id ? { done:true, value:row } : { last:{status:row.status,deploymentId:row.deployment_id} };
  });

  artifactRef = pushed.artifact_image_ref;
  deploymentId = pushed.deployment_id;
  if (!artifactRef || !/@sha256:[0-9a-f]{64}$/.test(artifactRef)) throw new Error(`immutable artifact missing: ${artifactRef}`);

  const ready = await poll("handoff deployment READY", async () => {
    const rows = await request("/v0/deployments");
    const row = rows.find((item) => item.id === deploymentId);
    if (!row) return { last:"missing" };
    if (row.status === "FAILED") throw new Error(`deployment failed: ${JSON.stringify(row)}`);
    return row.status === "READY" ? { done:true, value:row } : { last:row.status };
  }, 180000);

  if (ready.artifact_image_ref !== artifactRef || ready.artifact_source_commit_sha !== sourceSha) {
    throw new Error(`deployment provenance mismatch: ${JSON.stringify(ready)}`);
  }
  if (ready.node_id !== node.id) throw new Error("handoff deployment targeted wrong node");

  const runtime = await fetch(`http://127.0.0.1:${ready.host_port}/`);
  const body = await runtime.text();
  if (!runtime.ok || !body.includes("Rundea Build Engine to production handoff")) {
    throw new Error(`deployed runtime mismatch status=${runtime.status} body=${body.slice(0,200)}`);
  }

  const agentDocker = await readFile(dockerLog, "utf8");
  if (/^build(?:\s|$)/m.test(agentDocker)) {
    throw new Error(`production Agent invoked docker build during automatic handoff:\n${agentDocker}`);
  }
  if (!/^pull(?:\s|$)/m.test(agentDocker)) throw new Error("production Agent never pulled the immutable artifact");

  const eventBody = await request(`/v0/builds/${queued.build.id}/events`);
  const statuses = eventBody.events.filter((event) => event.kind === "STATUS").map((event) => event.status);
  for (const expected of ["QUEUED","CLAIMED","BUILDING","PUSHED"]) {
    if (!statuses.includes(expected)) throw new Error(`missing build event ${expected}: ${JSON.stringify(statuses)}`);
  }

  console.log(JSON.stringify({
    ok:true,
    buildId:queued.build.id,
    deploymentId,
    serviceId:service.id,
    nodeId:node.id,
    artifactRef,
    verified:[
      "off-node-build",
      "registry-push",
      "immutable-digest-persisted",
      "automatic-build-to-deploy-handoff",
      "production-agent-pull-only",
      "runtime-ready",
      "source-provenance-preserved",
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
  if (deploymentId) {
    const revision = `rundea-build-fixture-rev-${deploymentId.replaceAll("-","").toLowerCase().slice(0,12)}`;
    spawnSync("docker",["rm","-f",revision],{stdio:"ignore"});
  }
  spawnSync("docker",["rm","-f","rundea-runtime-router"],{stdio:"ignore"});
  if (artifactRef) spawnSync("docker",["image","rm","-f",artifactRef],{stdio:"ignore"});
  await rm(wrapperDir,{recursive:true,force:true});
}
