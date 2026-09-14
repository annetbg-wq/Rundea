import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
const hostPort = Number(process.env.RUNDEA_HEALTH_HOST_PORT ?? "18084");

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("invalid health acceptance host port");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const serviceName = `health-${Date.now().toString(36)}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-health-acceptance-"));
let agent;
let backendContainer = "";

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

async function poll(label, fn, timeoutMs = 180_000, intervalMs = 500) {
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

async function deployment(id) {
  const rows = await request("/v0/deployments", { headers });
  return rows.find((item) => item.id === id);
}

async function metrics(id) {
  return await request(`/v0/deployments/${id}/metrics?minutes=15`, { headers });
}

async function events(id) {
  return await request(`/v0/deployments/${id}/events`, { headers });
}

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

try {
  const suffix = Date.now().toString(36);
  const workspace = await request("/v0/workspaces", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug: `health-${suffix}`, name: "Continuous health acceptance" }),
  });
  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `health-${process.pid}` }),
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

  await poll("health acceptance Agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited before ONLINE with code ${agent.exitCode}`);
    const body = await request(`/v0/workspaces/${workspace.id}/nodes`, { headers });
    const row = body.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.status ?? "missing" };
  }, 45_000, 500);

  const created = await request("/v0/deployments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      serviceName,
      nodeId: node.id,
      sourceRepository: fixtureRepository,
      sourceRef: fixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
    }),
  });
  const deploymentId = created.id;

  await poll("health fixture READY", async () => {
    const row = await deployment(deploymentId);
    if (!row) return { last: "missing" };
    if (row.status === "READY") return { done: true, value: row };
    if (["FAILED", "CANCELLED", "ROLLED_BACK"].includes(row.status)) throw new FatalPollError(`health fixture reached ${row.status}`);
    return { last: row.status };
  }, 240_000, 1000);

  const initial = await poll("initial HEALTHY telemetry", async () => {
    const body = await metrics(deploymentId);
    return body.runtimeHealth === "HEALTHY" && body.uptimeSeconds >= 0
      ? { done: true, value: body }
      : { last: { health: body.runtimeHealth, restarts: body.restartCount, uptime: body.uptimeSeconds } };
  }, 45_000, 500);
  const initialRestartCount = initial.restartCount;

  backendContainer = docker([
    "ps", "-a",
    "--filter", "label=rundea.managed=true",
    "--filter", `label=rundea.deployment=${deploymentId}`,
    "--format", "{{.Names}}",
  ]).split("\n").map((value) => value.trim()).filter(Boolean)[0] ?? "";
  if (!backendContainer) throw new Error("could not resolve Rundea-owned backend container for health acceptance");

  // Fault injection only: disable Docker's own restart policy so this test proves
  // the Rundea Agent health loop performs the recovery, not Docker by itself.
  docker(["update", "--restart=no", backendContainer]);
  docker(["stop", "--time", "1", backendContainer]);

  await poll("DOWN transition persisted", async () => {
    const body = await events(deploymentId);
    const down = body.some((event) => event.kind === "LOG" && event.stream === "system" && event.message?.startsWith("runtime-health DOWN"));
    return down ? { done: true, value: body } : { last: body.slice(-5) };
  }, 45_000, 250);

  const recovered = await poll("bounded automatic restart recovers HEALTHY", async () => {
    const body = await metrics(deploymentId);
    if (body.restartCount > initialRestartCount + 1) {
      throw new FatalPollError(`restart count exceeded bounded single recovery: ${body.restartCount}`);
    }
    return body.runtimeHealth === "HEALTHY" && body.restartCount === initialRestartCount + 1 && body.uptimeSeconds >= 0
      ? { done: true, value: body }
      : { last: { health: body.runtimeHealth, restarts: body.restartCount, uptime: body.uptimeSeconds, error: body.healthError } };
  }, 60_000, 250);

  const statePayload = JSON.parse(await readFile(join(workDir, "runtime-health", "state.json"), "utf8"));
  const tracker = statePayload.trackers?.[deploymentId];
  if (!tracker?.restartAfter || new Date(tracker.restartAfter).getTime() <= Date.now()) {
    throw new Error(`automatic restart cooldown was not persisted: ${JSON.stringify(tracker)}`);
  }

  const row = await deployment(deploymentId);
  if (row?.status !== "READY") throw new Error(`continuous health changed deployment lifecycle status to ${row?.status}`);

  const response = await fetch(`http://127.0.0.1:${hostPort}/`);
  const body = await response.text();
  if (!response.ok || !body.includes("Hello from Render!") || response.headers.get("x-rundea-deployment") !== deploymentId) {
    throw new Error(`recovered stable route is not serving the original deployment: ${response.status} ${body.slice(0, 160)}`);
  }

  const history = await events(deploymentId);
  if (!history.some((event) => event.kind === "LOG" && event.stream === "system" && event.message?.startsWith("runtime-health HEALTHY"))) {
    throw new Error("Control Plane did not persist HEALTHY transition after recovery");
  }

  console.log(JSON.stringify({
    ok: true,
    deploymentId,
    backendContainer,
    initialRestartCount,
    recoveredRestartCount: recovered.restartCount,
    recoveredUptimeSeconds: recovered.uptimeSeconds,
    persistedRestartAfter: tracker.restartAfter,
    deploymentStatus: row.status,
    verified: [
      "ready-remains-ready",
      "healthy-before-fault",
      "down-transition-event",
      "agent-owned-auto-restart",
      "single-bounded-restart",
      "persisted-restart-cooldown",
      "healthy-after-independent-probe",
      "stable-route-recovered",
    ],
  }, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  if (backendContainer) spawnSync("docker", ["rm", "-f", backendContainer], { stdio: "ignore" });
  spawnSync("docker", ["rm", "-f", "rundea-runtime-router"], { stdio: "ignore" });
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`continuous health acceptance cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
}
