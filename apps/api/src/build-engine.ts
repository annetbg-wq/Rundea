import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { equalTokenHash, hashToken } from "@rundea/crypto";
import { normalizeBuildArgs } from "./build-args";
import { createGitHubArchiveProviderFromEnv, type GitHubArchiveProvider } from "./github-app-source";
import { captureDeploymentEnvironment } from "./service-variables";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type ArchiveProvider = Pick<GitHubArchiveProvider, "fetchArchive">;
type DispatchQueued = (nodeId: string) => Promise<void>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fullCommitPattern = /^[0-9a-f]{40}$/;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const leaseSeconds = 120;

export type BuildEngineConfig = Readonly<{
  builderTokenHash: string | null;
  registryPrefix: string | null;
}>;

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export function normalizeRegistryPrefix(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw.length > 400 || raw.includes("://") || raw.includes("@") || /[\s\r\n]/.test(raw)) {
    throw new Error("RUNDEA_BUILD_REGISTRY_PREFIX must be an OCI registry host/path without scheme, digest or whitespace");
  }
  const normalized = raw.replace(/\/+$/, "").toLowerCase();
  const parts = normalized.split("/");
  if (parts.length < 2 || parts.some((part) => !part || !/^[a-z0-9._:-]+$/.test(part))) {
    throw new Error("RUNDEA_BUILD_REGISTRY_PREFIX must include registry host and repository path");
  }
  return normalized;
}

export function resolveBuildEngineConfig(env: NodeJS.ProcessEnv = process.env): BuildEngineConfig {
  const token = env.RUNDEA_BUILDER_TOKEN?.trim();
  return {
    builderTokenHash: token ? hashToken(token) : null,
    registryPrefix: normalizeRegistryPrefix(env.RUNDEA_BUILD_REGISTRY_PREFIX),
  };
}

function requireServiceId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!uuidPattern.test(id)) throw new Error("serviceId must be a UUID");
  return id;
}

function requireBuildId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!uuidPattern.test(id)) throw new Error("buildId must be a UUID");
  return id;
}

function requireWorkerId(value: string | undefined): string {
  const workerId = value?.trim() ?? "";
  if (!workerIdPattern.test(workerId)) throw new Error("X-Rundea-Builder-Id is required and invalid");
  return workerId;
}

function validateDockerfile(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("dockerfile must be a string");
  const dockerfile = value.trim();
  if (!dockerfile || dockerfile.length > 600 || dockerfile.startsWith("/") || dockerfile.split("/").includes("..") || /[\r\n\0]/.test(dockerfile)) {
    throw new Error("dockerfile path is invalid");
  }
  return dockerfile;
}

function buildRepository(prefix: string, serviceId: string): string {
  return `${prefix}/svc-${serviceId.replaceAll("-", "")}`;
}

function workerAuthorized(config: BuildEngineConfig, request: FastifyRequest): boolean {
  const token = bearer(request.headers.authorization);
  return Boolean(token && config.builderTokenHash && equalTokenHash(hashToken(token), config.builderTokenHash));
}

async function workerJob(pool: Pool, buildId: string, workerId: string) {
  const result = await pool.query(
    `SELECT id,service_id,project_id,source_repository,source_commit_sha,source_path,dockerfile,build_args,
            registry_repository,status,worker_id,lease_until,artifact_image_ref,image_id,error,
            deploy_after_push,target_service_name,target_node_id,target_container_port,target_host_port,target_healthcheck_path,deployment_id,
            started_at,completed_at,created_at,updated_at
       FROM build_jobs
      WHERE id=$1 AND worker_id=$2`,
    [buildId, workerId],
  );
  return result.rows[0] ?? null;
}

export function registerBuildEngineRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireControl: ControlPreHandler,
  dispatchQueued: DispatchQueued,
  config: BuildEngineConfig = resolveBuildEngineConfig(),
  archiveProvider: ArchiveProvider = createGitHubArchiveProviderFromEnv(),
): void {
  app.post<{ Params: { serviceId: string }; Body: { revisionSha?: string; dockerfile?: string; buildArgs?: unknown; deployAfterPush?: boolean } }>(
    "/v0/services/:serviceId/builds",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        if (!config.registryPrefix) return reply.code(503).send({ error: "Build Engine registry is not configured" });
        const serviceId = requireServiceId(request.params.serviceId);
        const service = await pool.query(
          `SELECT s.id,s.project_id,s.status,s.name,c.repository_full_name,c.revision_sha,c.source_path,c.dockerfile
             FROM services s
             JOIN service_source_configs c ON c.service_id=s.id
            WHERE s.id=$1 AND s.status='ACTIVE'`,
          [serviceId],
        );
        if (service.rowCount !== 1) return reply.code(404).send({ error: "active service source config is unavailable" });
        const row = service.rows[0];
        const revision = request.body?.revisionSha?.trim().toLowerCase() || String(row.revision_sha);
        if (!fullCommitPattern.test(revision)) throw new Error("revisionSha must be an exact 40-character Git commit SHA");
        const dockerfile = request.body?.dockerfile === undefined ? (row.dockerfile ?? null) : validateDockerfile(request.body.dockerfile);
        const buildArgs = normalizeBuildArgs(request.body?.buildArgs);
        const id = randomUUID();
        const registryRepository = buildRepository(config.registryPrefix, serviceId);
        const sourceRepository = `https://github.com/${row.repository_full_name}.git`;
        let target: Record<string, any> | null = null;
        if (request.body?.deployAfterPush === true) {
          const targetResult = await pool.query(
            `SELECT a.service_name,a.node_id,a.container_port,a.host_port,a.healthcheck_path,
                    n.status AS node_status,n.lifecycle_status,n.agent_capabilities
               FROM service_autodeploys a
               JOIN nodes n ON n.id=a.node_id
              WHERE a.service_id=$1 AND a.enabled=true`,
            [serviceId],
          );
          if (targetResult.rowCount !== 1) {
            return reply.code(409).send({ error: "automatic deploy requires enabled canonical push-autodeploy configuration" });
          }
          target = targetResult.rows[0];
          const capabilities = Array.isArray(target.agent_capabilities) ? target.agent_capabilities : [];
          if (target.node_status !== "ONLINE" || target.lifecycle_status !== "ACTIVE" || !capabilities.includes("prebuiltImages")) {
            return reply.code(409).send({ error: "automatic deploy target must be an ONLINE active node with prebuiltImages capability" });
          }
        }

        const inserted = await pool.query(
          `INSERT INTO build_jobs(
             id,service_id,project_id,source_repository,source_commit_sha,source_path,dockerfile,build_args,registry_repository,status,
             deploy_after_push,target_service_name,target_node_id,target_container_port,target_host_port,target_healthcheck_path
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED',$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            id, serviceId, row.project_id, sourceRepository, revision, row.source_path, dockerfile, buildArgs, registryRepository,
            Boolean(target), target?.service_name ?? null, target?.node_id ?? null, target?.container_port ?? null,
            target?.host_port ?? null, target?.healthcheck_path ?? null,
          ],
        );
        await pool.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','QUEUED',$2)",
          [id, target ? "build queued with automatic deploy handoff" : "build queued"],
        );
        return reply.code(201).send({ build: inserted.rows[0] });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "build could not be queued" });
      }
    },
  );

  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/builds",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const serviceId = requireServiceId(request.params.serviceId);
        const result = await pool.query(
          `SELECT id,service_id,project_id,source_repository,source_commit_sha,source_path,dockerfile,build_args,
                  registry_repository,status,worker_id,lease_until,artifact_image_ref,image_id,error,
                  deploy_after_push,target_node_id,target_container_port,target_host_port,target_healthcheck_path,deployment_id,
                  started_at,completed_at,created_at,updated_at
             FROM build_jobs WHERE service_id=$1 ORDER BY created_at DESC LIMIT 100`,
          [serviceId],
        );
        return { builds: result.rows };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "builds could not be listed" });
      }
    },
  );

  app.get<{ Params: { buildId: string } }>(
    "/v0/builds/:buildId/events",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const buildId = requireBuildId(request.params.buildId);
        const result = await pool.query(
          "SELECT id,build_id,kind,status,stream,message,created_at FROM build_events WHERE build_id=$1 ORDER BY id ASC",
          [buildId],
        );
        return { events: result.rows };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "build events could not be listed" });
      }
    },
  );

  app.post<{ Headers: { "x-rundea-builder-id"?: string } }>(
    "/v0/build-worker/jobs/claim",
    async (request, reply) => {
      if (!workerAuthorized(config, request)) return reply.code(401).send({ error: "builder authorization failed" });
      let workerId: string;
      try { workerId = requireWorkerId(request.headers["x-rundea-builder-id"]); }
      catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid builder id" }); }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `SELECT id FROM build_jobs
            WHERE (
              status='QUEUED'
              OR (status IN ('CLAIMED','BUILDING') AND lease_until < now())
            )
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
        );
        const buildId = result.rows[0]?.id;
        if (!buildId) {
          await client.query("COMMIT");
          return reply.code(204).send();
        }
        const updated = await client.query(
          `UPDATE build_jobs
              SET status='CLAIMED',worker_id=$2,lease_until=now()+($3 || ' seconds')::interval,updated_at=now()
            WHERE id=$1
            RETURNING id,service_id,project_id,source_repository,source_commit_sha,source_path,dockerfile,build_args,registry_repository,status,worker_id,lease_until`,
          [buildId, workerId, leaseSeconds],
        );
        await client.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','CLAIMED',$2)",
          [buildId, `claimed by builder ${workerId}`],
        );
        await client.query("COMMIT");
        return reply.send({ job: updated.rows[0], leaseSeconds });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { buildId: string }; Headers: { "x-rundea-builder-id"?: string } }>(
    "/v0/build-worker/jobs/:buildId/source",
    async (request, reply) => {
      if (!workerAuthorized(config, request)) return reply.code(401).send({ error: "builder authorization failed" });
      try {
        const buildId = requireBuildId(request.params.buildId);
        const workerId = requireWorkerId(request.headers["x-rundea-builder-id"]);
        const job = await workerJob(pool, buildId, workerId);
        if (!job || !["CLAIMED","BUILDING"].includes(job.status) || !job.lease_until || new Date(job.lease_until).getTime() <= Date.now()) {
          return reply.code(409).send({ error: "build lease is unavailable" });
        }
        const fullName = new URL(job.source_repository).pathname.replace(/^\//, "").replace(/\.git$/i, "");
        const archive = await archiveProvider.fetchArchive(fullName, job.source_commit_sha);
        return reply
          .header("content-type", "application/gzip")
          .header("cache-control", "no-store")
          .header("x-rundea-source-sha", job.source_commit_sha)
          .send(archive.archive);
      } catch (error) {
        request.log.warn({ err: error }, "build source fetch failed");
        return reply.code(502).send({ error: "build source fetch failed" });
      }
    },
  );

  app.post<{ Params: { buildId: string }; Headers: { "x-rundea-builder-id"?: string }; Body: { message?: string } }>(
    "/v0/build-worker/jobs/:buildId/start",
    async (request, reply) => {
      if (!workerAuthorized(config, request)) return reply.code(401).send({ error: "builder authorization failed" });
      try {
        const buildId = requireBuildId(request.params.buildId);
        const workerId = requireWorkerId(request.headers["x-rundea-builder-id"]);
        const result = await pool.query(
          `UPDATE build_jobs SET status='BUILDING',started_at=COALESCE(started_at,now()),
                   lease_until=now()+($3 || ' seconds')::interval,updated_at=now()
             WHERE id=$1 AND worker_id=$2 AND status='CLAIMED' AND lease_until > now()
             RETURNING id`,
          [buildId, workerId, leaseSeconds],
        );
        if (result.rowCount !== 1) return reply.code(409).send({ error: "build lease is unavailable" });
        await pool.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','BUILDING',$2)",
          [buildId, request.body?.message?.slice(0, 1000) || "build started"],
        );
        return reply.code(204).send();
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "build could not start" });
      }
    },
  );

  app.post<{ Params: { buildId: string }; Headers: { "x-rundea-builder-id"?: string } }>(
    "/v0/build-worker/jobs/:buildId/heartbeat",
    async (request, reply) => {
      if (!workerAuthorized(config, request)) return reply.code(401).send({ error: "builder authorization failed" });
      try {
        const buildId = requireBuildId(request.params.buildId);
        const workerId = requireWorkerId(request.headers["x-rundea-builder-id"]);
        const result = await pool.query(
          `UPDATE build_jobs SET lease_until=now()+($3 || ' seconds')::interval,updated_at=now()
             WHERE id=$1 AND worker_id=$2 AND status IN ('CLAIMED','BUILDING') AND lease_until > now()
             RETURNING id`,
          [buildId, workerId, leaseSeconds],
        );
        return result.rowCount === 1 ? reply.code(204).send() : reply.code(409).send({ error: "build lease is unavailable" });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "heartbeat rejected" });
      }
    },
  );

  app.post<{ Params: { buildId: string }; Headers: { "x-rundea-builder-id"?: string }; Body: { artifactImageRef?: string; imageId?: string } }>(
    "/v0/build-worker/jobs/:buildId/complete",
    async (request, reply) => {
      if (!workerAuthorized(config, request)) return reply.code(401).send({ error: "builder authorization failed" });
      let targetNodeId: string | null = null;
      let createdDeploymentId: string | null = null;
      const client = await pool.connect();
      try {
        const buildId = requireBuildId(request.params.buildId);
        const workerId = requireWorkerId(request.headers["x-rundea-builder-id"]);
        const artifactImageRef = request.body?.artifactImageRef?.trim() ?? "";
        const imageId = request.body?.imageId?.trim() ?? "";
        if (!digestPattern.test(imageId) || !/@sha256:[0-9a-f]{64}$/.test(artifactImageRef)) {
          throw new Error("immutable build artifact identity is invalid");
        }

        await client.query("BEGIN");
        const locked = await client.query(
          `SELECT id,service_id,source_repository,source_commit_sha,registry_repository,status,worker_id,lease_until,
                  deploy_after_push,target_service_name,target_node_id,target_container_port,target_host_port,target_healthcheck_path
             FROM build_jobs
            WHERE id=$1 AND worker_id=$2
            FOR UPDATE`,
          [buildId, workerId],
        );
        const owned = locked.rows[0];
        if (!owned || owned.status !== "BUILDING" || !owned.lease_until || new Date(owned.lease_until).getTime() <= Date.now()) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "build lease is unavailable" });
        }
        if (artifactImageRef !== `${owned.registry_repository}@${imageId}`) {
          throw new Error("build artifact repository does not match the claimed job");
        }

        await client.query(
          `UPDATE build_jobs
              SET status='PUSHED',artifact_image_ref=$3,image_id=$4,lease_until=NULL,completed_at=now(),updated_at=now()
            WHERE id=$1 AND worker_id=$2`,
          [buildId, workerId, artifactImageRef, imageId],
        );
        await client.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','PUSHED','immutable image pushed to registry')",
          [buildId],
        );

        if (owned.deploy_after_push) {
          if (!owned.target_service_name || !owned.target_node_id || !owned.target_container_port || !owned.target_host_port || owned.target_healthcheck_path === null) {
            throw new Error("automatic deploy target snapshot is incomplete");
          }
          createdDeploymentId = randomUUID();
          targetNodeId = String(owned.target_node_id);
          await client.query(
            `INSERT INTO deployments(
               id,service_id,service_name,node_id,source_repository,source_ref,source_delivery,dockerfile,build_args,
               artifact_image_ref,artifact_source_commit_sha,container_port,host_port,healthcheck_path,status,operation
             ) VALUES($1,$2,$3,$4,$5,$6,'DIRECT',NULL,'{}'::jsonb,$7,$6,$8,$9,$10,'QUEUED','DEPLOY')`,
            [
              createdDeploymentId,
              owned.service_id,
              owned.target_service_name,
              targetNodeId,
              owned.source_repository,
              owned.source_commit_sha,
              artifactImageRef,
              owned.target_container_port,
              owned.target_host_port,
              owned.target_healthcheck_path,
            ],
          );
          await captureDeploymentEnvironment(client, createdDeploymentId, owned.target_service_name);
          await client.query("UPDATE build_jobs SET deployment_id=$2,updated_at=now() WHERE id=$1", [buildId, createdDeploymentId]);
          await client.query(
            "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'LOG',NULL,$2)",
            [buildId, `automatic deployment ${createdDeploymentId} queued from immutable artifact`],
          );
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        return reply.code(400).send({ error: error instanceof Error ? error.message : "build completion rejected" });
      } finally {
        client.release();
      }

      if (targetNodeId) {
        await dispatchQueued(targetNodeId).catch((error) => request.log.error(error, "automatic build handoff dispatch failed"));
      }
      return reply.send({ ok: true, deploymentId: createdDeploymentId });
    },
  );

  app.post<{ Params: { buildId: string }; Headers: { "x-rundea-builder-id"?: string }; Body: { error?: string } }>(
    "/v0/build-worker/jobs/:buildId/fail",
    async (request, reply) => {
      if (!workerAuthorized(config, request)) return reply.code(401).send({ error: "builder authorization failed" });
      try {
        const buildId = requireBuildId(request.params.buildId);
        const workerId = requireWorkerId(request.headers["x-rundea-builder-id"]);
        const message = (request.body?.error?.trim() || "build failed").slice(0, 4000);
        const result = await pool.query(
          `UPDATE build_jobs SET status='FAILED',error=$3,lease_until=NULL,completed_at=now(),updated_at=now()
             WHERE id=$1 AND worker_id=$2 AND status IN ('CLAIMED','BUILDING')
             RETURNING id`,
          [buildId, workerId, message],
        );
        if (result.rowCount !== 1) return reply.code(409).send({ error: "build lease is unavailable" });
        await pool.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','FAILED',$2)",
          [buildId, message],
        );
        return reply.code(204).send();
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "build failure rejected" });
      }
    },
  );
}
