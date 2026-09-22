import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { activateNodeCredential } from "./node-credential.mjs";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const web = process.env.RUNDEA_ACCEPTANCE_WEB_URL ?? "http://127.0.0.1:5173";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-browser-health-agent-"));
const chromeDir = await mkdtemp(join(tmpdir(), "rundea-browser-health-chrome-"));
let agent;
let chrome;
let backendContainer = "";
let cdp;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function request(path, init = {}) {
  const response = await fetch(api + path, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

async function poll(label, fn, timeoutMs = 120000, intervalMs = 500) {
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

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  return (result.stdout ?? "").trim();
}

function chromeExecutable() {
  for (const candidate of ["google-chrome", "chromium", "chromium-browser"]) {
    const result = spawnSync("bash", ["-lc", `command -v ${candidate}`], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  throw new Error("no Chrome/Chromium executable found on acceptance runner");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on("message", (payload) => {
      const message = JSON.parse(String(payload));
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result?.value;
  }
}

async function startBrowser(workspaceId, projectId, serviceId) {
  const executable = chromeExecutable();
  chrome = spawn(executable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=9222",
    `--user-data-dir=${chromeDir}`,
    "about:blank",
  ], { stdio: ["ignore", "inherit", "inherit"] });

  const target = await poll("Chrome DevTools target", async () => {
    try {
      const response = await fetch("http://127.0.0.1:9222/json/list");
      if (!response.ok) return { last: response.status };
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      return page ? { done: true, value: page } : { last: pages };
    } catch (error) {
      return { last: error instanceof Error ? error.message : String(error) };
    }
  }, 30000, 250);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  // localStorage is origin-scoped and unavailable on about:blank. Enter the
  // canonical Rundea origin first, then seed the same persisted selection the
  // real UI uses and reload so React boots with that selection.
  await cdp.send("Page.navigate", { url: web });
  await poll("Rundea Web origin loaded", async () => {
    const ready = await cdp.evaluate(`location.origin === ${JSON.stringify(web)} && document.readyState === "complete"`);
    return ready ? { done: true, value: true } : { last: ready };
  }, 30000, 250);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      try {
        localStorage.setItem("rundea:workspace", ${JSON.stringify(workspaceId)});
        localStorage.setItem("rundea:project", ${JSON.stringify(projectId)});
        localStorage.setItem("rundea:service", ${JSON.stringify(serviceId)});
      } catch {}
    `,
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  await poll("Rundea Web loaded", async () => {
    const ready = await cdp.evaluate(`document.readyState === "complete" && document.body.innerText.includes("Observability")`);
    return ready ? { done: true, value: true } : { last: ready };
  }, 30000, 250);
  await poll("Rundea scope restored", async () => {
    const scope = await cdp.evaluate(`(() => ({
      persisted: {
        workspace: localStorage.getItem("rundea:workspace") ?? "",
        project: localStorage.getItem("rundea:project") ?? "",
        service: localStorage.getItem("rundea:service") ?? ""
      },
      selects: [...document.querySelectorAll("select")].slice(0, 3).map((select) => select.value)
    }))()`);
    const restored =
      scope?.persisted?.workspace === workspaceId &&
      scope?.persisted?.project === projectId &&
      scope?.persisted?.service === serviceId &&
      scope?.selects?.[0] === workspaceId &&
      scope?.selects?.[1] === projectId &&
      scope?.selects?.[2] === serviceId;
    return restored ? { done: true, value: scope } : { last: { ...scope, expected: { workspaceId, projectId, serviceId } } };
  }, 30000, 250);
  await poll("Observability navigation available", async () => {
    const available = await cdp.evaluate(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Observability")`);
    return available ? { done: true, value: true } : { last: false };
  }, 30000, 250);
  const clicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Observability");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Observability navigation disappeared before click");
  await poll("Observability panel mounted", async () => {
    const mounted = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="observability-panel"]'))`);
    return mounted ? { done: true, value: true } : { last: false };
  }, 30000, 250);
}

async function browserHealth() {
  return cdp.evaluate(`document.querySelector('[data-testid="runtime-health"]')?.innerText ?? ""`);
}

async function browserRestarts() {
  return cdp.evaluate(`document.querySelector('[data-testid="runtime-restarts"]')?.innerText ?? ""`);
}

try {
  const workspace = await request("/v0/workspaces", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ slug: `browser-health-${suffix}`.slice(0, 63), name: "Browser health acceptance" }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ slug: `browser-health-${suffix}`.slice(0, 63), name: "Browser health project" }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ slug: "api", name: "api" }),
  });
  const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ name: "browser-health-node" }),
  });
  const permanentToken = await activateNodeCredential(api, node.id, node.token);

  agent = spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: node.id,
      RUNDEA_NODE_TOKEN: permanentToken,
      RUNDEA_WORK_DIR: workDir,
      RUNDEA_METRICS_INTERVAL: "2s",
    },
  });

  await poll("browser health Agent ONLINE", async () => {
    if (agent.exitCode !== null) throw new Error(`Agent exited with code ${agent.exitCode}`);
    const body = await request(`/v0/workspaces/${workspace.id}/nodes`, { headers });
    const row = body.nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row };
  }, 45000, 250);

  const created = await request(`/v0/services/${service.id}/deployments`, {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({
      sourceRepository: fixtureRepository,
      sourceRef: fixtureSha,
      sourceDelivery: "BROKER",
      containerPort: 3001,
      healthcheckPath: "/",
    }),
  });
  const deploymentId = created.id;

  await poll("browser health deployment READY", async () => {
    const body = await request(`/v0/services/${service.id}/deployments`, { headers });
    const row = body.deployments.find((item) => item.id === deploymentId);
    if (row?.status === "READY") return { done: true, value: row };
    if (["FAILED", "CANCELLED", "ROLLED_BACK"].includes(row?.status)) throw new Error(`deployment reached ${row.status}`);
    return { last: row?.status };
  }, 240000, 1000);

  const initialMetrics = await poll("initial runtime HEALTHY", async () => {
    const body = await request(`/v0/deployments/${deploymentId}/metrics?minutes=15`, { headers });
    return body.runtimeHealth === "HEALTHY" ? { done: true, value: body } : { last: body.runtimeHealth };
  }, 45000, 500);

  await startBrowser(workspace.id, project.id, service.id);
  await poll("browser displays HEALTHY", async () => {
    const text = await browserHealth();
    return text.includes("HEALTHY") ? { done: true, value: text } : { last: text };
  }, 30000, 500);

  const observedDeploymentId = await poll("browser observes current READY deployment", async () => {
    const value = await cdp.evaluate(`document.querySelector('[data-testid="observability-panel"]')?.getAttribute('data-deployment-id') ?? ""`);
    return value === deploymentId ? { done: true, value } : { last: value };
  }, 30000, 250);
  assert.equal(observedDeploymentId, deploymentId);

  backendContainer = docker([
    "ps", "-a",
    "--filter", "label=rundea.managed=true",
    "--filter", `label=rundea.deployment=${deploymentId}`,
    "--format", "{{.Names}}",
  ]).split("\n").map((value) => value.trim()).filter(Boolean)[0] ?? "";
  if (!backendContainer) throw new Error("could not resolve backend container");
  docker(["update", "--restart=no", backendContainer]);
  docker(["stop", "--time", "1", backendContainer]);

  // A DOWN sample can be shorter than a browser polling interval because the
  // Agent performs bounded recovery immediately after persisting the incident.
  // The UI must therefore expose the outage durably through its visible event
  // stream, while the health card remains an accurate view of current state.
  await poll("Control Plane persists DOWN incident for observed deployment", async () => {
    const rows = await request(`/v0/deployments/${deploymentId}/events`, { headers });
    const text = Array.isArray(rows) ? rows.map((row) => row?.message ?? "").join("\n") : "";
    return text.includes("runtime-health DOWN") ? { done: true, value: text } : { last: text.slice(-800) };
  }, 45000, 250);

  const visibleDown = await poll("browser exposes DOWN incident", async () => {
    const health = await browserHealth();
    const events = await cdp.evaluate(`document.querySelector(".cLogs")?.innerText ?? ""`);
    return health.includes("DOWN") || events.includes("runtime-health DOWN")
      ? { done: true, value: { health, events } }
      : { last: { health, events: events.slice(-800) } };
  }, 45000, 250);

  const downRestartText = await browserRestarts();
  await poll("browser displays recovered HEALTHY and restart count", async () => {
    const health = await browserHealth();
    const restarts = await browserRestarts();
    return health.includes("HEALTHY") && restarts.includes(String(initialMetrics.restartCount + 1))
      ? { done: true, value: { health, restarts } }
      : { last: { health, restarts } };
  }, 60000, 250);

  const eventsText = await cdp.evaluate(`document.querySelector(".cLogs")?.innerText ?? ""`);
  assert.ok(eventsText.includes("runtime-health DOWN"), `browser log stream did not show DOWN event: ${eventsText}`);
  assert.ok(visibleDown.health.includes("DOWN") || visibleDown.events.includes("runtime-health DOWN"));

  console.log(JSON.stringify({
    ok: true,
    deploymentId,
    initialRestartCount: initialMetrics.restartCount,
    downRestartText,
    verified: [
      "real-browser-canonical-web",
      "ui-shows-healthy-before-fault",
      "ui-exposes-down-incident-after-ready-container-kill",
      "ui-shows-restart-count",
      "ui-recovers-to-healthy",
      "ui-event-stream-shows-down-transition",
    ],
  }, null, 2));
} finally {
  if (cdp?.ws?.readyState === WebSocket.OPEN) cdp.ws.close();
  if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  if (backendContainer) spawnSync("docker", ["rm", "-f", backendContainer], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(chromeDir, { recursive: true, force: true }).catch(() => undefined);
}
