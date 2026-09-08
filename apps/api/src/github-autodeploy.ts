import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { captureDeploymentEnvironment } from "./service-variables";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type DispatchQueued = (nodeId: string) => Promise<void>;

type AutodeployInput = {
  nodeId?: string;
  repository?: string;
  branch?: string;
  dockerfile?: string;
  containerPort?: number;
  hostPort?: number;
  healthcheckPath?: string;
  enabled?: boolean;
};

type PushPayload = {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { full_name?: unknown };
};

const fullCommitPattern = /^[0-9a-fA-F]{40}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const serviceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireServiceName(value: string): string {
  if (!serviceNamePattern.test(value)) throw new Error("invalid service name");
  return value;
}

export function canonicalGitHubRepository(input: string): { fullName: string; cloneUrl: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("repository must be a valid HTTPS GitHub URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("repository must be an HTTPS github.com URL without credentials, query or fragment");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("repository URL must identify exactly owner/repository");
  const owner = parts[0]!;
  const repository = parts[1]!.replace(/\.git$/i, "");
  if (!owner || !repository || !repoPartPattern.test(owner) || !repoPartPattern.test(repository)) {
    throw new Error("repository owner/name contains unsupported characters");
  }
  return {
    fullName: `${owner}/${repository}`.toLowerCase(),
    cloneUrl: `https://github.com/${owner}/${repository}.git`,
  };
}

export function validateGitHubBranch(branch: string): string {
  const value = branch.trim();
  if (!value || value.length > 255) throw new Error("branch must be between 1 and 255 characters");
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    throw new Error("branch has an invalid Git ref shape");
  }
  if (/\s|[~^:?*\\[\x00-\x1f\x7f]/.test(value) || value.includes("..") || value.includes("//") || value.includes("@{")) {
    throw new Error("branch contains unsupported Git ref characters");
  }
  return value;
}

export function verifyGitHubSignature(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const providedHex = signature.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(providedHex, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function validateDockerfile(value: string | undefined): string | null {
  const dockerfile = value?.trim() || null;
  if (!dockerfile) return null;
  if (dockerfile.length > 512 || dockerfile.startsWith("/") || dockerfile.includes("\u0000") || /[\r\n]/.test(dockerfile)) {
    throw new Error("dockerfile path is invalid");
  }
  if (dockerfile.split("/").includes("..")) throw new Error("dockerfile path must stay inside the repository");
  return dockerfile;
}

function validateHealthcheck(value: string | undefined): string {
  const path = value?.trim() ?? "";
  if (path.length > 512 || /[\r\n\u0000]/.test(path) || (path && !path.startsWith("/"))) {
    throw new Error("healthcheckPath must be blank or an absolute URL path up to 512 characters");
  }
  return path;
}

function normalizePayloadFullName(value: unknown): string {
  if (typeof value !== "string") throw new Error("push payload repository.full_name is required");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !repoPartPattern.test(parts[0]) || !repoPartPattern.test(parts[1])) {
    throw new Error("push payload repository.full_name is invalid");
  }
  return value.toLowerCase();
}

function deliveryIdFrom(request: FastifyRequest): string {
  const deliveryId = singleHeader(request.headers["x-github-delivery"]);
  if (!deliveryId || deliveryId.length > 200 || /[\r\n\u0000]/.test(deliveryId)) throw new Error("X-GitHub-Delivery is required");
  return deliveryId;
}

async function duplicateResponse(
  pool: Pool,
  deliveryId: string,
  bodySha256: string,
): Promise<{ ok: true; duplicate: true; status: string; deploymentCount: number; originalDeliveryId?: string }> {
  const existing = await pool.query(
    `SELECT delivery_id,status,deployment_count
       FROM github_webhook_deliveries
      WHERE delivery_id=$1 OR body_sha256=$2
      ORDER BY (delivery_id=$1) DESC,received_at ASC
      LIMIT 1`,
    [deliveryId, bodySha256],
  );
  return {
    ok: true,
    duplicate: true,
    status: existing.rows[0]?.status ?? "UNKNOWN",
    deploymentCount: Number(existing.rows[0]?.deployment_count ?? 0),
    ...(existing.rows[0]?.delivery_id ? { originalDeliveryId: String(existing.rows[0].delivery_id) } : {}),
  };
}

export function registerGitHubAutodeployRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireControl: RequireControl,
  dispatchQueued: DispatchQueued,
  webhookSecret: string | undefined,
): void {
  const migrationUrl = new URL("../migrations/006_github_autodeploy.sql", import.meta.url);
  const schemaReady = readFile(migrationUrl, "utf8").then((sql) => pool.query(sql)).then(() => undefined);

  app.put<{ Params: { serviceName: string }; Body: AutodeployInput }>(
    "/v0/services/:serviceName/autodeploy",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        await schemaReady;
        const serviceName = requireServiceName(request.params.serviceName);
        const body = request.body ?? {};
        if (!body.nodeId || !uuidPattern.test(body.nodeId)) throw new Error("nodeId must be a UUID");
        if (!body.repository) throw new Error("repository is required");
        if (!body.branch) throw new Error("branch is required");
        if (!Number.isInteger(body.containerPort) || !Number.isInteger(body.hostPort)) {
          throw new Error("containerPort and hostPort must be integers");
        }
        if (body.containerPort! < 1 || body.containerPort! > 65535 || body.hostPort! < 1 || body.hostPort! > 65535) {
          throw new Error("containerPort and hostPort must be between 1 and 65535");
        }
        const repository = canonicalGitHubRepository(body.repository);
        const branch = validateGitHubBranch(body.branch);
        const dockerfile = validateDockerfile(body.dockerfile);
        const healthcheckPath = validateHealthcheck(body.healthcheckPath);
        const result = await pool.query(
          `INSERT INTO service_autodeploys(
             service_name,node_id,repository_full_name,source_repository,source_branch,dockerfile,
             container_port,host_port,healthcheck_path,enabled,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           ON CONFLICT(service_name) DO UPDATE SET
             node_id=EXCLUDED.node_id,
             repository_full_name=EXCLUDED.repository_full_name,
             source_repository=EXCLUDED.source_repository,
             source_branch=EXCLUDED.source_branch,
             dockerfile=EXCLUDED.dockerfile,
             container_port=EXCLUDED.container_port,
             host_port=EXCLUDED.host_port,
             healthcheck_path=EXCLUDED.healthcheck_path,
             enabled=EXCLUDED.enabled,
             updated_at=now()
           RETURNING service_name,node_id,repository_full_name,source_repository,source_branch,dockerfile,
                     container_port,host_port,healthcheck_path,enabled,created_at,updated_at`,
          [
            serviceName,
            body.nodeId,
            repository.fullName,
            repository.cloneUrl,
            branch,
            dockerfile,
            body.containerPort,
            body.hostPort,
            healthcheckPath,
            body.enabled ?? true,
          ],
        );
        return reply.send({ autodeploy: result.rows[0] });
      } catch (error) {
        request.log.error(error, "autodeploy configuration rejected");
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid autodeploy configuration" });
      }
    },
  );

  app.get<{ Params: { serviceName: string } }>(
    "/v0/services/:serviceName/autodeploy",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        await schemaReady;
        const serviceName = requireServiceName(request.params.serviceName);
        const result = await pool.query(
          `SELECT service_name,node_id,repository_full_name,source_repository,source_branch,dockerfile,
                  container_port,host_port,healthcheck_path,enabled,created_at,updated_at
             FROM service_autodeploys WHERE service_name=$1`,
          [serviceName],
        );
        return result.rowCount === 1 ? reply.send({ autodeploy: result.rows[0] }) : reply.code(404).send({ error: "autodeploy not configured" });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid service" });
      }
    },
  );

  app.delete<{ Params: { serviceName: string } }>(
    "/v0/services/:serviceName/autodeploy",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        await schemaReady;
        const serviceName = requireServiceName(request.params.serviceName);
        const result = await pool.query("DELETE FROM service_autodeploys WHERE service_name=$1", [serviceName]);
        return result.rowCount === 1 ? reply.code(204).send() : reply.code(404).send({ error: "autodeploy not configured" });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid service" });
      }
    },
  );

  app.get("/v0/github/deliveries", { preHandler: requireControl }, async () => {
    await schemaReady;
    const result = await pool.query(
      `SELECT d.delivery_id,d.event_name,d.repository_full_name,d.source_branch,d.after_sha,d.status,
              d.deployment_count,d.received_at,d.completed_at,
              COALESCE(json_agg(json_build_object('serviceName',m.service_name,'deploymentId',m.deployment_id))
                       FILTER (WHERE m.deployment_id IS NOT NULL),'[]'::json) AS deployments
         FROM github_webhook_deliveries d
         LEFT JOIN github_webhook_deployments m ON m.delivery_id=d.delivery_id
        GROUP BY d.delivery_id
        ORDER BY d.received_at DESC
        LIMIT 100`,
    );
    return { deliveries: result.rows };
  });

  void app.register(async (github) => {
    github.removeContentTypeParser("application/json");
    github.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

    github.post<{ Body: Buffer }>("/v0/github/webhook", { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
      if (!webhookSecret) return reply.code(503).send({ error: "GitHub webhook is not configured" });
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) return reply.code(400).send({ error: "webhook body must be JSON" });
      const signature = singleHeader(request.headers["x-hub-signature-256"]);
      if (!verifyGitHubSignature(webhookSecret, rawBody, signature)) return reply.code(401).send({ error: "invalid webhook signature" });
      const bodySha256 = createHash("sha256").update(rawBody).digest("hex");

      const eventName = singleHeader(request.headers["x-github-event"]);
      if (!eventName) return reply.code(400).send({ error: "X-GitHub-Event is required" });
      if (eventName === "ping") return reply.send({ ok: true, event: "ping" });
      if (eventName !== "push") return reply.code(202).send({ ok: true, ignored: true, reason: "unsupported event" });

      await schemaReady;
      let deliveryId: string;
      let payload: PushPayload;
      try {
        deliveryId = deliveryIdFrom(request);
        payload = JSON.parse(rawBody.toString("utf8")) as PushPayload;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid webhook payload" });
      }

      let repositoryFullName: string;
      let branch: string;
      let afterSha: string;
      try {
        repositoryFullName = normalizePayloadFullName(payload.repository?.full_name);
        if (typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/")) throw new Error("push ref must be refs/heads/<branch>");
        branch = validateGitHubBranch(payload.ref.slice("refs/heads/".length));
        if (typeof payload.after !== "string" || !fullCommitPattern.test(payload.after)) throw new Error("push after must be a full Git commit SHA");
        afterSha = payload.after.toLowerCase();
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid push payload" });
      }

      const client = await pool.connect();
      const created: Array<{ serviceName: string; deploymentId: string; nodeId: string }> = [];
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO github_webhook_deliveries(
             delivery_id,body_sha256,event_name,repository_full_name,source_branch,after_sha,status
           ) VALUES($1,$2,'push',$3,$4,$5,'RECEIVED')
           ON CONFLICT DO NOTHING
           RETURNING delivery_id`,
          [deliveryId, bodySha256, repositoryFullName, branch, afterSha],
        );
        if (inserted.rowCount !== 1) {
          await client.query("ROLLBACK");
          return reply.send(await duplicateResponse(pool, deliveryId, bodySha256));
        }

        const deleted = payload.deleted === true || /^0{40}$/.test(afterSha);
        if (deleted) {
          await client.query(
            "UPDATE github_webhook_deliveries SET status='IGNORED',completed_at=now() WHERE delivery_id=$1",
            [deliveryId],
          );
          await client.query("COMMIT");
          return reply.code(202).send({ ok: true, ignored: true, reason: "branch deletion", deployments: [] });
        }

        const configs = await client.query(
          `SELECT service_name,node_id,source_repository,dockerfile,container_port,host_port,healthcheck_path
             FROM service_autodeploys
            WHERE enabled=true AND repository_full_name=$1 AND source_branch=$2
            ORDER BY service_name ASC
            FOR SHARE`,
          [repositoryFullName, branch],
        );
        for (const config of configs.rows) {
          const deploymentId = randomUUID();
          await client.query(
            `INSERT INTO deployments(
               id,service_name,node_id,source_repository,source_ref,dockerfile,container_port,host_port,
               healthcheck_path,status,operation
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'QUEUED','DEPLOY')`,
            [
              deploymentId,
              config.service_name,
              config.node_id,
              config.source_repository,
              afterSha,
              config.dockerfile,
              config.container_port,
              config.host_port,
              config.healthcheck_path,
            ],
          );
          await captureDeploymentEnvironment(client, deploymentId, config.service_name);
          await client.query(
            "INSERT INTO github_webhook_deployments(delivery_id,service_name,deployment_id) VALUES($1,$2,$3)",
            [deliveryId, config.service_name, deploymentId],
          );
          created.push({ serviceName: config.service_name, deploymentId, nodeId: config.node_id });
        }

        await client.query(
          `UPDATE github_webhook_deliveries
              SET status=$2,deployment_count=$3,completed_at=now()
            WHERE delivery_id=$1`,
          [deliveryId, created.length > 0 ? "TRIGGERED" : "IGNORED", created.length],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        request.log.error(error, "GitHub push autodeploy transaction failed");
        return reply.code(500).send({ error: "GitHub push could not create deployment" });
      } finally {
        client.release();
      }

      for (const nodeId of new Set(created.map((item) => item.nodeId))) {
        await dispatchQueued(nodeId).catch((error) => request.log.error(error, "failed to dispatch GitHub-triggered deployment"));
      }
      return reply.code(202).send({
        ok: true,
        status: created.length > 0 ? "TRIGGERED" : "IGNORED",
        deployments: created.map(({ serviceName, deploymentId }) => ({ serviceName, deploymentId })),
      });
    });
  });
}
