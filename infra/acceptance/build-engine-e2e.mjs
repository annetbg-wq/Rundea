import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.RUNDEA_CONTROL_TOKEN;
const databaseUrl = process.env.RUNDEA_ACCEPTANCE_DATABASE_URL;
const builderToken = process.env.RUNDEA_BUILDER_TOKEN;
const sourceSha = process.env.RUNDEA_ACCEPTANCE_SOURCE_SHA?.trim().toLowerCase();
const registryPort = Number(process.env.RUNDEA_BUILD_REGISTRY_PORT ?? "15001");
const registryPrefix = `localhost:${registryPort}/rundea-builds`;

if (!token) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!databaseUrl) throw new Error("RUNDEA_ACCEPTANCE_DATABASE_URL is required");
if (!builderToken) throw new Error("RUNDEA_BUILDER_TOKEN is required");
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("RUNDEA_ACCEPTANCE_SOURCE_SHA must be a full Git SHA");

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const registryName = `rundea-build-registry-${suffix}`;
let builder;
let artifactRef = "";

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

  const workspace = await request("/v0/workspaces", {
    method:"POST",
    body:JSON.stringify({ slug:`builder-${Date.now().toString(36)}`, name:`Builder Acceptance ${suffix}` }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method:"POST",
    body:JSON.stringify({ slug:"build-engine", name:"Build Engine" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method:"POST",
    body:JSON.stringify({ slug:"build-fixture", name:"build-fixture" }),
  });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO service_source_configs(
         service_id,project_id,repository_full_name,selected_branch,revision_sha,source_path,dockerfile,
         container_port,healthcheck_path,build_variable_names,runtime_variable_names
       ) VALUES($1,$2,'annetbg-wq/Rundea','main',$3,'infra/acceptance/build-fixture','Dockerfile',8080,'','[]'::jsonb,'[]'::jsonb)`,
      [service.id, project.id, sourceSha],
    );
  } finally {
    await client.end();
  }

  const queued = await request(`/v0/services/${service.id}/builds`, {
    method:"POST",
    body:JSON.stringify({ revisionSha:sourceSha, buildArgs:{ RUNDEA_ACCEPTANCE:"1" } }),
  });
  if (queued.build.status !== "QUEUED") throw new Error(`unexpected initial build status ${queued.build.status}`);
  if (!String(queued.build.registry_repository).startsWith(`${registryPrefix}/svc-`)) {
    throw new Error(`unexpected registry repository ${queued.build.registry_repository}`);
  }

  builder = spawn("npm", ["run","start","-w","@rundea/builder"], {
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

  const pushed = await poll("build pushed", async () => {
    if (builder.exitCode !== null) throw new Error(`builder exited with code ${builder.exitCode}`);
    const body = await request(`/v0/services/${service.id}/builds`);
    const row = body.builds.find((item) => item.id === queued.build.id);
    if (!row) return { last:"missing" };
    if (row.status === "FAILED") throw new Error(`build failed: ${row.error}`);
    return row.status === "PUSHED" ? { done:true, value:row } : { last:row.status };
  });

  artifactRef = pushed.artifact_image_ref;
  if (!artifactRef || !/@sha256:[0-9a-f]{64}$/.test(artifactRef)) throw new Error(`immutable artifact missing: ${artifactRef}`);
  if (!artifactRef.startsWith(`${pushed.registry_repository}@sha256:`)) throw new Error("artifact escaped assigned registry repository");

  docker(["pull",artifactRef]);
  const label = docker(["image","inspect","--format","{{index .Config.Labels \"org.rundea.acceptance\"}}",artifactRef]);
  if (label !== "build-engine") throw new Error(`unexpected built image label: ${label}`);

  const eventBody = await request(`/v0/builds/${queued.build.id}/events`);
  const statuses = eventBody.events.filter((event) => event.kind === "STATUS").map((event) => event.status);
  for (const expected of ["QUEUED","CLAIMED","BUILDING","PUSHED"]) {
    if (!statuses.includes(expected)) throw new Error(`missing build event ${expected}: ${JSON.stringify(statuses)}`);
  }

  console.log(JSON.stringify({
    ok:true,
    buildId:queued.build.id,
    serviceId:service.id,
    artifactRef,
    statuses,
    verified:[
      "source-fetched-by-control-plane",
      "builder-lease-state-machine",
      "off-node-docker-build",
      "cpu-memory-time-build-limits",
      "registry-push",
      "immutable-digest-persisted",
    ],
  }, null, 2));
} finally {
  if (builder && builder.exitCode === null) {
    builder.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => builder.once("exit",resolve)), sleep(3000)]);
    if (builder.exitCode === null) builder.kill("SIGKILL");
  }
  spawnSync("docker",["rm","-f",registryName],{stdio:"ignore"});
  if (artifactRef) spawnSync("docker",["image","rm","-f",artifactRef],{stdio:"ignore"});
}
