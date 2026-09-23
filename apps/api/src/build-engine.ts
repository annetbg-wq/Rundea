import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { equalTokenHash, hashToken } from "@rundea/crypto";
import { normalizeBuildArgs } from "./build-args";
import { createGitHubArchiveProviderFromEnv, type GitHubArchiveProvider } from "./github-app-source";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type ArchiveProvider = Pick<GitHubArchiveProvider, "fetchArchive">;

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
    `SELECT id,service_id,project_id,source_repository,source_commit_sha,dockerfile,build_args,
            registry_repository,status,worker_id,lease_until,artifact_image_ref,image_id,error,
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
  config: BuildEngineConfig = resolveBuildEngineConfig(),
  archiveProvider: ArchiveProvider = createGitHubArchiveProviderFromEnv(),
): void {
  app.post<{ Params: { serviceId: string }; Body: { revisionSha?: string; dockerfile?: string; buildArgs?: unknown } }>(
    "/v0/services/:serviceId/builds",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        if (!config.registryPrefix) return reply.code(503).send({ error: "Build Engine registry is not configured" });
        const serviceId = requireServiceId(request.params.serviceId);
        const service = await pool.query(
          `SELECT s.id,s.project_id,s.status,s.name,c.repository_full_name,c.revision_sha,c.dockerfile
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
        const inserted = await pool.query(
          `INSERT INTO build_jobs(
             id,service_id,project_id,source_repository,source_commit_sha,dockerfile,build_args,registry_repository,status
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'QUEUED')
           RETURNING *`,
          [id, serviceId, row.project_id, sourceRepository, revision, dockerfile, buildArgs, registryRepository],
        );
        await pool.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','QUEUED','build queued')",
          [id],
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
          `SELECT id,service_id,project_id,source_repository,source_commit_sha,dockerfile,build_args,
                  registry_repository,status,worker_id,lease_until,artifact_image_ref,image_id,error,
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
            RETURNING id,service_id,project_id,source_repository,source_commit_sha,dockerfile,build_args,registry_repository,status,worker_id,lease_until`,
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
      try {
        const buildId = requireBuildId(request.params.buildId);
        const workerId = requireWorkerId(request.headers["x-rundea-builder-id"]);
        const artifactImageRef = request.body?.artifactImageRef?.trim() ?? "";
        const imageId = request.body?.imageId?.trim() ?? "";
        if (!artifactImageRef.endsWith(imageId) || !digestPattern.test(imageId) || !/@sha256:[0-9a-f]{64}$/.test(artifactImageRef)) {
          throw new Error("immutable build artifact identity is invalid");
        }
        const result = await pool.query(
          `UPDATE build_jobs SET status='PUSHED',artifact_image_ref=$3,image_id=$4,
                   lease_until=NULL,completed_at=now(),updated_at=now()
             WHERE id=$1 AND worker_id=$2 AND status='BUILDING' AND lease_until > now()
             RETURNING id`,
          [buildId, workerId, artifactImageRef, imageId],
        );
        if (result.rowCount !== 1) return reply.code(409).send({ error: "build lease is unavailable" });
        await pool.query(
          "INSERT INTO build_events(build_id,kind,status,message) VALUES($1,'STATUS','PUSHED','immutable image pushed to registry')",
          [buildId],
        );
        return reply.code(204).send();
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "build completion rejected" });
      }
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
