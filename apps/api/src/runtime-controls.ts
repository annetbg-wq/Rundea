import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AgentCommand, AgentEvent } from "@rundea/contracts";
import { registerGitHubAutodeployRoutes } from "./github-autodeploy";
import type { NodeCommandSocket } from "./node-qualification";
import { copyDeploymentEnvironment } from "./service-variables";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type DispatchQueued = (nodeId: string) => Promise<void>;
type Queryable = Pool | PoolClient;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rollbackTargetStatuses = new Set(["READY", "ROLLED_BACK"]);

function validUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function safeServiceName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "service";
}

async function latestReadyForService(db: Queryable, serviceName: string) {
  const result = await db.query(
    `SELECT id,service_name,node_id,host_port,container_port,healthcheck_path,environment_snapshot_at,image_id,source_commit_sha
       FROM deployments
      WHERE service_name=$1 AND status='READY'
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [serviceName],
  );
  return result.rows[0] as Record<string, any> | undefined;
}

async function nodeHasRuntimeAction(db: Queryable, nodeId: string): Promise<boolean> {
  const result = await db.query("SELECT id FROM runtime_actions WHERE node_id=$1 AND status='RUNNING' LIMIT 1", [nodeId]);
  return (result.rowCount ?? 0) > 0;
}

async function nodeHasActiveDeployment(db: Queryable, nodeId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM deployments
      WHERE node_id=$1 AND status IN ('QUEUED','BUILDING','DEPLOYING','HEALTHCHECK') LIMIT 1`,
    [nodeId],
  );
  return (result.rowCount ?? 0) > 0;
}

export function registerRuntimeControlRoutes(
  app: FastifyInstance,
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  requireControl: ControlPreHandler,
  dispatchQueued: DispatchQueued,
): void {
  registerGitHubAutodeployRoutes(app, pool, requireControl, dispatchQueued, process.env.RUNDEA_GITHUB_WEBHOOK_SECRET);

  app.get("/v0/runtime-actions", { preHandler: requireControl }, async () => {
    const result = await pool.query(
      `SELECT id,deployment_id,node_id,kind,status,error,created_at,completed_at
         FROM runtime_actions ORDER BY created_at DESC LIMIT 100`,
    );
    return { actions: result.rows };
  });

  app.post<{ Params: { id: string } }>(
    "/v0/deployments/:id/restart",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid deployment id" });
      const initial = await pool.query("SELECT node_id FROM deployments WHERE id=$1", [request.params.id]);
      if (initial.rowCount !== 1) return reply.code(404).send({ error: "deployment not found" });
      const nodeId = initial.rows[0].node_id as string;
      const socket = sockets.get(nodeId);
      if (!socket) return reply.code(409).send({ error: "node is not connected" });

      const actionId = randomUUID();
      let row: Record<string, any>;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM nodes WHERE id=$1 FOR UPDATE", [nodeId]);
        const target = await client.query(
          `SELECT id,service_name,node_id,host_port,healthcheck_path,status
             FROM deployments WHERE id=$1 FOR UPDATE`,
          [request.params.id],
        );
        if (target.rowCount !== 1) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "deployment not found" });
        }
        row = target.rows[0];
        if (row.status !== "READY") {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "only a READY deployment can be restarted" });
        }
        const current = await latestReadyForService(client, row.service_name);
        if (!current || current.id !== row.id) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "only the current READY revision can be restarted" });
        }
        if (await nodeHasActiveDeployment(client, nodeId)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "node has an active deployment operation" });
        }
        if (await nodeHasRuntimeAction(client, nodeId)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "node already has a running runtime action" });
        }
        await client.query(
          "INSERT INTO runtime_actions(id,deployment_id,node_id,kind,status) VALUES($1,$2,$3,'RESTART','RUNNING')",
          [actionId, row.id, nodeId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        request.log.error(error, "restart action could not be created");
        return reply.code(409).send({ error: "restart action could not be created" });
      } finally {
        client.release();
      }

      const command: AgentCommand = {
        type: "restart",
        actionId,
        deploymentId: row!.id,
        serviceName: row!.service_name,
        runtime: {
          containerName: `rundea-${safeServiceName(row!.service_name)}`,
          hostPort: row!.host_port,
          healthcheck: { path: row!.healthcheck_path || "/health", timeoutSeconds: 60 },
        },
      };
      try {
        socket.send(JSON.stringify(command));
      } catch (error) {
        await pool.query(
          "UPDATE runtime_actions SET status='FAILED',error='restart command could not be sent',completed_at=now() WHERE id=$1 AND status='RUNNING'",
          [actionId],
        );
        request.log.error(error, "restart command could not be sent");
        return reply.code(502).send({ error: "restart command could not be sent" });
      }
      return reply.code(202).send({ id: actionId, deploymentId: row!.id, kind: "RESTART", status: "RUNNING" });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v0/deployments/:id/rollback",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid deployment id" });
      const initial = await pool.query("SELECT node_id FROM deployments WHERE id=$1", [request.params.id]);
      if (initial.rowCount !== 1) return reply.code(404).send({ error: "rollback target not found" });
      const nodeId = initial.rows[0].node_id as string;
      const id = randomUUID();
      let target: Record<string, any>;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM nodes WHERE id=$1 FOR UPDATE", [nodeId]);
        const targetResult = await client.query(
          `SELECT id,service_name,node_id,source_repository,source_ref,dockerfile,container_port,host_port,healthcheck_path,
                  status,environment_snapshot_at,source_commit_sha,image_id
             FROM deployments WHERE id=$1 FOR UPDATE`,
          [request.params.id],
        );
        if (targetResult.rowCount !== 1) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "rollback target not found" });
        }
        target = targetResult.rows[0];
        if (!rollbackTargetStatuses.has(target.status)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "rollback target must be a revision that previously reached READY" });
        }
        if (!target.environment_snapshot_at || !target.image_id || !target.source_commit_sha) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "deployment predates immutable rollback snapshots or has no retained artifact identity" });
        }
        const current = await latestReadyForService(client, target.service_name);
        if (!current) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "service has no current READY deployment" });
        }
        if (current.id === target.id) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "target deployment is already the current revision" });
        }
        if (current.node_id !== nodeId) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "v0 rollback requires target and current revision on the same node" });
        }
        if (await nodeHasActiveDeployment(client, nodeId)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "node already has an active deployment operation" });
        }
        if (await nodeHasRuntimeAction(client, nodeId)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "node already has a running runtime action" });
        }
        await client.query(
          `INSERT INTO deployments(
             id,service_name,node_id,source_repository,source_ref,dockerfile,container_port,host_port,healthcheck_path,
             status,operation,rollback_target_id,source_commit_sha,image_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED','ROLLBACK',$10,$11,$12)`,
          [
            id,target.service_name,nodeId,target.source_repository,target.source_ref,target.dockerfile,
            target.container_port,target.host_port,target.healthcheck_path,target.id,target.source_commit_sha,target.image_id,
          ],
        );
        await copyDeploymentEnvironment(client, target.id, id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        request.log.error(error, "rollback deployment could not be created");
        return reply.code(409).send({ error: error instanceof Error ? error.message : "rollback deployment could not be created" });
      } finally {
        client.release();
      }
      await dispatchQueued(nodeId);
      return reply.code(202).send({ id, status: "QUEUED", operation: "ROLLBACK", rollbackTargetId: target!.id });
    },
  );
}

export async function recordRuntimeAction(
  pool: Pool,
  nodeId: string,
  event: Extract<AgentEvent, { type: "runtimeAction" }>,
): Promise<void> {
  if (!validUuid(event.actionId) || !validUuid(event.deploymentId) || event.kind !== "RESTART") throw new Error("invalid runtime action event");
  if (event.error && event.error.length > 500) throw new Error("runtime action error is too long");
  const updated = await pool.query(
    `UPDATE runtime_actions
        SET status=$5,error=$6,completed_at=now()
      WHERE id=$1 AND deployment_id=$2 AND node_id=$3 AND kind=$4 AND status='RUNNING'`,
    [event.actionId,event.deploymentId,nodeId,event.kind,event.ok ? "SUCCEEDED" : "FAILED",event.error ?? null],
  );
  if (updated.rowCount !== 1) throw new Error("stale or unauthorized runtime action result");
}

export async function failRunningRuntimeActionsForNode(pool: Pool, nodeId: string): Promise<void> {
  await pool.query(
    `UPDATE runtime_actions
        SET status='FAILED',error='agent disconnected during runtime action',completed_at=now()
      WHERE node_id=$1 AND status='RUNNING'`,
    [nodeId],
  );
}
