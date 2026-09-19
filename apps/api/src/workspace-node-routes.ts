import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { createOpaqueToken, hashToken } from "@rundea/crypto";
import { internalLegacyWorkspaceId } from "./service-scope";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revokedTokenHash = "0".repeat(64);

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

export function registerWorkspaceNodeRoutes(
  app: FastifyInstance,
  pool: Pool,
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
        return reply.code(201).send({ ...nodeView(result.rows[0]), token: nodeToken });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "node could not be created" });
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
