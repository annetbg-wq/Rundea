import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentEvent } from "@rundea/contracts";
import type { NodeCommandSocket } from "./node-qualification";
import { createOpaqueToken, hashToken } from "@rundea/crypto";
import { internalLegacyWorkspaceId } from "./service-scope";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revokedTokenHash = "0".repeat(64);
const maintenanceCapability = "nodeMaintenance";
const immutableBuildShaPattern = /^[0-9a-f]{40}$/;

function requireUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!uuidPattern.test(normalized)) throw new Error(`${label} must be a UUID`);
  return normalized;
}

function requireNodeName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name || name.length > 120 || /[\r\n\u0000]/.test(name)) throw new Error("node name must contain 1-120 safe characters");
  return name;
}

function nodeView(row: Record<string, any>) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    lifecycleStatus: row.lifecycle_status,
    lastSeenAt: row.last_seen_at ?? undefined,
    agentVersion: row.agent_version ?? undefined,
    agentBuildSha: row.agent_build_sha ?? undefined,
    agentCapabilities: row.agent_capabilities ?? [],
    publicAddresses: row.public_addresses ?? [],
    compatibilityError: row.compatibility_error ?? undefined,
    agentConnectedAt: row.agent_connected_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
  };
}

function maintenanceView(row: Record<string, any>) {
  return {
    id: row.id,
    nodeId: row.node_id,
    kind: row.kind,
    status: row.status,
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    resultAgentVersion: row.result_agent_version ?? undefined,
    resultBuildSha: row.result_build_sha ?? undefined,
  };
}

function validateMaintenanceEvent(event: Extract<AgentEvent, { type: "nodeMaintenance" }>): void {
  if (!uuidPattern.test(event.actionId)) throw new Error("invalid node maintenance action id");
  if (!["UPDATE_AGENT", "CLEANUP_NODE"].includes(event.kind)) throw new Error("invalid node maintenance kind");
  if (event.error && event.error.length > 1000) throw new Error("node maintenance error is too long");
  if (event.agentVersion && !/^\d+\.\d+\.\d+$/.test(event.agentVersion)) throw new Error("invalid maintenance Agent version");
  if (event.buildSha && event.buildSha !== "development" && !immutableBuildShaPattern.test(event.buildSha)) {
    throw new Error("invalid maintenance Agent build SHA");
  }
  if (event.ok && event.kind === "UPDATE_AGENT" && (!event.agentVersion || !event.buildSha)) {
    throw new Error("successful Agent update must report version and build SHA");
  }
}

export async function recordNodeMaintenance(
  pool: Pool,
  nodeId: string,
  event: Extract<AgentEvent, { type: "nodeMaintenance" }>,
): Promise<boolean> {
  validateMaintenanceEvent(event);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT kind,status FROM node_maintenance_actions WHERE id=$1 AND node_id=$2 FOR UPDATE",
      [event.actionId, nodeId],
    );
    if (current.rowCount !== 1 || current.rows[0].status !== "RUNNING") {
      throw new Error("node maintenance action is stale or unknown");
    }
    if (current.rows[0].kind !== event.kind) throw new Error("node maintenance kind mismatch");

    await client.query(
      `UPDATE node_maintenance_actions
          SET status=$3,error=$4,result_agent_version=$5,result_build_sha=$6,completed_at=now()
        WHERE id=$1 AND node_id=$2`,
      [
        event.actionId,
        nodeId,
        event.ok ? "SUCCEEDED" : "FAILED",
        event.ok ? null : event.error ?? "node maintenance failed",
        event.agentVersion ?? null,
        event.buildSha ?? null,
      ],
    );

    if (event.ok && event.kind === "CLEANUP_NODE") {
      const archived = await client.query(
        `UPDATE nodes
            SET lifecycle_status='ARCHIVED',archived_at=now(),status='OFFLINE',agent_connected_at=NULL,
                token_hash=$2,compatibility_error='node cleaned and archived; credential revoked'
          WHERE id=$1 AND lifecycle_status='MAINTENANCE'`,
        [nodeId, revokedTokenHash],
      );
      if (archived.rowCount !== 1) throw new Error("node lost maintenance lifecycle ownership");
    } else {
      await client.query(
        "UPDATE nodes SET lifecycle_status='ACTIVE' WHERE id=$1 AND lifecycle_status='MAINTENANCE'",
        [nodeId],
      );
    }
    await client.query("COMMIT");
    return event.ok && event.kind === "CLEANUP_NODE";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failRunningNodeMaintenanceForNode(
  pool: Pool,
  nodeId: string,
  reason = "agent disconnected during node maintenance",
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE node_maintenance_actions
          SET status='FAILED',error=$2,completed_at=now()
        WHERE node_id=$1 AND status='RUNNING'`,
      [nodeId, reason.slice(0, 1000)],
    );
    await client.query(
      "UPDATE nodes SET lifecycle_status='ACTIVE' WHERE id=$1 AND lifecycle_status='MAINTENANCE'",
      [nodeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function startNodeMaintenance(
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  nodeId: string,
  kind: "UPDATE_AGENT" | "CLEANUP_NODE",
) {
  const socket = sockets.get(nodeId);
  if (!socket) throw new Error("node Agent is not connected");

  const client = await pool.connect();
  const actionId = randomUUID();
  try {
    await client.query("BEGIN");
    const node = await client.query(
      `SELECT id,status,lifecycle_status,agent_capabilities
         FROM nodes
        WHERE id=$1 AND workspace_id<>$2
        FOR UPDATE`,
      [nodeId, internalLegacyWorkspaceId],
    );
    if (node.rowCount !== 1) throw new Error("node is unavailable");
    if (node.rows[0].status !== "ONLINE" || node.rows[0].lifecycle_status !== "ACTIVE") {
      throw new Error("node must be ACTIVE and ONLINE for maintenance");
    }
    const capabilities: string[] = Array.isArray(node.rows[0].agent_capabilities) ? node.rows[0].agent_capabilities : [];
    if (!capabilities.includes(maintenanceCapability)) {
      throw new Error("node Agent does not support product-level maintenance; install Agent 0.1.14 or later through the canonical installer");
    }

    const busy = await client.query(
      `SELECT
         EXISTS(
           SELECT 1 FROM deployments d
            WHERE d.node_id=$1 AND d.status IN ('QUEUED','BUILDING','DEPLOYING','HEALTHCHECK')
         ) AS deployment_busy,
         EXISTS(
           SELECT 1 FROM runtime_actions a
            WHERE a.node_id=$1 AND a.status='RUNNING'
         ) AS runtime_busy`,
      [nodeId],
    );
    if (busy.rows[0].deployment_busy || busy.rows[0].runtime_busy) {
      throw new Error("node has an active deployment or runtime action");
    }

    if (kind === "CLEANUP_NODE") {
      const blockers = await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM deployments d WHERE d.node_id=$1 AND d.status='READY') AS ready_deployment,
           EXISTS(SELECT 1 FROM service_domains d WHERE d.node_id=$1 AND d.status<>'DELETING') AS active_domain,
           EXISTS(SELECT 1 FROM service_volumes v WHERE v.node_id=$1) AS persistent_volume,
           EXISTS(SELECT 1 FROM project_redis_addons r WHERE r.node_id=$1) AS managed_redis`,
        [nodeId],
      );
      const row = blockers.rows[0];
      if (row.ready_deployment || row.active_domain || row.persistent_volume || row.managed_redis) {
        throw new Error("cleanup requires zero READY deployments, active domains, persistent volumes and managed Redis addons on the node");
      }
    }

    await client.query(
      "INSERT INTO node_maintenance_actions(id,node_id,kind,status) VALUES($1,$2,$3,'RUNNING')",
      [actionId, nodeId, kind],
    );
    await client.query(
      "UPDATE nodes SET lifecycle_status='MAINTENANCE' WHERE id=$1 AND lifecycle_status='ACTIVE'",
      [nodeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    socket.send(JSON.stringify({
      type: kind === "UPDATE_AGENT" ? "updateAgent" : "cleanupNode",
      actionId,
    }));
  } catch (error) {
    await failRunningNodeMaintenanceForNode(pool, nodeId, "maintenance command could not be sent");
    throw error;
  }

  const result = await pool.query(
    `SELECT id,node_id,kind,status,requested_at,completed_at,error,result_agent_version,result_build_sha
       FROM node_maintenance_actions WHERE id=$1`,
    [actionId],
  );
  return maintenanceView(result.rows[0]);
}

export function registerWorkspaceNodeRoutes(
  app: FastifyInstance,
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  requireControl: ControlPreHandler,
): void {
  app.get<{ Params: { workspaceId: string }; Querystring: { includeArchived?: string } }>(
    "/v0/workspaces/:workspaceId/nodes",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const workspaceId = requireUuid(request.params.workspaceId, "workspaceId");
        if (workspaceId === internalLegacyWorkspaceId) return reply.code(404).send({ error: "workspace is unavailable" });
        const includeArchived = request.query?.includeArchived === "1" || request.query?.includeArchived === "true";
        const workspace = await pool.query("SELECT 1 FROM workspaces WHERE id=$1 AND id<>$2", [workspaceId, internalLegacyWorkspaceId]);
        if (workspace.rowCount !== 1) return reply.code(404).send({ error: "workspace is unavailable" });
        const result = await pool.query(
          `SELECT id,workspace_id,name,status,lifecycle_status,last_seen_at,agent_version,agent_build_sha,
                  agent_capabilities,public_addresses,compatibility_error,agent_connected_at,archived_at,created_at
             FROM nodes
            WHERE workspace_id=$1 AND ($2::boolean OR lifecycle_status='ACTIVE')
            ORDER BY lifecycle_status ASC,status DESC,last_seen_at DESC NULLS LAST,created_at DESC`,
          [workspaceId, includeArchived],
        );
        return { nodes: result.rows.map(nodeView) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "nodes could not be listed" });
      }
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: { name?: string } }>(
    "/v0/workspaces/:workspaceId/nodes",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const workspaceId = requireUuid(request.params.workspaceId, "workspaceId");
        if (workspaceId === internalLegacyWorkspaceId) return reply.code(404).send({ error: "workspace is unavailable" });
        const name = requireNodeName(request.body?.name);
        const id = randomUUID();
        const nodeToken = createOpaqueToken();
        const result = await pool.query(
          `INSERT INTO nodes(id,name,token_hash,workspace_id)
           SELECT $1,$2,$3,w.id
             FROM workspaces w
            WHERE w.id=$4 AND w.id<>$5
           RETURNING id,workspace_id,name,status,lifecycle_status,last_seen_at,agent_version,agent_build_sha,
                     agent_capabilities,public_addresses,compatibility_error,agent_connected_at,archived_at,created_at`,
          [id, name, hashToken(nodeToken), workspaceId, internalLegacyWorkspaceId],
        );
        if (result.rowCount !== 1) return reply.code(404).send({ error: "workspace is unavailable" });
        return reply
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .code(201)
          .send({ ...nodeView(result.rows[0]), token: nodeToken });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "node could not be created" });
      }
    },
  );

  app.get<{ Params: { nodeId: string } }>(
    "/v0/nodes/:nodeId/maintenance",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const nodeId = requireUuid(request.params.nodeId, "nodeId");
        const result = await pool.query(
          `SELECT id,node_id,kind,status,requested_at,completed_at,error,result_agent_version,result_build_sha
             FROM node_maintenance_actions
            WHERE node_id=$1
            ORDER BY requested_at DESC,id DESC
            LIMIT 20`,
          [nodeId],
        );
        return { actions: result.rows.map(maintenanceView) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "node maintenance could not be listed" });
      }
    },
  );

  app.post<{ Params: { nodeId: string } }>(
    "/v0/nodes/:nodeId/maintenance/update",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const nodeId = requireUuid(request.params.nodeId, "nodeId");
        return reply.code(202).send(await startNodeMaintenance(pool, sockets, nodeId, "UPDATE_AGENT"));
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "Agent update could not be started" });
      }
    },
  );

  app.post<{ Params: { nodeId: string } }>(
    "/v0/nodes/:nodeId/maintenance/cleanup",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const nodeId = requireUuid(request.params.nodeId, "nodeId");
        return reply.code(202).send(await startNodeMaintenance(pool, sockets, nodeId, "CLEANUP_NODE"));
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "node cleanup could not be started" });
      }
    },
  );

  app.post<{ Params: { nodeId: string } }>(
    "/v0/nodes/:nodeId/archive",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const nodeId = requireUuid(request.params.nodeId, "nodeId");
        const result = await pool.query(
          `UPDATE nodes n
              SET lifecycle_status='ARCHIVED',
                  archived_at=COALESCE(n.archived_at,now()),
                  status='OFFLINE',
                  agent_connected_at=NULL,
                  token_hash=$3,
                  compatibility_error='node archived; credential revoked'
            WHERE n.id=$1
              AND n.workspace_id<>$2
              AND n.lifecycle_status='ACTIVE'
              AND n.status='OFFLINE'
              AND NOT EXISTS(
                SELECT 1 FROM deployments d
                 WHERE d.node_id=n.id AND d.status='READY'
              )
              AND NOT EXISTS(
                SELECT 1 FROM service_domains domain
                 WHERE domain.node_id=n.id AND domain.status<>'DELETING'
              )
          RETURNING n.id,n.workspace_id,n.name,n.status,n.lifecycle_status,n.last_seen_at,n.agent_version,n.agent_build_sha,
                    n.agent_capabilities,n.public_addresses,n.compatibility_error,n.agent_connected_at,n.archived_at,n.created_at`,
          [nodeId, internalLegacyWorkspaceId, revokedTokenHash],
        );
        if (result.rowCount !== 1) {
          return reply.code(409).send({
            error: "node must be ACTIVE, OFFLINE, non-legacy and have no READY deployment or active domain before archive",
          });
        }
        return nodeView(result.rows[0]);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "node could not be archived" });
      }
    },
  );
}
