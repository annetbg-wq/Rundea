import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  createOpaqueToken,
  decryptManagedRedisCredential,
  encryptManagedRedisCredential,
  type EncryptedValue,
} from "@rundea/crypto";
import type { AgentEvent } from "@rundea/contracts";

export const internalManagedRedisMetadataKey = "RUNDEA_INTERNAL_MANAGED_REDIS";
export const managedRedisEnvironmentKey = "REDIS_URL";
const managedRedisAlias = "redis";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export class ManagedRedisError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "ManagedRedisError";
  }
}

function encryptedFromRow(row: Record<string, unknown>): EncryptedValue {
  return {
    version: Number(row.encrypted_version) as 1,
    iv: String(row.iv),
    ciphertext: String(row.ciphertext),
    tag: String(row.auth_tag),
  };
}

export function managedRedisDockerVolumeName(addonId: string): string {
  return `rundea-redis-${addonId.replaceAll("-", "").toLowerCase()}`;
}

async function requireProject(pool: Pool, projectId: string): Promise<void> {
  const result = await pool.query("SELECT id FROM projects WHERE id=$1", [projectId]);
  if (result.rowCount !== 1) throw new ManagedRedisError(404, "project not found");
}

async function projectReadyNode(pool: Pool, projectId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT DISTINCT d.node_id
       FROM deployments d
       JOIN services s ON s.id=d.service_id
      WHERE s.project_id=$1 AND d.status='READY'
      ORDER BY d.node_id`,
    [projectId],
  );
  if ((result.rowCount ?? 0) > 1) {
    throw new ManagedRedisError(409, "project READY services span multiple nodes; managed Redis requires one project node");
  }
  return result.rowCount === 1 ? String(result.rows[0].node_id) : null;
}

async function readAddon(pool: Pool, projectId: string) {
  const result = await pool.query(
    `SELECT id,project_id,node_id,alias,status,last_error,ready_at,created_at,updated_at
       FROM project_redis_addons
      WHERE project_id=$1`,
    [projectId],
  );
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    nodeId: row.node_id ? String(row.node_id) : null,
    alias: String(row.alias),
    environmentKey: managedRedisEnvironmentKey,
    status: String(row.status),
    lastError: row.last_error ? String(row.last_error) : null,
    readyAt: row.ready_at ? new Date(row.ready_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function loadManagedRedisRuntimeMetadata(
  pool: Pool,
  masterKey: Buffer,
  deploymentId: string,
  environment: Record<string, string>,
): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT a.id,a.project_id,a.node_id,a.alias,a.docker_volume_name,
            a.encrypted_version,a.iv,a.ciphertext,a.auth_tag,d.node_id AS deployment_node_id
       FROM deployments d
       JOIN services s ON s.id=d.service_id
       JOIN project_redis_addons a ON a.project_id=s.project_id
      WHERE d.id=$1`,
    [deploymentId],
  );
  if (result.rowCount === 0) return environment;
  if (result.rowCount !== 1) throw new Error("deployment resolved multiple managed Redis addons");
  if (managedRedisEnvironmentKey in environment) {
    throw new ManagedRedisError(409, `${managedRedisEnvironmentKey} is reserved while managed Redis is enabled`);
  }

  const row = result.rows[0];
  const deploymentNodeId = String(row.deployment_node_id);
  if (!row.node_id) {
    const bound = await pool.query(
      `UPDATE project_redis_addons
          SET node_id=$2,updated_at=now()
        WHERE id=$1 AND node_id IS NULL
        RETURNING node_id`,
      [row.id, deploymentNodeId],
    );
    if (bound.rowCount !== 1) {
      const refreshed = await pool.query("SELECT node_id FROM project_redis_addons WHERE id=$1", [row.id]);
      if (refreshed.rowCount !== 1 || String(refreshed.rows[0].node_id) !== deploymentNodeId) {
        throw new ManagedRedisError(409, "managed Redis is pinned to another node");
      }
    }
  } else if (String(row.node_id) !== deploymentNodeId) {
    throw new ManagedRedisError(409, "managed Redis is pinned to another node");
  }

  const password = decryptManagedRedisCredential(encryptedFromRow(row), masterKey);
  return {
    ...environment,
    [internalManagedRedisMetadataKey]: JSON.stringify({
      addonId: String(row.id),
      projectId: String(row.project_id),
      alias: String(row.alias),
      dockerVolumeName: String(row.docker_volume_name),
      password,
    }),
  };
}

export async function recordManagedRedisResult(
  pool: Pool,
  nodeId: string,
  event: Extract<AgentEvent, { type: "managedRedis" }>,
): Promise<void> {
  const updated = await pool.query(
    `UPDATE project_redis_addons
        SET status=CASE WHEN $4 THEN 'READY' ELSE 'FAILED' END,
            last_error=CASE WHEN $4 THEN NULL ELSE $5 END,
            ready_at=CASE WHEN $4 THEN $6::timestamptz ELSE ready_at END,
            updated_at=now()
      WHERE id=$1 AND project_id=$2 AND node_id=$3`,
    [event.addonId, event.projectId, nodeId, event.ok, event.error?.slice(0, 1000) ?? null, event.completedAt],
  );
  if (updated.rowCount !== 1) throw new Error("managed Redis result rejected for authenticated node or project");
}

export function registerManagedRedisRoutes(
  app: FastifyInstance,
  pool: Pool,
  masterKey: Buffer,
  requireControl: RequireControl,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/v0/projects/:projectId/addons/redis",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        await requireProject(pool, request.params.projectId);
        const addon = await readAddon(pool, request.params.projectId);
        return addon ? reply.send(addon) : reply.code(404).send({ error: "managed Redis is not configured" });
      } catch (error) {
        if (error instanceof ManagedRedisError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v0/projects/:projectId/addons/redis",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = request.params.projectId;
        await requireProject(pool, projectId);
        const existing = await readAddon(pool, projectId);
        if (existing) return reply.code(409).send({ error: "managed Redis is already configured for this project" });

        const addonId = randomUUID();
        const password = createOpaqueToken();
        const encrypted = encryptManagedRedisCredential(password, masterKey);
        const nodeId = await projectReadyNode(pool, projectId);
        await pool.query(
          `INSERT INTO project_redis_addons(
             id,project_id,node_id,alias,docker_volume_name,encrypted_version,iv,ciphertext,auth_tag,status
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CONFIGURED')`,
          [
            addonId,
            projectId,
            nodeId,
            managedRedisAlias,
            managedRedisDockerVolumeName(addonId),
            encrypted.version,
            encrypted.iv,
            encrypted.ciphertext,
            encrypted.tag,
          ],
        );
        return reply.code(201).send(await readAddon(pool, projectId));
      } catch (error) {
        if (error instanceof ManagedRedisError) return reply.code(error.statusCode).send({ error: error.message });
        if ((error as { code?: string })?.code === "23505") {
          return reply.code(409).send({ error: "managed Redis is already configured for this project" });
        }
        request.log.error(error, "managed Redis configuration failed");
        return reply.code(400).send({ error: error instanceof Error ? error.message : "managed Redis configuration failed" });
      }
    },
  );
}
