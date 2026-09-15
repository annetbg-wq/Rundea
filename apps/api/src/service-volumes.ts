import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { resolveActiveCanonicalService, ServiceScopeError } from "./service-scope";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type VolumeMountSnapshot = Readonly<{
  volumeId: string;
  name: string;
  dockerVolumeName: string;
  mountPath: string;
}>;

export class ServiceVolumeError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "ServiceVolumeError";
  }
}

const volumeNamePattern = /^[a-z][a-z0-9-]{0,62}$/;

export function validateVolumeName(value: unknown): string {
  if (typeof value !== "string") throw new ServiceVolumeError(400, "volume name is required");
  const name = value.trim().toLowerCase();
  if (!volumeNamePattern.test(name)) throw new ServiceVolumeError(400, "volume name must start with a letter and contain only lowercase letters, digits and hyphens");
  return name;
}

export function validateMountPath(value: unknown): string {
  if (typeof value !== "string") throw new ServiceVolumeError(400, "mountPath is required");
  const path = value.trim();
  if (!path.startsWith("/") || path === "/" || path.length > 512 || /[\r\n\0]/.test(path)) {
    throw new ServiceVolumeError(400, "mountPath must be an absolute container path below /");
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) throw new ServiceVolumeError(400, "mountPath must not contain . or .. segments");
  return `/${parts.join("/")}`;
}

export function dockerVolumeName(volumeId: string): string {
  return `rundea-vol-${volumeId.replaceAll("-", "").toLowerCase()}`;
}

export async function serviceVolumeBoundNode(client: PoolClient, serviceId: string): Promise<string | null> {
  const result = await client.query(
    `SELECT DISTINCT node_id FROM service_volumes
      WHERE service_id=$1 AND node_id IS NOT NULL
      ORDER BY node_id FOR UPDATE`,
    [serviceId],
  );
  if (result.rowCount && result.rowCount > 1) throw new ServiceVolumeError(409, "service volumes are bound to conflicting nodes");
  return result.rowCount === 1 ? String(result.rows[0].node_id) : null;
}

export async function bindServiceVolumesToNode(client: PoolClient, serviceId: string, nodeId: string): Promise<void> {
  const rows = await client.query(
    `SELECT id,node_id FROM service_volumes WHERE service_id=$1 ORDER BY id FOR UPDATE`,
    [serviceId],
  );
  for (const row of rows.rows) {
    if (row.node_id && String(row.node_id) !== nodeId) {
      throw new ServiceVolumeError(409, `persistent volume is pinned to node ${row.node_id}; deploy on that node or migrate state explicitly`);
    }
  }
  await client.query(
    `UPDATE service_volumes SET node_id=$2,updated_at=now()
      WHERE service_id=$1 AND node_id IS NULL`,
    [serviceId, nodeId],
  );
}

export async function snapshotDeploymentVolumes(client: PoolClient, deploymentId: string, serviceId: string): Promise<void> {
  await client.query(
    `INSERT INTO deployment_volume_mounts(deployment_id,volume_id,docker_volume_name,mount_path)
     SELECT $1,id,docker_volume_name,mount_path
       FROM service_volumes
      WHERE service_id=$2
      ORDER BY created_at,id`,
    [deploymentId, serviceId],
  );
}

export async function copyDeploymentVolumeSnapshot(client: PoolClient, fromDeploymentId: string, toDeploymentId: string): Promise<void> {
  await client.query(
    `INSERT INTO deployment_volume_mounts(deployment_id,volume_id,docker_volume_name,mount_path)
     SELECT $2,volume_id,docker_volume_name,mount_path
       FROM deployment_volume_mounts
      WHERE deployment_id=$1
      ORDER BY volume_id`,
    [fromDeploymentId, toDeploymentId],
  );
}

export async function loadDeploymentVolumeMounts(pool: Pool, deploymentId: string): Promise<VolumeMountSnapshot[]> {
  const result = await pool.query(
    `SELECT m.volume_id,v.name,m.docker_volume_name,m.mount_path
       FROM deployment_volume_mounts m
       JOIN service_volumes v ON v.id=m.volume_id
      WHERE m.deployment_id=$1
      ORDER BY m.mount_path,m.volume_id`,
    [deploymentId],
  );
  return result.rows.map((row) => ({
    volumeId: String(row.volume_id),
    name: String(row.name),
    dockerVolumeName: String(row.docker_volume_name),
    mountPath: String(row.mount_path),
  }));
}

async function listVolumes(pool: Pool, serviceId: string) {
  const result = await pool.query(
    `SELECT v.id,v.name,v.mount_path,v.node_id,v.docker_volume_name,v.created_at,v.updated_at,n.name AS node_name
       FROM service_volumes v
       LEFT JOIN nodes n ON n.id=v.node_id
      WHERE v.service_id=$1
      ORDER BY v.created_at,v.id`,
    [serviceId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    mountPath: String(row.mount_path),
    nodeId: row.node_id ? String(row.node_id) : null,
    nodeName: row.node_name ? String(row.node_name) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export function registerServiceVolumeRoutes(app: FastifyInstance, pool: Pool, requireControl: RequireControl): void {
  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/volumes",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        return reply.send({ serviceId: service.id, volumes: await listVolumes(pool, service.id) });
      } catch (error) {
        if (error instanceof ServiceScopeError || error instanceof ServiceVolumeError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { serviceId: string }; Body: { name?: unknown; mountPath?: unknown } }>(
    "/v0/services/:serviceId/volumes",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const name = validateVolumeName(request.body?.name);
        const mountPath = validateMountPath(request.body?.mountPath);
        const id = randomUUID();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const existingBoundNode = await serviceVolumeBoundNode(client, service.id);
          const currentReady = await client.query(
            `SELECT node_id FROM deployments
              WHERE service_id=$1 AND status='READY'
              ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
            [service.id],
          );
          const currentNodeId = currentReady.rowCount === 1 ? String(currentReady.rows[0].node_id) : null;
          if (existingBoundNode && currentNodeId && existingBoundNode !== currentNodeId) {
            throw new ServiceVolumeError(409, "current READY revision does not match the persistent volume node binding");
          }
          const nodeId = existingBoundNode ?? currentNodeId;
          const inserted = await client.query(
            `INSERT INTO service_volumes(id,service_id,name,mount_path,node_id,docker_volume_name)
             VALUES($1,$2,$3,$4,$5,$6)
             RETURNING id,name,mount_path,node_id,created_at,updated_at`,
            [id, service.id, name, mountPath, nodeId, dockerVolumeName(id)],
          );
          await client.query("COMMIT");
          const row = inserted.rows[0];
          return reply.code(201).send({
            id: String(row.id),
            serviceId: service.id,
            name: String(row.name),
            mountPath: String(row.mount_path),
            nodeId: row.node_id ? String(row.node_id) : null,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          if ((error as { code?: string })?.code === "23505") throw new ServiceVolumeError(409, "volume name or mount path already exists for this service");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        if (error instanceof ServiceScopeError || error instanceof ServiceVolumeError) return reply.code(error.statusCode).send({ error: error.message });
        request.log.error(error, "persistent volume creation failed");
        return reply.code(400).send({ error: error instanceof Error ? error.message : "persistent volume creation failed" });
      }
    },
  );
}
