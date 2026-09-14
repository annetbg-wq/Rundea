import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { normalizeBuildArgs } from "./build-args";
import { getConfirmedServiceSource } from "./discovery-confirmation";
import { resolveActiveCanonicalService, ServiceScopeError } from "./service-scope";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CanonicalAutodeployInput = {
  nodeId?: string;
  buildArgs?: unknown;
  enabled?: boolean;
};

export class CanonicalAutodeployError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalAutodeployError";
  }
}

function optionalNodeId(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const nodeId = value.trim().toLowerCase();
  if (!uuidPattern.test(nodeId)) throw new CanonicalAutodeployError(400, "nodeId must be a UUID");
  return nodeId;
}

async function selectNode(
  client: PoolClient,
  workspaceId: string,
  requestedNodeId: string | null,
): Promise<string> {
  const result = requestedNodeId
    ? await client.query(
        `SELECT id
           FROM nodes
          WHERE id=$1 AND workspace_id=$2 AND lifecycle_status='ACTIVE' AND status='ONLINE'
          FOR SHARE`,
        [requestedNodeId, workspaceId],
      )
    : await client.query(
        `SELECT id
           FROM nodes
          WHERE workspace_id=$1 AND lifecycle_status='ACTIVE' AND status='ONLINE'
          ORDER BY last_seen_at DESC NULLS LAST,created_at ASC,id ASC
          LIMIT 1
          FOR SHARE`,
        [workspaceId],
      );
  if (result.rowCount !== 1) {
    throw new CanonicalAutodeployError(
      409,
      requestedNodeId ? "selected node is not an ONLINE node in this workspace" : "workspace has no ONLINE node available for autodeploy",
    );
  }
  return String(result.rows[0].id);
}

async function rejectSecretBuildArgs(pool: Pool, serviceId: string, buildArgs: Record<string, string>): Promise<void> {
  const keys = Object.keys(buildArgs);
  if (!keys.length) return;
  const result = await pool.query(
    `SELECT key
       FROM service_variables
      WHERE service_id=$1 AND is_secret=true AND key=ANY($2::text[])
      ORDER BY key`,
    [serviceId, keys],
  );
  if (result.rowCount) {
    throw new CanonicalAutodeployError(409, `${result.rows[0].key} is a runtime secret and cannot be exposed as a build argument`);
  }
}

export async function configureCanonicalAutodeploy(
  pool: Pool,
  serviceId: string,
  input: CanonicalAutodeployInput,
) {
  let service;
  try {
    service = await resolveActiveCanonicalService(pool, serviceId);
  } catch (error) {
    if (error instanceof ServiceScopeError) throw new CanonicalAutodeployError(error.statusCode, error.message);
    throw error;
  }
  const source = await getConfirmedServiceSource(pool, service.id);
  if (!source) throw new CanonicalAutodeployError(409, "service needs a confirmed GitHub source before autodeploy can be enabled");

  const buildArgs = normalizeBuildArgs(input.buildArgs);
  const allowedBuildArgs = new Set(source.buildVariableNames);
  const unknownBuildArg = Object.keys(buildArgs).find((key) => !allowedBuildArgs.has(key));
  if (unknownBuildArg) {
    throw new CanonicalAutodeployError(409, `${unknownBuildArg} was not discovered as a Docker build ARG for this service`);
  }
  await rejectSecretBuildArgs(pool, service.id, buildArgs);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nodeId = await selectNode(client, service.workspaceId, optionalNodeId(input.nodeId));
    const allocation = await client.query("SELECT rundea_allocate_host_port($1,$2) AS host_port", [service.id, nodeId]);
    const hostPort = Number(allocation.rows[0]?.host_port);
    if (!Number.isInteger(hostPort)) throw new CanonicalAutodeployError(409, "Rundea could not allocate a managed host port");

    const repositoryFullName = source.repositoryFullName.toLowerCase();
    const cloneUrl = `https://github.com/${source.repositoryFullName}.git`;
    const result = await client.query(
      `INSERT INTO service_autodeploys(
         service_id,service_name,node_id,repository_full_name,source_repository,source_branch,dockerfile,build_args,
         container_port,host_port,healthcheck_path,enabled,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,now())
       ON CONFLICT(service_id) DO UPDATE SET
         service_name=EXCLUDED.service_name,
         node_id=EXCLUDED.node_id,
         repository_full_name=EXCLUDED.repository_full_name,
         source_repository=EXCLUDED.source_repository,
         source_branch=EXCLUDED.source_branch,
         dockerfile=EXCLUDED.dockerfile,
         build_args=EXCLUDED.build_args,
         container_port=EXCLUDED.container_port,
         host_port=EXCLUDED.host_port,
         healthcheck_path=EXCLUDED.healthcheck_path,
         enabled=EXCLUDED.enabled,
         updated_at=now()
       RETURNING service_id,node_id,source_branch,enabled,created_at,updated_at`,
      [
        service.id,
        service.runtimeKey,
        nodeId,
        repositoryFullName,
        cloneUrl,
        source.selectedBranch,
        source.dockerfile,
        JSON.stringify(buildArgs),
        source.containerPort,
        hostPort,
        source.healthcheckPath,
        input.enabled ?? true,
      ],
    );
    await client.query("COMMIT");
    return {
      serviceId: service.id,
      serviceName: service.name,
      nodeId: String(result.rows[0].node_id),
      repositoryFullName: source.repositoryFullName,
      branch: source.selectedBranch,
      enabled: Boolean(result.rows[0].enabled),
      buildArgs,
      sourcePath: source.sourcePath,
      createdAt: new Date(result.rows[0].created_at).toISOString(),
      updatedAt: new Date(result.rows[0].updated_at).toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readCanonicalAutodeploy(pool: Pool, serviceId: string) {
  const result = await pool.query(
    `SELECT a.service_id,a.node_id,a.source_branch,a.build_args,a.enabled,a.created_at,a.updated_at,s.name
       FROM service_autodeploys a
       JOIN services s ON s.id=a.service_id
      WHERE a.service_id=$1 AND s.status='ACTIVE'`,
    [serviceId],
  );
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  return {
    serviceId: String(row.service_id),
    serviceName: String(row.name),
    nodeId: String(row.node_id),
    branch: String(row.source_branch),
    buildArgs: row.build_args ?? {},
    enabled: Boolean(row.enabled),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function registerCanonicalAutodeployRoutes(app: FastifyInstance, pool: Pool, requireControl: RequireControl): void {
  app.put<{ Params: { serviceId: string }; Body: CanonicalAutodeployInput }>(
    "/v0/services/:serviceId/push-autodeploy",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        return reply.send({ autodeploy: await configureCanonicalAutodeploy(pool, request.params.serviceId, request.body ?? {}) });
      } catch (error) {
        if (error instanceof CanonicalAutodeployError) return reply.code(error.statusCode).send({ error: error.message });
        request.log.error(error, "canonical autodeploy configuration failed");
        return reply.code(400).send({ error: error instanceof Error ? error.message : "autodeploy configuration failed" });
      }
    },
  );

  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/push-autodeploy",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.serviceId)) return reply.code(400).send({ error: "serviceId must be a UUID" });
      const autodeploy = await readCanonicalAutodeploy(pool, request.params.serviceId);
      return autodeploy ? reply.send({ autodeploy }) : reply.code(404).send({ error: "autodeploy not configured" });
    },
  );

  app.delete<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/push-autodeploy",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.serviceId)) return reply.code(400).send({ error: "serviceId must be a UUID" });
      const result = await pool.query("DELETE FROM service_autodeploys WHERE service_id=$1", [request.params.serviceId]);
      return result.rowCount === 1 ? reply.code(204).send() : reply.code(404).send({ error: "autodeploy not configured" });
    },
  );
}
