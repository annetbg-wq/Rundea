import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
if (!token || !agentBinary) throw new Error("managed Redis acceptance environment is incomplete");

const headers = { authorization: "Bearer " + token };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const suffix = Date.now().toString(36) + "-" + process.pid;
const workDir = await mkdtemp(join(tmpdir(), "rundea-redis-"));
const backends = new Set();
let agent, redisContainer, redisVolume;

class FatalPollError extends Error {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, init = {}) {
  const response = await fetch(api + path, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error((init.method ?? "GET") + " " + path + " -> " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

async function poll(label, fn, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value?.done) return value.value;
      last = value?.last ?? last;
    } catch (error) {
      if (error instanceof FatalPollError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(label + " timed out; last=" + last);
}

function docker(args, allowFailure = false) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0 && !allowFailure) throw new Error("docker " + args.join(" ") + " failed: " + (r.stderr || r.stdout || "").trim());
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function backendFor(deploymentId) {
  const names = docker(["ps","-a","--filter","label=rundea.managed=true","--filter","label=rundea.deployment=" + deploymentId,"--filter","label=rundea.backend=true","--format","{{.Names}}"]).stdout.split("\n").filter(Boolean);
  if (names.length !== 1) throw new Error("expected one backend for " + deploymentId + ", found " + names.length);
  backends.add(names[0]);
  return names[0];
}

async function waitReady(serviceId, deploymentId) {
  return poll("deployment READY", async () => {
    const body = await request("/v0/services/" + serviceId + "/deployments", { headers });
    const row = body.deployments.find((x) => x.id === deploymentId);
    if (!row) return { last: "missing" };
    if (row.status === "READY") return { done: true, value: row };
    if (["FAILED","CANCELLED"].includes(row.status)) {
      const events = await request("/v0/deployments/" + deploymentId + "/events", { headers }).catch(() => null);
      const detail = Array.isArray(events) ? events.map((event) => event.message).filter(Boolean).slice(-8).join(" | ") : "";
      throw new FatalPollError(deploymentId + " reached " + row.status + (detail ? ": " + detail : ""));
    }
    return { last: row.status };
  });
}

async function deploy(serviceId, nodeId) {
  const d = await request("/v0/services/" + serviceId + "/deployments", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({
      nodeId,
      sourceRepository: "https://github.com/render-examples/express-hello-world.git",
      sourceRef: fixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      healthcheckPath: "/"
    })
  });
  await waitReady(serviceId, d.id);
  return d;
}

function redisExec(container, mode, key, value) {
  const code = [
    'const net=require("net");',
    'const u=new URL(process.env.REDIS_URL||"");',
    'if(!u.hostname||!u.password)process.exit(2);',
    'function cmd(a){let o="*"+a.length+"\\r\\n";for(const p of a)o+="$"+Buffer.byteLength(p)+"\\r\\n"+p+"\\r\\n";return o;}',
    'const s=net.createConnection({host:u.hostname,port:Number(u.port)});let b="",stage=0;',
    's.setTimeout(10000);',
    's.on("connect",()=>s.write(cmd(["AUTH",decodeURIComponent(u.password)])));',
    's.on("data",c=>{b+=c.toString();',
    'if(stage===0&&b.includes("+OK\\r\\n")){stage=1;b="";s.write(cmd(' + JSON.stringify(mode) + '==="write"?["SET",' + JSON.stringify(key) + ',' + JSON.stringify(value) + ']:["GET",' + JSON.stringify(key) + ']));return;}',
    'if(stage===1&&(' + JSON.stringify(mode) + '==="write"?b.includes("+OK\\r\\n"):b.includes(' + JSON.stringify(value) + '))){process.stdout.write("OK");s.end();}});',
    's.on("timeout",()=>process.exit(3));s.on("error",()=>process.exit(4));',
    's.on("close",()=>{if(stage!==1)process.exit(5);});'
  ].join("");
  const r = docker(["exec", container, "node", "-e", code]);
  if (r.stdout !== "OK") throw new Error("Redis " + mode + " failed");
}

try {
  const workspace = await request("/v0/workspaces", { method:"POST", headers:jsonHeaders, body:JSON.stringify({slug:("redis-" + suffix).slice(0,63),name:"Managed Redis acceptance"}) });
  const projectA = await request("/v0/workspaces/" + workspace.id + "/projects", { method:"POST", headers:jsonHeaders, body:JSON.stringify({slug:("redis-a-" + suffix).slice(0,63),name:"Redis project A"}) });
  const projectB = await request("/v0/workspaces/" + workspace.id + "/projects", { method:"POST", headers:jsonHeaders, body:JSON.stringify({slug:("redis-b-" + suffix).slice(0,63),name:"Redis project B"}) });
  const serviceA = await request("/v0/projects/" + projectA.id + "/services", { method:"POST", headers:jsonHeaders, body:JSON.stringify({slug:"api",name:"Redis API A"}) });
  const serviceB = await request("/v0/projects/" + projectB.id + "/services", { method:"POST", headers:jsonHeaders, body:JSON.stringify({slug:"api",name:"Redis API B"}) });
  const addon = await request("/v0/projects/" + projectA.id + "/addons/redis", { method:"POST", headers:jsonHeaders, body:"{}" });
  if (addon.alias !== "redis" || addon.environmentKey !== "REDIS_URL") throw new Error("unexpected managed Redis API response");

  const node = await request("/v0/workspaces/" + workspace.id + "/nodes", { method:"POST", headers:jsonHeaders, body:JSON.stringify({name:"redis-node-" + process.pid}) });
  const nodeToken = await activateNodeCredential(api, node.id, node.token);
  agent = spawn(agentBinary, [], { stdio:["ignore","inherit","inherit"], env:{...process.env,RUNDEA_CONTROL_PLANE_URL:api,RUNDEA_NODE_ID:node.id,RUNDEA_NODE_TOKEN:nodeToken,RUNDEA_WORK_DIR:workDir,RUNDEA_METRICS_INTERVAL:"2s"} });

  await poll("Agent ONLINE", async () => {
    if (agent.exitCode !== null) throw new FatalPollError("Agent exited " + agent.exitCode);
    const body = await request("/v0/workspaces/" + workspace.id + "/nodes", { headers });
    const row = body.nodes.find((x) => x.id === node.id);
    return row?.status === "ONLINE" ? {done:true,value:row} : {last:row?.status ?? "missing"};
  }, 45000);

  const first = await deploy(serviceA.id, node.id);
  const foreign = await deploy(serviceB.id, node.id);
  const firstBackend = backendFor(first.id);
  const foreignBackend = backendFor(foreign.id);

  await poll("Redis READY", async () => {
    const body = await request("/v0/projects/" + projectA.id + "/addons/redis", { headers });
    return body.status === "READY" ? {done:true,value:body} : {last:body.status};
  }, 60000);

  const names = docker(["ps","-a","--filter","label=rundea.kind=managed-redis","--filter","label=rundea.project=" + projectA.id,"--format","{{.Names}}"]).stdout.split("\n").filter(Boolean);
  if (names.length !== 1) throw new Error("expected exactly one managed Redis container");
  redisContainer = names[0];
  if (docker(["port", redisContainer]).stdout !== "") throw new Error("managed Redis publishes a host port");

  const expectedNetwork = "rundea-project-" + projectA.id.replaceAll("-","").toLowerCase();
  if (docker(["inspect","--format","{{.HostConfig.NetworkMode}}",redisContainer]).stdout !== expectedNetwork) throw new Error("managed Redis is on wrong project network");

  const env = docker(["inspect","--format","{{range .Config.Env}}{{println .}}{{end}}",firstBackend]).stdout;
  if (!env.split("\n").some((x) => x.startsWith("REDIS_URL=redis://:") && x.endsWith("@redis:6379/0"))) throw new Error("REDIS_URL was not injected privately");

  const cross = docker(["exec",foreignBackend,"node","-e","require('dns').lookup('redis',(e)=>process.exit(e?0:7))"], true);
  if (cross.status !== 0) throw new Error("cross-project Redis DNS isolation failed");

  const key = "rundea:" + suffix;
  const value = "value-" + suffix;
  redisExec(firstBackend, "write", key, value);

  const second = await deploy(serviceA.id, node.id);
  const secondBackend = backendFor(second.id);
  redisExec(secondBackend, "read", key, value);

  docker(["restart", redisContainer]);
  await poll("Redis restart", async () => docker(["inspect","--format","{{.State.Running}}",redisContainer], true).stdout === "true" ? {done:true} : {last:"not running"}, 30000);
  redisExec(secondBackend, "read", key, value);

  const rollback = await request("/v0/deployments/" + first.id + "/rollback", { method:"POST", headers });
  await waitReady(serviceA.id, rollback.id);
  const rollbackBackend = backendFor(rollback.id);
  redisExec(rollbackBackend, "read", key, value);

  redisVolume = docker(["volume","ls","--quiet","--filter","label=rundea.kind=managed-redis-data","--filter","label=rundea.project=" + projectA.id]).stdout;
  if (!redisVolume) throw new Error("managed Redis durable volume missing");

  console.log(JSON.stringify({ok:true,addonId:addon.id,nodeId:node.id,verified:[
    "same-project-private-reachability","cross-project-isolation","zero-host-ports","private-REDIS_URL",
    "persistence-across-redeploy","persistence-across-restart","persistence-across-rollback","durable-volume"
  ]}, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve)=>agent.once("exit",resolve)),sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  for (const c of backends) spawnSync("docker",["rm","-f",c],{stdio:"ignore"});
  if (redisContainer) spawnSync("docker",["rm","-f",redisContainer],{stdio:"ignore"});
  spawnSync("docker",["rm","-f","rundea-runtime-router"],{stdio:"ignore"});
  if (redisVolume) spawnSync("docker",["volume","rm","-f",redisVolume],{stdio:"ignore"});
  await rm(workDir,{recursive:true,force:true}).catch(()=>undefined);
}
