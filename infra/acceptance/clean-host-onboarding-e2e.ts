import https from "node:https";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { createNodeInstallCommand } from "../../apps/web/src/node-install-command";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const origin = process.env.RUNDEA_ACCEPTANCE_HTTPS_ORIGIN ?? "https://rundea.local:4443";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const tlsKey = process.env.RUNDEA_ACCEPTANCE_TLS_KEY;
const tlsCert = process.env.RUNDEA_ACCEPTANCE_TLS_CERT;
if (!controlToken || !tlsKey || !tlsCert) throw new Error("control token and TLS key/cert are required");

function run(command: string, args: string[] = [], options: Record<string, unknown> = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] } as any);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function control(path: string, init: RequestInit = {}) {
  const headers = {
    authorization: `Bearer ${controlToken}`,
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    ...(init.headers ?? {}),
  };
  const response = await fetch(api + path, { ...init, headers });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return { response, body };
}

const upgradedSockets = new Set<Socket>();

function createHttpsProxy() {
  const target = new URL(api);
  const server = https.createServer(
    { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) },
    (request, response) => {
      const upstream = http.request({
        hostname: target.hostname,
        port: Number(target.port || 80),
        path: request.url,
        method: request.method,
        headers: request.headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", (error) => {
        response.statusCode = 502;
        response.end(String(error));
      });
      request.pipe(upstream);
    },
  );

  server.on("upgrade", (request, socket, head) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    const upstream = http.request({
      hostname: target.hostname,
      port: Number(target.port || 80),
      path: request.url,
      method: request.method,
      headers: request.headers,
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      upgradedSockets.add(upstreamSocket);
      upstreamSocket.once("close", () => upgradedSockets.delete(upstreamSocket));
      const headers: string[] = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      }
      socket.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on("response", (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });

  return server;
}

async function waitForNode(workspaceId: string, nodeId: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = (await control(`/v0/workspaces/${workspaceId}/nodes?includeArchived=true`)).body.nodes.find((node: any) => node.id === nodeId);
    if (last?.status === "ONLINE" && last?.lifecycleStatus === "ACTIVE") return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`installed node did not become ONLINE: ${JSON.stringify(last)}`);
}

async function main() {
for (const path of [
  "/etc/rundea",
  "/var/lib/rundea",
  "/etc/systemd/system/rundea-agent.service",
  "/usr/local/bin/rundea-agent",
]) {
  if (existsSync(path)) throw new Error(`clean-host precondition failed; ${path} already exists`);
}

const proxy = createHttpsProxy();
const port = Number(new URL(origin).port || 443);
await new Promise<void>((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(port, "127.0.0.1", () => resolve());
});

let nodeId = "";
let bootstrapToken = "";
try {
  const suffix = Date.now().toString(36);
  const workspace = (await control("/v0/workspaces", {
    method: "POST",
    body: JSON.stringify({ slug: "cleanhost-" + suffix, name: "Clean Host " + suffix }),
  })).body;
  const created = await control(`/v0/workspaces/${workspace.id}/nodes`, {
    method: "POST",
    body: JSON.stringify({ name: "clean-host-" + suffix }),
  });
  nodeId = created.body.id;
  bootstrapToken = created.body.token;
  if (!bootstrapToken) throw new Error("node creation did not return one-time bootstrap token");
  if (!String(created.response.headers.get("cache-control") ?? "").includes("no-store")) {
    throw new Error("bootstrap response is not no-store");
  }

  const installCommand = createNodeInstallCommand(origin, { id: nodeId, token: bootstrapToken });
  if (!installCommand) throw new Error("Nodes UI command builder refused canonical HTTPS origin");

  const install = await run("/bin/bash", ["-lc", installCommand], {
    env: { ...process.env, RUNDEA_MIN_FREE_DISK_MB: "512" },
  });
  if (!install.stdout.includes(`Rundea node ${nodeId} is ONLINE`)) {
    throw new Error(`installer did not report server-authoritative ONLINE\n${install.stdout}\n${install.stderr}`);
  }

  const node = await waitForNode(workspace.id, nodeId);
  if (node.agentVersion !== "0.1.14") throw new Error(`unexpected installed Agent version ${node.agentVersion}`);
  for (const capability of [
    "artifactRetention","buildArgs","buildGuardrails","continuousHealth","managedIngress","managedRedis",
    "nodeCapacity","nodeDiskMetrics","nodeMaintenance","persistentVolumes","privateNetworking","resourceGuardrails","runtimeMetrics",
  ]) {
    if (!node.agentCapabilities.includes(capability)) throw new Error(`installed Agent missing capability ${capability}`);
  }

  const active = await run("systemctl", ["is-active", "rundea-agent"]);
  if (active.stdout.trim() !== "active") throw new Error("rundea-agent.service is not active");
  const enabled = await run("systemctl", ["is-enabled", "rundea-agent"]);
  if (enabled.stdout.trim() !== "enabled") throw new Error("rundea-agent.service is not enabled");

  const identity = JSON.parse((await run("/usr/local/bin/rundea-agent", ["--identity"])).stdout);
  if (identity.agentVersion !== node.agentVersion || identity.buildSha !== node.agentBuildSha) {
    throw new Error(`installed binary identity does not match Control Plane: ${JSON.stringify({ identity, node })}`);
  }

  const envMode = (await run("sudo", ["stat", "-c", "%a", "/etc/rundea/agent.env"])).stdout.trim();
  if (envMode !== "600") throw new Error(`agent.env mode is ${envMode}, expected 600`);
  const envText = (await run("sudo", ["cat", "/etc/rundea/agent.env"])).stdout;
  if (envText.includes(bootstrapToken)) throw new Error("one-time bootstrap token persisted on disk");
  const permanentMatch = envText.match(/^RUNDEA_NODE_TOKEN=(.+)$/m);
  if (!permanentMatch || permanentMatch[1] === bootstrapToken) throw new Error("permanent Agent credential was not rotated");

  const replay = await fetch(`${origin}/v0/nodes/${nodeId}/bootstrap/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${bootstrapToken}`, "content-type": "application/json" },
    body: JSON.stringify({ agentToken: "a".repeat(64) }),
  });
  if (replay.status !== 401) throw new Error(`one-time bootstrap token replay returned ${replay.status}`);

  const status = await fetch(`${origin}/v0/nodes/${nodeId}/self/status`, {
    headers: { authorization: `Bearer ${permanentMatch[1]}` },
  });
  if (status.status !== 200 || (await status.text()).trim() !== "ONLINE") {
    throw new Error("permanent credential does not prove ONLINE after canonical install");
  }

  console.log(JSON.stringify({
    ok: true,
    nodeId,
    verified: [
      "fresh-systemd-host-precondition",
      "exact-nodes-ui-one-command",
      "https-installer-download",
      "pinned-agent-checksum-and-capability-preflight",
      "one-time-bootstrap-rotation",
      "systemd-enabled-and-active",
      "server-authoritative-online",
      "agent-version-buildsha-and-capabilities-visible",
      "bootstrap-token-not-persisted",
      "bootstrap-replay-rejected",
      "permanent-node-self-status-online",
    ],
  }, null, 2));
} finally {
  try { await run("sudo", ["systemctl", "disable", "--now", "rundea-agent"]); } catch {}
  try { await run("sudo", ["rm", "-rf", "/etc/rundea", "/var/lib/rundea", "/etc/systemd/system/rundea-agent.service", "/usr/local/bin/rundea-agent"]); } catch {}
  try { await run("sudo", ["systemctl", "daemon-reload"]); } catch {}
  for (const socket of upgradedSockets) socket.destroy();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
