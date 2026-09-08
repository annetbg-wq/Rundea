import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
const agentBinary = process.env.RUNDEA_AGENT_BINARY;
const githubWebhookSecret = process.env.RUNDEA_GITHUB_WEBHOOK_SECRET;
const fixtureRepository = "https://github.com/render-examples/express-hello-world.git";
const privateFixtureRepository = "https://github.com/private/fixture.git";
const privateFixtureFullName = "private/fixture";
const fixtureRef = process.env.RUNDEA_ACCEPTANCE_FIXTURE_REF ?? "main";
const expectedFixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
const hostPort = Number(process.env.RUNDEA_ACCEPTANCE_HOST_PORT ?? "18081");
const fakeGitHubPort = Number(process.env.RUNDEA_ACCEPTANCE_FAKE_GITHUB_PORT ?? "19090");
const fakeInstallationToken = "acceptance-installation-token";
const terminal = new Set(["READY", "FAILED", "CANCELLED", "ROLLED_BACK"]);
const imageIdPattern = /^sha256:[0-9a-f]{64}$/;

if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
if (!agentBinary) throw new Error("RUNDEA_AGENT_BINARY is required");
if (!githubWebhookSecret) throw new Error("RUNDEA_GITHUB_WEBHOOK_SECRET is required");
if (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535) throw new Error("invalid acceptance host port");
if (!Number.isInteger(fakeGitHubPort) || fakeGitHubPort < 1024 || fakeGitHubPort > 65535) throw new Error("invalid fake GitHub port");

const headers = { authorization: `Bearer ${controlToken}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };
const serviceName = `acceptance-${Date.now().toString(36)}`;
const workDir = await mkdtemp(join(tmpdir(), "rundea-acceptance-"));
let agent;
let nodeToken;
let fakeGitHub;
const deploymentIds = [];
const fakeGitHubStats = { tokenRequests: 0, archiveRequests: 0 };

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

async function poll(label, fn, timeoutMs = 180_000, intervalMs = 1000) {
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

async function deployments() {
  return await request("/v0/deployments", { headers });
}

async function deployment(id) {
  return (await deployments()).find((item) => item.id === id);
}

async function waitDeployment(id, label) {
  return await poll(label, async () => {
    const row = await deployment(id);
    if (!row) return { last: "deployment not visible yet" };
    if (row.status === "READY") return { done: true, value: row };
    if (terminal.has(row.status)) throw new FatalPollError(`${label} reached ${row.status}`);
    return { last: row.status };
  }, 240_000, 1500);
}

async function createPrivateFixtureArchive() {
  const parent = join(workDir, "fake-github");
  const rootName = `private-fixture-${expectedFixtureSha.slice(0, 12)}`;
  const root = join(parent, rootName);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "rundea-private-acceptance-fixture",
    version: "1.0.0",
    private: true,
    scripts: { start: "node index.js" },
  }, null, 2));
  await writeFile(join(root, "index.js"), `const http = require("http");\nconst port = Number(process.env.PORT || 3001);\nconst host = process.env.HOST || "0.0.0.0";\nhttp.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("Hello from private Rundea fixture!\\n"); }).listen(port, host);\n`);
  const archivePath = join(parent, "private-fixture.tar.gz");
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", parent, rootName], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`failed to build fake GitHub archive: ${tar.stderr}`);
  return await readFile(archivePath);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("fake GitHub request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startFakeGitHub() {
  const archive = await createPrivateFixtureArchive();
  fakeGitHub = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${fakeGitHubPort}`);
      if (req.method === "POST" && url.pathname === "/app/installations/4242/access_tokens") {
        const auth = req.headers.authorization ?? "";
        const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const parts = jwt.split(".");
        if (parts.length !== 3) {
          res.writeHead(401); res.end("invalid app jwt"); return;
        }
        let claims;
        try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { claims = null; }
        if (claims?.iss !== "123456" || typeof claims?.iat !== "number" || typeof claims?.exp !== "number" || claims.exp <= claims.iat) {
          res.writeHead(401); res.end("invalid app claims"); return;
        }
        const raw = await readRequestBody(req);
        let body;
        try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; }
        if (body?.repositories?.length !== 1 || body.repositories[0] !== "fixture" || body?.permissions?.contents !== "read") {
          res.writeHead(400); res.end("installation token was not least-privilege scoped"); return;
        }
        fakeGitHubStats.tokenRequests += 1;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: fakeInstallationToken, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
        return;
      }
      if (req.method === "GET" && url.pathname === `/repos/${privateFixtureFullName}/tarball/${expectedFixtureSha}`) {
        if (req.headers.authorization !== `Bearer ${fakeInstallationToken}`) {
          res.writeHead(401); res.end("installation token missing"); return;
        }
        fakeGitHubStats.archiveRequests += 1;
        res.writeHead(200, { "content-type": "application/gzip", "content-length": String(archive.length) });
        res.end(archive);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    })().catch((error) => {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise((resolve, reject) => {
    fakeGitHub.once("error", reject);
    fakeGitHub.listen(fakeGitHubPort, "127.0.0.1", resolve);
  });
}

async function createDeployment() {
  const body = await request("/v0/deployments", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      serviceName,
      nodeId,
      sourceRepository: fixtureRepository,
      sourceRef: fixtureRef,
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
    }),
  });
  deploymentIds.push(body.id);
  return body.id;
}

async function configurePrivateRepository() {
  const body = await request("/v0/github/repositories", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ repository: privateFixtureRepository, installationId: "4242" }),
  });
  if (body.repository?.repository_full_name !== privateFixtureFullName || body.repository?.installation_id !== "4242") {
    throw new Error(`unexpected private GitHub repository mapping: ${JSON.stringify(body)}`);
  }
}

async function configureAutodeploy() {
  await configurePrivateRepository();
  const body = await request(`/v0/services/${serviceName}/autodeploy`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      nodeId,
      repository: privateFixtureRepository,
      branch: "main",
      containerPort: 3001,
      hostPort,
      healthcheckPath: "/",
      enabled: true,
    }),
  });
  if (body.autodeploy?.repository_full_name !== privateFixtureFullName || body.autodeploy?.source_branch !== "main") {
    throw new Error(`unexpected autodeploy configuration: ${JSON.stringify(body)}`);
  }
}

async function signedPush(deliveryId) {
  const rawBody = JSON.stringify({
    ref: "refs/heads/main",
    after: expectedFixtureSha,
    deleted: false,
    repository: { full_name: privateFixtureFullName },
  });
  const signature = `sha256=${createHmac("sha256", githubWebhookSecret).update(rawBody).digest("hex")}`;
  const response = await fetch(`${api}/v0/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub webhook -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

async function createDeploymentFromPush() {
  await configureAutodeploy();
  const deliveryId = `acceptance-${Date.now().toString(36)}-${process.pid}`;
  const first = await signedPush(deliveryId);
  if (first.status !== "TRIGGERED" || first.deployments?.length !== 1 || first.deployments[0]?.serviceName !== serviceName) {
    throw new Error(`signed push did not trigger exactly one service deployment: ${JSON.stringify(first)}`);
  }
  const deploymentId = first.deployments[0].deploymentId;
  deploymentIds.push(deploymentId);

  const duplicate = await signedPush(deliveryId);
  if (duplicate.duplicate !== true || duplicate.status !== "TRIGGERED" || duplicate.deploymentCount !== 1) {
    throw new Error(`duplicate GitHub delivery was not idempotent: ${JSON.stringify(duplicate)}`);
  }

  const replayDeliveryId = `${deliveryId}-replay`;
  const replay = await signedPush(replayDeliveryId);
  if (replay.duplicate !== true || replay.status !== "TRIGGERED" || replay.deploymentCount !== 1 || replay.originalDeliveryId !== deliveryId) {
    throw new Error(`replayed signed GitHub body created a new event: ${JSON.stringify(replay)}`);
  }

  const deliveries = await request("/v0/github/deliveries", { headers });
  const recorded = deliveries.deliveries?.find((item) => item.delivery_id === deliveryId);
  if (!recorded || recorded.status !== "TRIGGERED" || Number(recorded.deployment_count) !== 1) {
    throw new Error(`GitHub delivery observability mismatch: ${JSON.stringify(recorded)}`);
  }
  if (!recorded.deployments?.some((item) => item.serviceName === serviceName && item.deploymentId === deploymentId)) {
    throw new Error(`GitHub delivery is not linked to triggered deployment: ${JSON.stringify(recorded)}`);
  }
  if (deliveries.deliveries?.some((item) => item.delivery_id === replayDeliveryId)) {
    throw new Error("replayed signed GitHub body should not create a second delivery record");
  }
  return deploymentId;
}

function assertArtifact(row, label) {
  if (row.source_commit_sha !== expectedFixtureSha) {
    throw new Error(`${label} resolved unexpected source SHA ${row.source_commit_sha}; expected ${expectedFixtureSha}`);
  }
  if (!imageIdPattern.test(row.image_id ?? "")) throw new Error(`${label} has invalid image identity ${row.image_id}`);
  if (!row.environment_snapshot_at) throw new Error(`${label} has no immutable environment snapshot`);
  if (row.healthcheck_path !== "/") throw new Error(`${label} resolved unexpected healthcheck ${row.healthcheck_path}`);
}

async function assertService(label, expectedText) {
  const response = await fetch(`http://127.0.0.1:${hostPort}/`);
  const body = await response.text();
  if (!response.ok || !body.includes(expectedText)) {
    throw new Error(`${label} service check failed: ${response.status} ${body.slice(0, 160)}`);
  }
}

async function assertPrivateSourceCannotBeFetchedAgain(deploymentId) {
  const response = await fetch(`${api}/v0/deployments/${deploymentId}/source-archive`, {
    headers: { authorization: `Bearer ${nodeToken}`, "x-rundea-node-id": nodeId },
  });
  if (![409, 410].includes(response.status)) {
    throw new Error(`completed private source unexpectedly remained fetchable: HTTP ${response.status}`);
  }
  await response.body?.cancel();
}

async function restart(deploymentId) {
  const action = await request(`/v0/deployments/${deploymentId}/restart`, { method: "POST", headers });
  return await poll("restart action", async () => {
    const body = await request("/v0/runtime-actions", { headers });
    const row = body.actions.find((item) => item.id === action.id);
    if (!row) return { last: "action not visible yet" };
    if (row.status === "SUCCEEDED") return { done: true, value: row };
    if (row.status === "FAILED") throw new FatalPollError(`restart failed: ${row.error ?? "unknown error"}`);
    return { last: row.status };
  }, 120_000, 1000);
}

async function rollback(targetId, label) {
  const created = await request(`/v0/deployments/${targetId}/rollback`, { method: "POST", headers });
  deploymentIds.push(created.id);
  return await waitDeployment(created.id, label);
}

let nodeId;
try {
  await startFakeGitHub();
  const health = await fetch(`${api}/health`);
  if (!health.ok) throw new Error(`control plane health returned ${health.status}`);

  const node = await request("/v0/nodes", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: `acceptance-${process.pid}` }),
  });
  nodeId = node.id;
  nodeToken = node.token;

  agent = spawn(agentBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      RUNDEA_CONTROL_PLANE_URL: api,
      RUNDEA_NODE_ID: node.id,
      RUNDEA_NODE_TOKEN: node.token,
      RUNDEA_WORK_DIR: workDir,
    },
  });

  await poll("agent online", async () => {
    if (agent.exitCode !== null) throw new FatalPollError(`Agent exited before becoming ONLINE with code ${agent.exitCode}`);
    const nodes = await request("/v0/nodes", { headers });
    const row = nodes.find((item) => item.id === node.id);
    return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.status ?? "missing" };
  }, 45_000, 500);

  const firstId = await createDeploymentFromPush();
  const first = await waitDeployment(firstId, "private GitHub push deployment");
  assertArtifact(first, "private GitHub push deployment");
  await assertService("private GitHub push deployment", "Hello from private Rundea fixture!");
  if (fakeGitHubStats.tokenRequests !== 1 || fakeGitHubStats.archiveRequests !== 1) {
    throw new Error(`private source did not use exactly one GitHub App token/archive exchange: ${JSON.stringify(fakeGitHubStats)}`);
  }
  await assertPrivateSourceCannotBeFetchedAgain(firstId);

  await restart(firstId);
  await assertService("restart", "Hello from private Rundea fixture!");

  const secondId = await createDeployment();
  const second = await waitDeployment(secondId, "public fallback deployment");
  assertArtifact(second, "public fallback deployment");
  await assertService("public fallback deployment", "Hello from Render!");
  if (fakeGitHubStats.archiveRequests !== 1) throw new Error("public deployment unexpectedly used private source broker");

  const rollbackOne = await rollback(firstId, "rollback to private revision");
  assertArtifact(rollbackOne, "rollback to private revision");
  await assertService("rollback to private revision", "Hello from private Rundea fixture!");

  const secondAfterRollback = await deployment(secondId);
  if (secondAfterRollback?.status !== "ROLLED_BACK") {
    throw new Error(`second deployment should be ROLLED_BACK, got ${secondAfterRollback?.status}`);
  }

  const rollbackTwo = await rollback(secondId, "rollback chain to public revision");
  assertArtifact(rollbackTwo, "rollback chain to public revision");
  await assertService("rollback chain", "Hello from Render!");

  console.log(JSON.stringify({
    ok: true,
    nodeId,
    serviceName,
    fixtureSha: expectedFixtureSha,
    deployments: deploymentIds,
    fakeGitHub: fakeGitHubStats,
    verified: [
      "agent-online",
      "signed-github-push",
      "github-delivery-idempotency",
      "github-body-replay-protection",
      "github-delivery-observability",
      "github-app-token-exchange",
      "private-source-broker",
      "private-source-not-reusable",
      "public-git-fallback",
      "exact-source-commit",
      "node-auto-build",
      "artifact-identity",
      "http-health",
      "restart",
      "exact-rollback",
      "rollback-chain",
    ],
  }, null, 2));
} finally {
  if (agent && agent.exitCode === null) {
    agent.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => agent.once("exit", resolve)),
      sleep(3000),
    ]);
    if (agent.exitCode === null) agent.kill("SIGKILL");
  }
  if (fakeGitHub) await new Promise((resolve) => fakeGitHub.close(resolve));
  spawnSync("docker", ["rm", "-f", `rundea-${serviceName}`], { stdio: "ignore" });
  spawnSync("docker", ["rm", "-f", `rundea-${serviceName}-rollback-backup`], { stdio: "ignore" });
  await rm(workDir, { recursive: true, force: true });
}
