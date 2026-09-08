import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { AgentCommand, AgentEvent, DeploymentStatus } from "@rundea/contracts";
import { deploymentStatuses } from "@rundea/contracts";
import { createOpaqueToken, equalTokenHash, hashToken, parseMasterKey } from "@rundea/crypto";
import { assertTransition } from "@rundea/deployer";
import {
  failRunningIngressForNode,
  recordIngressResult,
  reconcileNodeIngress,
  reconcileServiceDomainsAfterReady,
  registerDomainRoutes,
} from "./domains";
import {
  failRunningQualificationsForNode,
  recordNodeQualification,
  registerNodeQualificationRoutes,
} from "./node-qualification";
import {
  failRunningRuntimeActionsForNode,
  recordRuntimeAction,
  registerRuntimeControlRoutes,
} from "./runtime-controls";
import {
  captureDeploymentEnvironment,
  deleteServiceVariable,
  listServiceVariables,
  loadDeploymentEnvironment,
  upsertServiceVariables,
  type ServiceVariableInput,
} from "./service-variables";
import {
  issueSourceBundleTicket,
  registerSourceBrokerRoutes,
  validateSourceDelivery,
} from "./source-broker";

type NodeSocket = { send(payload: string): void; close(code?: number, reason?: string): void };

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
const masterKeyEncoded = process.env.RUNDEA_MASTER_KEY;
if (!masterKeyEncoded) throw new Error("RUNDEA_MASTER_KEY is required");
const controlTokenHash = hashToken(controlToken);
const masterKey = parseMasterKey(masterKeyEncoded);

const pool = new Pool({ connectionString: databaseUrl });
const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.RUNDEA_WEB_ORIGIN ?? "http://localhost:5173" });
await app.register(websocket);

for (const migration of [
  "001_init.sql",
  "002_service_variables_and_auto_build.sql",
  "003_node_qualification.sql",
  "004_service_domains.sql",
  "005_runtime_controls.sql",
  "007_source_broker.sql",
]) {
  const migrationUrl = new URL(`../migrations/${migration}`, import.meta.url);
  await pool.query(await readFile(migrationUrl, "utf8"));
}
await pool.query("UPDATE nodes SET status='OFFLINE'");
await pool.query("UPDATE node_qualifications SET status='FAILED', failure_reason='control plane restarted during qualification', completed_at=now() WHERE status='RUNNING'");
await pool.query("UPDATE node_ingress_reconciliations SET status='FAILED',error='control plane restarted during ingress reconciliation',completed_at=now() WHERE status='RUNNING'");
await pool.query("UPDATE runtime_actions SET status='FAILED',error='control plane restarted during runtime action',completed_at=now() WHERE status='RUNNING'");
await pool.query(
  `UPDATE service_domains
      SET status=CASE WHEN status='DELETING' THEN 'DELETING' ELSE 'PENDING' END,
          reconciliation_id=NULL,last_error='awaiting node agent reconciliation',verified_at=NULL,updated_at=now()
    WHERE status IN ('CONFIGURING','DELETING')`,
);

const sockets = new Map<string, NodeSocket>();
const serviceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const sourceCommitPattern = /^[0-9a-f]{40}$/;
const imageIdPattern = /^sha256:[0-9a-f]{64}$/;

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

async function requireControl(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearer(request.headers.authorization);
  if (!token || !equalTokenHash(hashToken(token), controlTokenHash)) {
    await reply.code(401).send({ error: "unauthorized" });
  }
}

function requireServiceName(value: string): string {
  if (!serviceNamePattern.test(value)) throw new Error("invalid service name");
  return value;
}

function safeServiceName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "service";
}

async function failQueuedBeforeDispatch(deploymentId: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "UPDATE deployments SET status='FAILED',dispatch_lease_until=NULL,updated_at=now() WHERE id=$1 AND status='QUEUED' RETURNING id",
      [deploymentId],
    );
    if (updated.rowCount === 1) {
      await client.query(
        "INSERT INTO deployment_events(deployment_id,kind,status,message) VALUES($1,'STATUS','FAILED',$2)",
        [deploymentId, reason],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function dispatchQueued(nodeId: string): Promise<void> {
  const socket = sockets.get(nodeId);
  if (!socket) return;
  const client = await pool.connect();
  let row: Record<string, any> | undefined;
  try {
    await client.query("BEGIN");
    const nodeLock = await client.query("SELECT id FROM nodes WHERE id=$1 FOR UPDATE", [nodeId]);
    if (nodeLock.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    const result = await client.query(
      `SELECT id,service_name,source_repository,source_ref,source_delivery,dockerfile,container_port,host_port,healthcheck_path,
              operation,rollback_target_id,image_id
         FROM deployments
        WHERE node_id=$1 AND status='QUEUED' AND (dispatch_lease_until IS NULL OR dispatch_lease_until < now())
          AND NOT EXISTS (
            SELECT 1 FROM deployments active
             WHERE active.node_id=$1
               AND (
                 active.status IN ('BUILDING','DEPLOYING','HEALTHCHECK')
                 OR (active.status='QUEUED' AND active.dispatch_lease_until >= now())
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM runtime_actions action
             WHERE action.node_id=$1 AND action.status='RUNNING'
          )
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
      [nodeId],
    );
    row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      "UPDATE deployments SET dispatch_attempt=dispatch_attempt+1,dispatch_lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
      [row.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!row) return;

  let environment: Record<string, string>;
  try {
    environment = await loadDeploymentEnvironment(pool, masterKey, row.id, row.service_name);
  } catch (error) {
    await pool.query("UPDATE deployments SET dispatch_lease_until=NULL WHERE id=$1 AND status='QUEUED'", [row.id]);
    throw error;
  }

  const runtime = {
    containerName: `rundea-${safeServiceName(row.service_name)}`,
    containerPort: row.container_port,
    hostPort: row.host_port,
    environment,
    healthcheck: { path: row.healthcheck_path ?? "", timeoutSeconds: 60 },
  };

  let command: AgentCommand;
  if (row.operation === "ROLLBACK") {
    if (!row.rollback_target_id || !row.image_id) {
      await failQueuedBeforeDispatch(row.id, "rollback deployment is missing retained artifact identity");
      return;
    }
    command = {
      type: "rollback",
      deploymentId: row.id,
      targetDeploymentId: row.rollback_target_id,
      expectedImageId: row.image_id,
      serviceName: row.service_name,
      runtime,
    };
  } else if (row.source_delivery === "BROKER") {
    try {
      const ticket = await issueSourceBundleTicket(pool, row.id, nodeId, row.source_repository, row.source_ref);
      command = {
        type: "deploy",
        deploymentId: row.id,
        serviceName: row.service_name,
        source: {
          mode: "bundle",
          ref: row.source_ref,
          ticket,
          ...(row.dockerfile ? { dockerfile: row.dockerfile } : {}),
        },
        runtime,
      };
    } catch (error) {
      await failQueuedBeforeDispatch(row.id, error instanceof Error ? error.message : "source bundle ticket could not be issued");
      return;
    }
  } else {
    command = {
      type: "deploy",
      deploymentId: row.id,
      serviceName: row.service_name,
      source: {
        mode: "git",
        repository: row.source_repository,
        ref: row.source_ref,
        ...(row.dockerfile ? { dockerfile: row.dockerfile } : {}),
      },
      runtime,
    };
  }

  try {
    socket.send(JSON.stringify(command));
  } catch (error) {
    await pool.query("UPDATE deployments SET dispatch_lease_until=NULL WHERE id=$1 AND status='QUEUED'", [row.id]);
    throw error;
  }
}

async function recordArtifact(nodeId: string, event: Extract<AgentEvent, { type: "artifact" }>): Promise<void> {
  if (!sourceCommitPattern.test(event.sourceCommitSha)) throw new Error("invalid source commit identity");
  if (!imageIdPattern.test(event.imageId)) throw new Error("invalid Docker image identity");
  if (!event.healthcheckPath.startsWith("/") || event.healthcheckPath.length > 512 || /[\r\n]/.test(event.healthcheckPath)) {
    throw new Error("invalid resolved healthcheck path");
  }
  const updated = await pool.query(
    `UPDATE deployments
        SET source_commit_sha=$3,image_id=$4,healthcheck_path=$5,updated_at=now()
      WHERE id=$1 AND node_id=$2 AND operation='DEPLOY' AND status='BUILDING'`,
    [event.deploymentId, nodeId, event.sourceCommitSha, event.imageId, event.healthcheckPath],
  );
  if (updated.rowCount !== 1) throw new Error("artifact identity rejected for authenticated node or deployment state");
}

async function recordStatus(nodeId: string, event: Extract<AgentEvent, { type: "status" }>): Promise<string> {
  if (!deploymentStatuses.includes(event.status)) throw new Error("unknown deployment status");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query(
      "SELECT status,service_name,operation FROM deployments WHERE id=$1 AND node_id=$2 FOR UPDATE",
      [event.deploymentId, nodeId],
    );
    if (currentResult.rowCount !== 1) throw new Error("deployment not found for authenticated node");
    const current = currentResult.rows[0].status as DeploymentStatus;
    const serviceName = currentResult.rows[0].service_name as string;
    const operation = currentResult.rows[0].operation as string;
    if (current !== event.status) assertTransition(current, event.status);
    const updated = await client.query(
      `UPDATE deployments SET status=$3,runtime_container_id=COALESCE($4,runtime_container_id),dispatch_lease_until=NULL,updated_at=now()
        WHERE id=$1 AND node_id=$2`,
      [event.deploymentId, nodeId, event.status, event.containerId ?? null],
    );
    if (updated.rowCount !== 1) throw new Error("deployment update lost node ownership");
    await client.query(
      `INSERT INTO deployment_events(deployment_id,kind,status,message) VALUES($1,'STATUS',$2,$3)`,
      [event.deploymentId, event.status, event.message ?? null],
    );

    if (operation === "ROLLBACK" && event.status === "READY") {
      const previous = await client.query(
        `SELECT id FROM deployments
          WHERE service_name=$1 AND node_id=$2 AND id<>$3 AND status='READY'
          ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
        [serviceName, nodeId, event.deploymentId],
      );
      if (previous.rowCount === 1) {
        await client.query("UPDATE deployments SET status='ROLLED_BACK',updated_at=now() WHERE id=$1", [previous.rows[0].id]);
        await client.query(
          `INSERT INTO deployment_events(deployment_id,kind,status,message)
           VALUES($1,'STATUS','ROLLED_BACK',$2)`,
          [previous.rows[0].id, `replaced by rollback deployment ${event.deploymentId}`],
        );
      }
    }

    await client.query("COMMIT");
    return serviceName;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordDeploymentLog(nodeId: string, event: Extract<AgentEvent, { type: "log" }>): Promise<void> {
  const inserted = await pool.query(
    `INSERT INTO deployment_events(deployment_id,kind,stream,message,created_at)
     SELECT $1,'LOG',$3,$4,$5 FROM deployments WHERE id=$1 AND node_id=$2`,
    [event.deploymentId, nodeId, event.stream, event.message.slice(0, 16000), new Date(event.at)],
  );
  if (inserted.rowCount !== 1) throw new Error("deployment log rejected for authenticated node");
}

async function failActiveDeploymentsForNode(nodeId: string, message: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const failed = await client.query(
      `UPDATE deployments
          SET status='FAILED',dispatch_lease_until=NULL,updated_at=now()
        WHERE node_id=$1 AND status IN ('BUILDING','DEPLOYING','HEALTHCHECK')
        RETURNING id`,
      [nodeId],
    );
    for (const row of failed.rows) {
      await client.query(
        `INSERT INTO deployment_events(deployment_id,kind,status,message) VALUES($1,'STATUS','FAILED',$2)`,
        [row.id, message],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});

app.post<{ Body: { name?: string } }>("/v0/nodes", { preHandler: requireControl }, async (request, reply) => {
  const name = request.body?.name?.trim();
  if (!name) return reply.code(400).send({ error: "name is required" });
  const id = randomUUID();
  const nodeToken = createOpaqueToken();
  await pool.query("INSERT INTO nodes(id,name,token_hash) VALUES($1,$2,$3)", [id, name, hashToken(nodeToken)]);
  return reply.code(201).send({ id, name, token: nodeToken });
});

app.get("/v0/nodes", { preHandler: requireControl }, async () => {
  const result = await pool.query("SELECT id,name,status,last_seen_at,created_at FROM nodes ORDER BY created_at DESC");
  return result.rows;
});

registerNodeQualificationRoutes(app, pool, sockets, requireControl);
registerDomainRoutes(app, pool, sockets, requireControl);
registerRuntimeControlRoutes(app, pool, sockets, requireControl, dispatchQueued);
registerSourceBrokerRoutes(app, pool);

app.put<{ Params: { serviceName: string }; Body: { variables?: ServiceVariableInput[] } }>(
  "/v0/services/:serviceName/variables",
  { preHandler: requireControl },
  async (request, reply) => {
    try {
      const serviceName = requireServiceName(request.params.serviceName);
      const variables = request.body?.variables;
      if (!Array.isArray(variables)) return reply.code(400).send({ error: "variables must be an array" });
      await upsertServiceVariables(pool, masterKey, serviceName, variables);
      return reply.send({ variables: await listServiceVariables(pool, masterKey, serviceName) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid variables" });
    }
  },
);

app.get<{ Params: { serviceName: string } }>(
  "/v0/services/:serviceName/variables",
  { preHandler: requireControl },
  async (request, reply) => {
    try {
      const serviceName = requireServiceName(request.params.serviceName);
      return { variables: await listServiceVariables(pool, masterKey, serviceName) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid service" });
    }
  },
);

app.delete<{ Params: { serviceName: string; key: string } }>(
  "/v0/services/:serviceName/variables/:key",
  { preHandler: requireControl },
  async (request, reply) => {
    try {
      const serviceName = requireServiceName(request.params.serviceName);
      const deleted = await deleteServiceVariable(pool, serviceName, request.params.key);
      return deleted ? reply.code(204).send() : reply.code(404).send({ error: "variable not found" });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid variable" });
    }
  },
);

app.get("/v0/deployments", { preHandler: requireControl }, async () => {
  const result = await pool.query(
    `SELECT id,service_name,node_id,source_repository,source_ref,source_delivery,dockerfile,container_port,host_port,healthcheck_path,
            status,runtime_container_id,operation,rollback_target_id,environment_snapshot_at,source_commit_sha,image_id,
            created_at,updated_at
       FROM deployments ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows;
});

app.get<{ Params: { id: string } }>("/v0/deployments/:id/events", { preHandler: requireControl }, async (request) => {
  const result = await pool.query(
    "SELECT id,kind,status,stream,message,created_at FROM deployment_events WHERE deployment_id=$1 ORDER BY id ASC LIMIT 2000",
    [request.params.id],
  );
  return result.rows;
});

app.post<{ Body: { serviceName?: string; nodeId?: string; sourceRepository?: string; sourceRef?: string; sourceDelivery?: string; dockerfile?: string; containerPort?: number; hostPort?: number; healthcheckPath?: string } }>(
  "/v0/deployments",
  { preHandler: requireControl },
  async (request, reply) => {
    const body = request.body ?? {};
    if (!body.serviceName || !body.nodeId || !body.sourceRepository || !body.sourceRef) {
      return reply.code(400).send({ error: "serviceName, nodeId, sourceRepository and sourceRef are required" });
    }
    try {
      requireServiceName(body.serviceName);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid service name" });
    }
    if (!Number.isInteger(body.containerPort) || !Number.isInteger(body.hostPort)) {
      return reply.code(400).send({ error: "containerPort and hostPort must be integers" });
    }
    let sourceDelivery: "DIRECT" | "BROKER";
    try {
      sourceDelivery = validateSourceDelivery(body.sourceDelivery, body.sourceRef);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid source delivery" });
    }

    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO deployments(id,service_name,node_id,source_repository,source_ref,source_delivery,dockerfile,container_port,host_port,healthcheck_path,status,operation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'QUEUED','DEPLOY')`,
        [id, body.serviceName, body.nodeId, body.sourceRepository, body.sourceRef, sourceDelivery, body.dockerfile?.trim() || null, body.containerPort, body.hostPort, body.healthcheckPath?.trim() ?? ""],
      );
      await captureDeploymentEnvironment(client, id, body.serviceName);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error);
      return reply.code(400).send({ error: "deployment could not be created" });
    } finally {
      client.release();
    }
    await dispatchQueued(body.nodeId);
    return reply.code(201).send({ id, status: "QUEUED", operation: "DEPLOY", sourceDelivery, agentConnected: sockets.has(body.nodeId) });
  },
);

app.get("/v0/agent/ws", { websocket: true }, async (socket, request) => {
  const nodeIdHeader = request.headers["x-rundea-node-id"];
  const nodeId = Array.isArray(nodeIdHeader) ? nodeIdHeader[0] : nodeIdHeader;
  const token = bearer(request.headers.authorization);
  if (!nodeId || !token) return socket.close(1008, "missing node credentials");
  const result = await pool.query("SELECT token_hash FROM nodes WHERE id=$1", [nodeId]);
  if (result.rowCount !== 1 || !equalTokenHash(result.rows[0].token_hash, hashToken(token))) {
    return socket.close(1008, "invalid node credentials");
  }

  const previous = sockets.get(nodeId);
  if (previous && previous !== socket) previous.close(1012, "replaced by newer agent connection");
  sockets.set(nodeId, socket);
  await pool.query("UPDATE nodes SET status='ONLINE',last_seen_at=now() WHERE id=$1", [nodeId]);
  await dispatchQueued(nodeId);
  await reconcileNodeIngress(pool, sockets, nodeId);

  let messageQueue = Promise.resolve();
  socket.on("message", (raw: Buffer) => {
    messageQueue = messageQueue
      .then(async () => {
        if (sockets.get(nodeId) !== socket) return;
        const event = JSON.parse(raw.toString()) as AgentEvent;
        if (event.type === "heartbeat") {
          await pool.query("UPDATE nodes SET status='ONLINE',last_seen_at=now() WHERE id=$1", [nodeId]);
          await dispatchQueued(nodeId);
          return;
        }
        if (event.type === "artifact") {
          await recordArtifact(nodeId, event);
          return;
        }
        if (event.type === "status") {
          const serviceName = await recordStatus(nodeId, event);
          if (event.status === "READY") await reconcileServiceDomainsAfterReady(pool, sockets, serviceName, nodeId);
          if (["READY", "FAILED", "CANCELLED", "ROLLED_BACK"].includes(event.status)) await dispatchQueued(nodeId);
          return;
        }
        if (event.type === "runtimeAction") {
          await recordRuntimeAction(pool, nodeId, event);
          await dispatchQueued(nodeId);
          return;
        }
        if (event.type === "qualification") {
          await recordNodeQualification(pool, nodeId, event);
          return;
        }
        if (event.type === "ingress") {
          await recordIngressResult(pool, nodeId, event);
          return;
        }
        if (event.type === "log") {
          await recordDeploymentLog(nodeId, event);
        }
      })
      .catch((error) => {
        request.log.error(error, "invalid agent event");
      });
  });

  socket.on("close", async () => {
    if (sockets.get(nodeId) === socket) {
      await messageQueue;
      if (sockets.get(nodeId) !== socket) return;
      sockets.delete(nodeId);
      await pool.query("UPDATE nodes SET status='OFFLINE' WHERE id=$1", [nodeId]).catch(() => undefined);
      await failActiveDeploymentsForNode(nodeId, "agent disconnected during deployment").catch((error) => request.log.error(error, "failed to reconcile disconnected deployment"));
      await failRunningRuntimeActionsForNode(pool, nodeId).catch((error) => request.log.error(error, "failed to reconcile disconnected runtime action"));
      await failRunningQualificationsForNode(pool, nodeId).catch((error) => request.log.error(error, "failed to reconcile disconnected qualification"));
      await failRunningIngressForNode(pool, nodeId).catch((error) => request.log.error(error, "failed to reconcile disconnected ingress"));
    }
  });
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ host: "0.0.0.0", port });

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
