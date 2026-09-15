import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { decryptValue, encryptValue, parseMasterKey, type EncryptedValue } from "@rundea/crypto";
import { normalizeBuildArgs } from "./build-args";
import { reconcileNodeIngress, validateDomainHostname } from "./domains";
import type { NodeCommandSocket } from "./node-qualification";
import { registerProjectServiceAdminRoutes } from "./project-service-admin";
import { resolveActiveCanonicalService, ServiceScopeError } from "./service-scope";
import { captureDeploymentEnvironment, validateVariables, type ServiceVariableInput } from "./service-variables";
import { bindServiceVolumesToNode, registerServiceVolumeRoutes, serviceVolumeBoundNode, snapshotDeploymentVolumes, ServiceVolumeError } from "./service-volumes";
import { validateSourceDelivery } from "./source-broker";
import { registerWorkspaceNodeRoutes } from "./workspace-node-routes";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type DispatchQueued = (nodeId: string) => Promise<void>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const variableKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof ServiceScopeError || error instanceof ServiceVolumeError) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(400).send({ error: error instanceof Error ? error.message : "service request failed" });
}

function optionalNodeId(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const nodeId = value.trim().toLowerCase();
  if (!uuidPattern.test(nodeId)) throw new Error("nodeId must be a UUID");
  return nodeId;
}

function encryptedFromRow(row: Record<string, unknown>): EncryptedValue {
  return {
    version: Number(row.encrypted_version) as 1,
    iv: String(row.iv),
    ciphertext: String(row.ciphertext),
    tag: String(row.auth_tag),
  };
}

function canonicalMasterKey(): Buffer {
  const encoded = process.env.RUNDEA_MASTER_KEY;
  if (!encoded) throw new Error("RUNDEA_MASTER_KEY is required");
  return parseMasterKey(encoded);
}

export function registerServiceScopedRoutes(
  app: FastifyInstance,
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  requireControl: ControlPreHandler,
  dispatchQueued: DispatchQueued,
): void {
  registerProjectServiceAdminRoutes(app, pool, requireControl);
  registerWorkspaceNodeRoutes(app, pool, requireControl);
  registerServiceVolumeRoutes(app, pool, requireControl);
  const masterKey = canonicalMasterKey();

  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/deployments",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const result = await pool.query(
          `SELECT d.id,d.service_id,d.node_id,d.source_repository,d.source_ref,d.source_delivery,d.dockerfile,d.build_args,
                  d.container_port,d.healthcheck_path,d.status,d.runtime_container_id,d.operation,d.rollback_target_id,
                  d.environment_snapshot_at,d.source_commit_sha,d.image_id,d.created_at,d.updated_at
             FROM deployments d
            WHERE d.service_id=$1
            ORDER BY d.created_at DESC,d.id DESC
            LIMIT 100`,
          [service.id],
        );
        return {
          service: {
            id: service.id,
            projectId: service.projectId,
            workspaceId: service.workspaceId,
            name: service.name,
            slug: service.slug,
          },
          deployments: result.rows,
        };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{
    Params: { serviceId: string };
    Body: {
      nodeId?: string;
      sourceRepository?: string;
      sourceRef?: string;
      sourceDelivery?: string;
      dockerfile?: string;
      buildArgs?: unknown;
      containerPort?: number;
      healthcheckPath?: string;
    };
  }>(
    "/v0/services/:serviceId/deployments",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const body = request.body ?? {};
        const requestedNodeId = optionalNodeId(body.nodeId);
        if (!body.sourceRepository?.trim() || !body.sourceRef?.trim()) throw new Error("sourceRepository and sourceRef are required");
        if (!Number.isInteger(body.containerPort) || (body.containerPort as number) < 1 || (body.containerPort as number) > 65535) {
          throw new Error("containerPort must be an integer between 1 and 65535");
        }
        const sourceDelivery = validateSourceDelivery(body.sourceDelivery, body.sourceRef.trim());
        const buildArgs = normalizeBuildArgs(body.buildArgs);
        const id = randomUUID();
        const client = await pool.connect();
        let nodeId = "";
        try {
          await client.query("BEGIN");
          const volumeNodeId = await serviceVolumeBoundNode(client, service.id);
          if (requestedNodeId && volumeNodeId && requestedNodeId !== volumeNodeId) {
            throw new ServiceVolumeError(409, `persistent volumes pin this service to node ${volumeNodeId}`);
          }
          const effectiveNodeId = requestedNodeId ?? volumeNodeId;
          const node = effectiveNodeId
            ? await client.query(
                `SELECT id
                   FROM nodes
                  WHERE id=$1 AND workspace_id=$2 AND lifecycle_status='ACTIVE' AND status='ONLINE'
                  FOR SHARE`,
                [effectiveNodeId, service.workspaceId],
              )
            : await client.query(
                `SELECT id
                   FROM nodes
                  WHERE workspace_id=$1 AND lifecycle_status='ACTIVE' AND status='ONLINE'
                  ORDER BY last_seen_at DESC NULLS LAST,created_at ASC,id ASC
                  LIMIT 1
                  FOR SHARE`,
                [service.workspaceId],
              );
          if (node.rowCount !== 1) {
            throw new Error(effectiveNodeId ? "selected or volume-bound node is not an ONLINE node in this workspace" : "workspace has no ONLINE node available for deployment");
          }
          nodeId = String(node.rows[0].id);
          await bindServiceVolumesToNode(client, service.id, nodeId);
          const allocation = await client.query(
            "SELECT rundea_allocate_host_port($1,$2) AS host_port",
            [service.id, nodeId],
          );
          const hostPort = Number(allocation.rows[0]?.host_port);
          if (!Number.isInteger(hostPort)) throw new Error("Rundea could not allocate a host port");
          await client.query(
            `INSERT INTO deployments(
               id,service_id,service_name,node_id,source_repository,source_ref,source_delivery,dockerfile,build_args,
               container_port,host_port,healthcheck_path,status,operation
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'QUEUED','DEPLOY')`,
            [
              id,
              service.id,
              service.runtimeKey,
              nodeId,
              body.sourceRepository.trim(),
              body.sourceRef.trim(),
              sourceDelivery,
              body.dockerfile?.trim() || null,
              buildArgs,
              body.containerPort,
              hostPort,
              body.healthcheckPath?.trim() ?? "",
            ],
          );
          await captureDeploymentEnvironment(client, id, service.runtimeKey);
          await snapshotDeploymentVolumes(client, id, service.id);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        await dispatchQueued(nodeId);
        return reply.code(201).send({
          id,
          serviceId: service.id,
          serviceName: service.name,
          nodeId,
          status: "QUEUED",
          operation: "DEPLOY",
          sourceDelivery,
          agentConnected: sockets.has(nodeId),
        });
      } catch (error) {
        request.log.error(error, "canonical service deployment rejected");
        return sendServiceError(reply, error);
      }
    },
  );

  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/config/variables",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const result = await pool.query(
          `SELECT key,encrypted_version,iv,ciphertext,auth_tag,is_secret
             FROM service_variables
            WHERE service_id=$1
            ORDER BY key ASC`,
          [service.id],
        );
        return {
          serviceId: service.id,
          variables: result.rows.map((row) => ({
            key: row.key,
            secret: row.is_secret,
            ...(row.is_secret ? {} : { value: decryptValue(encryptedFromRow(row), masterKey) }),
          })),
        };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.put<{ Params: { serviceId: string }; Body: { variables?: ServiceVariableInput[] } }>(
    "/v0/services/:serviceId/config/variables",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const variables = request.body?.variables;
        if (!Array.isArray(variables)) throw new Error("variables must be an array");
        validateVariables(variables);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const item of variables) {
            const encrypted = encryptValue(item.value, masterKey);
            await client.query(
              `INSERT INTO service_variables(
                 service_id,service_name,key,encrypted_version,iv,ciphertext,auth_tag,is_secret,updated_at
               ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
               ON CONFLICT(service_id,key) DO UPDATE SET
                 service_name=EXCLUDED.service_name,
                 encrypted_version=EXCLUDED.encrypted_version,
                 iv=EXCLUDED.iv,
                 ciphertext=EXCLUDED.ciphertext,
                 auth_tag=EXCLUDED.auth_tag,
                 is_secret=EXCLUDED.is_secret,
                 updated_at=now()`,
              [service.id, service.runtimeKey, item.key, encrypted.version, encrypted.iv, encrypted.ciphertext, encrypted.tag, item.secret ?? true],
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        return reply.send({
          serviceId: service.id,
          updated: variables.map((item) => ({ key: item.key, secret: item.secret ?? true })),
        });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.delete<{ Params: { serviceId: string; key: string } }>(
    "/v0/services/:serviceId/config/variables/:key",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        if (!variableKeyPattern.test(request.params.key)) throw new Error("invalid environment variable name");
        const result = await pool.query("DELETE FROM service_variables WHERE service_id=$1 AND key=$2", [service.id, request.params.key]);
        return result.rowCount === 1 ? reply.code(204).send() : reply.code(404).send({ error: "variable not found" });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/domains",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const result = await pool.query(
          `SELECT id,hostname,service_id,node_id,status,last_error,created_at,updated_at,verified_at
             FROM service_domains
            WHERE service_id=$1
            ORDER BY created_at DESC,id DESC`,
          [service.id],
        );
        return { serviceId: service.id, domains: result.rows };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Params: { serviceId: string }; Body: { hostname?: string } }>(
    "/v0/services/:serviceId/domains",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const service = await resolveActiveCanonicalService(pool, request.params.serviceId);
        const hostname = validateDomainHostname(request.body?.hostname ?? "");
        const deployment = await pool.query(
          `SELECT node_id
             FROM deployments
            WHERE service_id=$1 AND status='READY'
            ORDER BY updated_at DESC,created_at DESC
            LIMIT 1`,
          [service.id],
        );
        if (deployment.rowCount !== 1) return reply.code(409).send({ error: "service needs a READY deployment before a domain can be attached" });
        const nodeId = String(deployment.rows[0].node_id);
        const id = randomUUID();
        await pool.query(
          `INSERT INTO service_domains(id,hostname,service_id,service_name,node_id,status)
           VALUES($1,$2,$3,$4,$5,'PENDING')`,
          [id, hostname, service.id, service.runtimeKey, nodeId],
        );
        await reconcileNodeIngress(pool, sockets, nodeId);
        const created = await pool.query(
          `SELECT id,hostname,service_id,node_id,status,last_error,created_at,updated_at,verified_at
             FROM service_domains WHERE id=$1`,
          [id],
        );
        return reply.code(201).send(created.rows[0]);
      } catch (error) {
        request.log.error(error, "canonical service domain rejected");
        return sendServiceError(reply, error);
      }
    },
  );
}
