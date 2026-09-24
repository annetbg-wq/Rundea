import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { activateNodeCredential } from "./node-credential.mjs";

const fixtureRepositoryFullName = "render-examples/express-hello-world";
const fixtureRepository = `https://github.com/${fixtureRepositoryFullName}.git`;
const fixtureSha = process.env.RUNDEA_ACCEPTANCE_FIXTURE_SHA ?? "039c34770852fb07cef7f9f0f8534c5de408b207";
const markerHeader = "x-rundea-deployment";

class FatalPollError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeServiceKey(name, serviceId) {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "service";
  return `${cleaned}-${serviceId.replaceAll("-", "").slice(0, 10).toLowerCase()}`;
}

function revisionName(serviceName, serviceId, deploymentId) {
  return `rundea-${runtimeServiceKey(serviceName, serviceId)}-rev-${deploymentId.replaceAll("-", "").toLowerCase().slice(0, 12)}`;
}

export async function runCanonicalAutodeployAcceptance(options = {}) {
  const api = options.api ?? process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
  const controlToken = options.controlToken ?? process.env.RUNDEA_CONTROL_TOKEN;
  const agentBinary = options.agentBinary ?? process.env.RUNDEA_AGENT_BINARY ?? "/tmp/rundea-agent";
  const webhookSecret = options.webhookSecret ?? process.env.RUNDEA_GITHUB_WEBHOOK_SECRET ?? "acceptance-github-webhook-secret";
  const databaseUrl = options.databaseUrl ?? process.env.RUNDEA_ACCEPTANCE_DATABASE_URL ?? "postgres://rundea:rundea@127.0.0.1:5432/rundea";
  if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");

  const headers = { authorization: `Bearer ${controlToken}` };
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const suffix = `${Date.now().toString(36)}-${process.pid}`.replace(/[^a-z0-9-]/g, "");
  const workDir = await mkdtemp(join(tmpdir(), "rundea-canonical-push-"));
  const db = new Pool({ connectionString: databaseUrl });
  let agent;
  let builder;
  let deploymentId = "";
  let buildId = "";
  let service;
  const registryPort = 15001;
  const registryName = `rundea-canonical-registry-${suffix}`;

  async function rawRequest(path, init = {}) {
    const response = await fetch(`${api}${path}`, init);
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { response, body, text };
  }

  async function request(path, init = {}) {
    const result = await rawRequest(path, init);
    if (!result.response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} -> ${result.response.status}: ${typeof result.body === "string" ? result.body : JSON.stringify(result.body)}`);
    }
    return result.body;
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

  async function signedPush(deliveryId) {
    const rawBody = JSON.stringify({
      ref: "refs/heads/main",
      after: fixtureSha,
      deleted: false,
      repository: { full_name: fixtureRepositoryFullName },
      pusher: { name: `rundea-canonical-${suffix}` },
    });
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
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

  try {
    const registry = spawnSync("docker", ["run","-d","--name",registryName,"-p",`127.0.0.1:${registryPort}:5000`,"registry:2"], { encoding:"utf8" });
    if (registry.status !== 0) throw new Error(`canonical registry failed to start: ${registry.stderr || registry.stdout}`);
    await poll("canonical registry", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${registryPort}/v2/`);
        return response.ok ? { done:true, value:true } : { last:response.status };
      } catch (error) {
        return { last:error instanceof Error ? error.message : String(error) };
      }
    }, 30_000, 250);

    const workspace = await request("/v0/workspaces", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ slug: `push-${suffix}`.slice(0, 63), name: "Canonical push acceptance" }),
    });
    const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ slug: `push-${suffix}`.slice(0, 63), name: "Canonical push project" }),
    });

    const discovery = {
      monorepo: { value: false, confidence: "CONFIRMED", evidence: ["acceptance fixture"] },
      serviceCandidates: { value: ["."], confidence: "CONFIRMED", evidence: ["acceptance fixture"] },
      containerPorts: { value: [3001], confidence: "CONFIRMED", evidence: ["acceptance fixture"] },
      environmentVariableNames: { value: [], confidence: "MISSING", evidence: [] },
      services: [{
        name: "push-api",
        path: ".",
        dockerfile: null,
        manifest: "package.json",
        containerPorts: [3001],
        buildArgumentNames: [],
        environmentVariableNames: [],
        healthcheckPath: "/",
        confidence: "CONFIRMED",
        evidence: ["package.json"],
      }],
    };
    await db.query(
      `INSERT INTO project_sources(
         project_id,provider,provider_installation_id,provider_repository_id,repository_full_name,repository_url,
         visibility,default_branch,selected_branch,revision_sha,review_state,discovery,discovered_at,updated_at
       ) VALUES($1,'GITHUB',900001,900001,$2,$3,'PUBLIC','main','main',$4,'READY_FOR_REVIEW',$5::jsonb,now(),now())`,
      [project.id, fixtureRepositoryFullName, `https://github.com/${fixtureRepositoryFullName}`, fixtureSha, JSON.stringify(discovery)],
    );

    const confirmation = await request(`/v0/projects/${project.id}/source/github/confirm`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ services: [{ path: ".", name: "push-api", slug: "push-api" }] }),
    });
    if (confirmation.services?.length !== 1) throw new Error(`confirmation did not create one service: ${JSON.stringify(confirmation)}`);
    service = confirmation.services[0];
    if (service.repositoryFullName !== fixtureRepositoryFullName || service.revisionSha !== fixtureSha || service.containerPort !== 3001) {
      throw new Error(`confirmed service source mismatch: ${JSON.stringify(service)}`);
    }

    const node = await request(`/v0/workspaces/${workspace.id}/nodes`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name: `push-agent-${process.pid}` }),
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
      },
    });

    await poll("canonical push Agent online", async () => {
      if (agent.exitCode !== null) throw new FatalPollError(`Agent exited before becoming ONLINE with code ${agent.exitCode}`);
      const body = await request(`/v0/workspaces/${workspace.id}/nodes`, { headers });
      const row = body.nodes.find((item) => item.id === node.id);
      return row?.status === "ONLINE" ? { done: true, value: row } : { last: row?.status ?? "missing" };
    }, 45_000, 500);

    const autodeploy = await request(`/v0/services/${service.id}/push-autodeploy`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    if (autodeploy.autodeploy?.serviceId !== service.id || autodeploy.autodeploy?.nodeId !== node.id || autodeploy.autodeploy?.branch !== "main") {
      throw new Error(`canonical autodeploy configuration mismatch: ${JSON.stringify(autodeploy)}`);
    }
    if (Object.hasOwn(autodeploy.autodeploy ?? {}, "hostPort") || Object.hasOwn(autodeploy.autodeploy ?? {}, "host_port")) {
      throw new Error("canonical autodeploy response leaked infrastructure host port");
    }

    builder = spawn("npx", ["tsx","apps/builder/src/index.ts"], {
      stdio: ["ignore","inherit","inherit"],
      env: {
        ...process.env,
        RUNDEA_CONTROL_PLANE_URL: api,
        RUNDEA_BUILDER_TOKEN: process.env.RUNDEA_BUILDER_TOKEN ?? "acceptance-builder-token",
        RUNDEA_BUILDER_ID: `canonical-push-${suffix}`,
        RUNDEA_BUILD_POLL_MS: "250",
        RUNDEA_BUILD_TIMEOUT_SECONDS: "180",
        RUNDEA_BUILD_MEMORY_BYTES: "1073741824",
        RUNDEA_BUILD_CPU_QUOTA: "100000",
        RUNDEA_BUILD_CPU_PERIOD: "100000",
      },
    });

    const deliveryId = `canonical-${suffix}`;
    const push = await signedPush(deliveryId);
    if (push.status !== "TRIGGERED" || push.builds?.length !== 1 || push.deployments?.length !== 0) {
      throw new Error(`canonical signed push did not enqueue exactly one Build Engine job: ${JSON.stringify(push)}`);
    }
    buildId = push.builds[0].buildId;
    if (push.builds[0].serviceId !== service.id) throw new Error(`push build service mismatch: ${JSON.stringify(push)}`);

    const pushedBuild = await poll("canonical push build and handoff", async () => {
      if (builder.exitCode !== null) throw new FatalPollError(`Builder exited with code ${builder.exitCode}`);
      const body = await request(`/v0/services/${service.id}/builds`, { headers });
      const row = body.builds.find((item) => item.id === buildId);
      if (!row) return { last: "build not visible yet" };
      if (row.status === "FAILED") throw new FatalPollError(`push build failed: ${row.error}`);
      if (row.status === "PUSHED" && row.deployment_id) return { done:true, value:row };
      return { last:{ status:row.status, deploymentId:row.deployment_id } };
    }, 240_000, 1000);
    deploymentId = pushedBuild.deployment_id;
    if (!pushedBuild.artifact_image_ref || !/@sha256:[0-9a-f]{64}$/.test(pushedBuild.artifact_image_ref)) {
      throw new Error(`canonical push build did not persist immutable artifact: ${JSON.stringify(pushedBuild)}`);
    }

    const ready = await poll("canonical push deployment", async () => {
      const body = await request(`/v0/services/${service.id}/deployments`, { headers });
      const row = body.deployments.find((item) => item.id === deploymentId);
      if (!row) return { last: "deployment not visible yet" };
      if (row.service_id !== service.id) throw new FatalPollError(`push deployment service_id ${row.service_id} != ${service.id}`);
      if (row.source_ref !== fixtureSha) throw new FatalPollError(`push deployment source_ref ${row.source_ref} != ${fixtureSha}`);
      if (!row.artifact_image_ref || !/@sha256:[0-9a-f]{64}$/.test(row.artifact_image_ref)) {
        throw new FatalPollError(`push deployment is missing immutable artifact identity: ${JSON.stringify(row)}`);
      }
      if (row.artifact_source_commit_sha !== fixtureSha) {
        throw new FatalPollError(`push deployment artifact source SHA ${row.artifact_source_commit_sha} != ${fixtureSha}`);
      }
      if (Object.hasOwn(row, "host_port") || Object.hasOwn(row, "hostPort")) {
        throw new FatalPollError("service-scoped deployment response leaked infrastructure host port");
      }
      if (row.status === "READY") return { done: true, value: row };
      if (["FAILED", "CANCELLED", "ROLLED_BACK"].includes(row.status)) throw new FatalPollError(`push deployment reached ${row.status}`);
      return { last: row.status };
    }, 240_000, 1500);

    const storedDeployment = await db.query(
      "SELECT host_port FROM deployments WHERE id=$1 AND service_id=$2",
      [deploymentId, service.id],
    );
    const managedHostPort = Number(storedDeployment.rows[0]?.host_port);
    if (!Number.isInteger(managedHostPort) || managedHostPort < 18000 || managedHostPort > 29999) {
      throw new Error(`push deployment did not retain a Rundea managed port internally: ${storedDeployment.rows[0]?.host_port}`);
    }

    const live = await fetch(`http://127.0.0.1:${managedHostPort}/`);
    const body = await live.text();
    if (!live.ok || !body.includes("Hello from Render!") || live.headers.get(markerHeader) !== deploymentId) {
      throw new Error(`canonical push managed port is not live: status=${live.status} marker=${live.headers.get(markerHeader)} body=${body.slice(0, 160)}`);
    }
    const events = await request(`/v0/deployments/${deploymentId}/events`, { headers });
    if (!events.some((event) => event.kind === "LOG" && event.stream === "system" && event.message?.includes("using immutable prebuilt artifact"))) {
      throw new Error("canonical push deployment did not prove registry-first Agent delivery");
    }
    if (events.some((event) => event.kind === "LOG" && event.message?.includes("source delivered through Rundea broker"))) {
      throw new Error("canonical push unexpectedly used the old production source-build path");
    }

    const duplicate = await signedPush(deliveryId);
    if (duplicate.duplicate !== true || duplicate.status !== "TRIGGERED" || duplicate.buildCount !== 1 || duplicate.deploymentCount !== 0) {
      throw new Error(`canonical push duplicate delivery was not idempotent: ${JSON.stringify(duplicate)}`);
    }

    return {
      ok: true,
      workspaceId: workspace.id,
      projectId: project.id,
      serviceId: service.id,
      nodeId: node.id,
      deploymentId,
      hostPort: managedHostPort,
      verified: [
        "discovery-confirmation-api",
        "confirmed-source-config",
        "service-id-autodeploy",
        "automatic-online-node-selection",
        "managed-host-port-hidden-from-user",
        "signed-github-push",
        "canonical-service-id-on-webhook-build",
        "exact-push-sha",
        "build-engine-off-production",
        "immutable-registry-artifact",
        "automatic-build-to-deploy-handoff",
        "production-agent-prebuilt-pull",
        "live-http-after-push",
        "push-idempotency",
      ],
    };
  } finally {
    if (builder && builder.exitCode === null) {
      builder.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => builder.once("exit", resolve)), sleep(3000)]);
      if (builder.exitCode === null) builder.kill("SIGKILL");
    }
    if (agent && agent.exitCode === null) {
      agent.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => agent.once("exit", resolve)), sleep(3000)]);
      if (agent.exitCode === null) agent.kill("SIGKILL");
    }
    if (service?.id && deploymentId) {
      spawnSync("docker", ["rm", "-f", revisionName(service.name, service.id, deploymentId)], { stdio: "ignore" });
    }
    spawnSync("docker", ["rm", "-f", "rundea-runtime-router"], { stdio: "ignore" });
    spawnSync("docker", ["rm", "-f", registryName], { stdio: "ignore" });
    await db.end().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
