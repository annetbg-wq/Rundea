import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { createOpaqueToken, equalTokenHash, hashToken } from "@rundea/crypto";
import {
  createAgentReleaseProviderFromEnv,
  type AgentArchitecture,
  type GitHubAgentReleaseProvider,
} from "./agent-release";
import { createGitHubArchiveProviderFromEnv, type GitHubArchiveProvider } from "./github-app-source";
export { readResponseBodyWithLimit } from "./source-archive";

const fullCommitPattern = /^[0-9a-fA-F]{40}$/;
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const permanentNodeTokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const bundleTicketTtlMs = 2 * 60 * 1000;
const bootstrapTtlMs = 30 * 60 * 1000;

type SourceDelivery = "DIRECT" | "BROKER";

type RepositoryIdentity = {
  owner: string;
  repository: string;
  fullName: string;
};

type ArchiveProvider = Pick<GitHubArchiveProvider, "fetchArchive">;
type ReleaseProvider = Pick<GitHubAgentReleaseProvider, "get">;

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export function validatePublicControlPlaneUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RUNDEA_PUBLIC_CONTROL_PLANE_URL must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("RUNDEA_PUBLIC_CONTROL_PLANE_URL must be an HTTPS origin without credentials, path, query or fragment");
  }
  return url.origin;
}

export function validateSourceDelivery(value: unknown, ref: string): SourceDelivery {
  const delivery = value === undefined || value === null || value === "" ? "DIRECT" : String(value).toUpperCase();
  if (delivery !== "DIRECT" && delivery !== "BROKER") throw new Error("sourceDelivery must be DIRECT or BROKER");
  if (delivery === "BROKER" && !fullCommitPattern.test(ref)) {
    throw new Error("brokered source delivery requires an exact 40-character Git commit SHA");
  }
  return delivery;
}

export function canonicalGitHubRepository(input: string): RepositoryIdentity {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("source repository must be a valid HTTPS GitHub URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("source repository must be an HTTPS github.com URL without credentials, query or fragment");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("source repository must identify exactly owner/repository");
  const owner = parts[0]!;
  const repository = parts[1]!.replace(/\.git$/i, "");
  if (!owner || !repository || !repoPartPattern.test(owner) || !repoPartPattern.test(repository)) {
    throw new Error("source repository owner/name contains unsupported characters");
  }
  return { owner, repository, fullName: `${owner}/${repository}` };
}

// Migration 007 is applied synchronously by the Control Plane startup runner
// before routes are registered. Re-running that DDL asynchronously here used
// to race other module schema setup and can deadlock PostgreSQL. Keep one
// migration owner; helpers only wait on already-completed startup schema.
function ensureSchema(_pool: Pool): Promise<void> {
  return Promise.resolve();
}

export async function issueSourceBundleTicket(
  pool: Pool,
  deploymentId: string,
  nodeId: string,
  sourceRepository: string,
  sourceRef: string,
): Promise<string> {
  await ensureSchema(pool);
  if (!fullCommitPattern.test(sourceRef)) throw new Error("broker source ref must be an exact commit SHA");
  const repository = canonicalGitHubRepository(sourceRepository);
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + bundleTicketTtlMs);
  await pool.query(
    `INSERT INTO source_bundle_tickets(
       deployment_id,node_id,token_hash,repository_full_name,commit_sha,expires_at,consumed_at,created_at
     ) VALUES($1,$2,$3,$4,$5,$6,NULL,now())
     ON CONFLICT(deployment_id) DO UPDATE SET
       node_id=EXCLUDED.node_id,
       token_hash=EXCLUDED.token_hash,
       repository_full_name=EXCLUDED.repository_full_name,
       commit_sha=EXCLUDED.commit_sha,
       expires_at=EXCLUDED.expires_at,
       consumed_at=NULL,
       created_at=now()`,
    [deploymentId, nodeId, hashToken(token), repository.fullName, sourceRef.toLowerCase(), expiresAt],
  );
  return token;
}

async function claimSourceBundleTicket(
  pool: Pool,
  deploymentId: string,
  nodeId: string,
  token: string,
): Promise<{ repositoryFullName: string; commitSha: string } | null> {
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT node_id,token_hash,repository_full_name,commit_sha,expires_at,consumed_at
         FROM source_bundle_tickets
        WHERE deployment_id=$1
        FOR UPDATE`,
      [deploymentId],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = result.rows[0];
    const valid =
      row.node_id === nodeId &&
      !row.consumed_at &&
      new Date(row.expires_at).getTime() > Date.now() &&
      equalTokenHash(row.token_hash, hashToken(token));
    if (!valid) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("UPDATE source_bundle_tickets SET consumed_at=now() WHERE deployment_id=$1", [deploymentId]);
    await client.query("COMMIT");
    return { repositoryFullName: row.repository_full_name, commitSha: row.commit_sha };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function authenticateAgentReleaseCredential(pool: Pool, nodeId: string, token: string): Promise<boolean> {
  await ensureSchema(pool);
  const result = await pool.query(
    "SELECT token_hash,bootstrap_token_hash,bootstrap_expires_at,status,last_seen_at FROM nodes WHERE id=$1",
    [nodeId],
  );
  if (result.rowCount !== 1) return false;
  const row = result.rows[0];
  const candidateHash = hashToken(token);
  if (equalTokenHash(row.token_hash, candidateHash)) return true;
  const bootstrapExpiresAt = row.bootstrap_expires_at ? new Date(row.bootstrap_expires_at).getTime() : NaN;
  return Boolean(
    row.bootstrap_token_hash &&
    row.status === "OFFLINE" &&
    !row.last_seen_at &&
    Number.isFinite(bootstrapExpiresAt) &&
    bootstrapExpiresAt > Date.now() &&
    equalTokenHash(row.bootstrap_token_hash, candidateHash),
  );
}

async function authenticatePermanentNodeCredential(pool: Pool, nodeId: string, token: string): Promise<boolean> {
  await ensureSchema(pool);
  const result = await pool.query("SELECT token_hash FROM nodes WHERE id=$1", [nodeId]);
  return result.rowCount === 1 && equalTokenHash(result.rows[0].token_hash, hashToken(token));
}

async function exchangeBootstrapCredential(pool: Pool, nodeId: string, bootstrapToken: string, agentToken: string): Promise<boolean> {
  await ensureSchema(pool);
  if (!permanentNodeTokenPattern.test(agentToken)) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT bootstrap_token_hash,bootstrap_expires_at,status,last_seen_at FROM nodes WHERE id=$1 FOR UPDATE",
      [nodeId],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const row = result.rows[0];
    const bootstrapExpiresAt = row.bootstrap_expires_at ? new Date(row.bootstrap_expires_at).getTime() : NaN;
    const valid =
      Boolean(row.bootstrap_token_hash) &&
      row.status === "OFFLINE" &&
      !row.last_seen_at &&
      Number.isFinite(bootstrapExpiresAt) &&
      bootstrapExpiresAt > Date.now() &&
      equalTokenHash(row.bootstrap_token_hash, hashToken(bootstrapToken));
    if (!valid) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      "UPDATE nodes SET token_hash=$2,bootstrap_token_hash=NULL,bootstrap_expires_at=NULL WHERE id=$1",
      [nodeId, hashToken(agentToken)],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function agentArchitecture(value: string): AgentArchitecture | null {
  return value === "amd64" || value === "arm64" ? value : null;
}

export function registerSourceBrokerRoutes(
  app: FastifyInstance,
  pool: Pool,
  archiveProvider: ArchiveProvider = createGitHubArchiveProviderFromEnv(),
  releaseProvider: ReleaseProvider | null = createAgentReleaseProviderFromEnv(),
): void {
  const schemaReady = ensureSchema(pool);
  const publicControlPlaneUrl = validatePublicControlPlaneUrl(process.env.RUNDEA_PUBLIC_CONTROL_PLANE_URL);
  const installerScript = readFile(new URL("../../../infra/agent/install.sh", import.meta.url), "utf8");

  app.get("/v0/bootstrap-info", async () => ({
    controlPlaneUrl: publicControlPlaneUrl,
    installerUrl: publicControlPlaneUrl ? `${publicControlPlaneUrl}/v0/install.sh` : null,
    agentReleaseConfigured: Boolean(releaseProvider),
    bootstrapTtlSeconds: Math.floor(bootstrapTtlMs / 1000),
  }));

  app.get("/v0/install.sh", async (_request, reply) => reply
    .header("content-type", "text/x-shellscript; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .send(await installerScript));

  app.post<{ Params: { nodeId: string }; Body: { agentToken?: string } }>("/v0/nodes/:nodeId/bootstrap/exchange", async (request, reply) => {
    const bootstrapToken = bearer(request.headers.authorization);
    const agentToken = request.body?.agentToken?.trim();
    if (!bootstrapToken || !agentToken) return reply.code(401).send({ error: "node bootstrap authorization failed" });
    const exchanged = await exchangeBootstrapCredential(pool, request.params.nodeId, bootstrapToken, agentToken);
    return exchanged ? reply.code(204).send() : reply.code(401).send({ error: "node bootstrap authorization failed" });
  });

  app.get<{ Params: { nodeId: string } }>("/v0/nodes/:nodeId/self/status", async (request, reply) => {
    const token = bearer(request.headers.authorization);
    if (!token || !(await authenticatePermanentNodeCredential(pool, request.params.nodeId, token))) {
      return reply.code(401).send({ error: "node self authorization failed" });
    }
    const result = await pool.query("SELECT status FROM nodes WHERE id=$1", [request.params.nodeId]);
    if (result.rowCount !== 1) return reply.code(401).send({ error: "node self authorization failed" });
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("cache-control", "no-store")
      .send(`${result.rows[0].status}\n`);
  });

  app.get<{ Params: { architecture: string } }>("/v0/agent/releases/:architecture/sha256", async (request, reply) => {
    const architecture = agentArchitecture(request.params.architecture);
    const token = bearer(request.headers.authorization);
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    if (!architecture || !token || !nodeId || !(await authenticateAgentReleaseCredential(pool, nodeId, token))) {
      return reply.code(401).send({ error: "agent release authorization failed" });
    }
    if (!releaseProvider) return reply.code(503).send({ error: "agent release distribution is not configured" });
    try {
      const release = await releaseProvider.get(architecture);
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-rundea-agent-release", release.tag)
        .send(`${release.sha256}\n`);
    } catch (error) {
      request.log.warn({ err: error, architecture }, "Agent release resolution failed");
      return reply.code(502).send({ error: "agent release resolution failed" });
    }
  });

  app.get<{ Params: { architecture: string } }>("/v0/agent/releases/:architecture", async (request, reply) => {
    const architecture = agentArchitecture(request.params.architecture);
    const token = bearer(request.headers.authorization);
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    if (!architecture || !token || !nodeId || !(await authenticateAgentReleaseCredential(pool, nodeId, token))) {
      return reply.code(401).send({ error: "agent release authorization failed" });
    }
    if (!releaseProvider) return reply.code(503).send({ error: "agent release distribution is not configured" });
    try {
      const release = await releaseProvider.get(architecture);
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(release.binary.byteLength))
        .header("cache-control", "no-store")
        .header("x-rundea-agent-sha256", release.sha256)
        .header("x-rundea-agent-release", release.tag)
        .send(release.binary);
    } catch (error) {
      request.log.warn({ err: error, architecture }, "Agent release resolution failed");
      return reply.code(502).send({ error: "agent release resolution failed" });
    }
  });

  app.get<{ Params: { deploymentId: string } }>("/v0/source-bundles/:deploymentId", async (request: FastifyRequest<{ Params: { deploymentId: string } }>, reply: FastifyReply) => {
    await schemaReady;
    const token = bearer(request.headers.authorization);
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    if (!token || !nodeId) return reply.code(401).send({ error: "source bundle authorization failed" });

    const ticket = await claimSourceBundleTicket(pool, request.params.deploymentId, nodeId, token);
    if (!ticket) return reply.code(401).send({ error: "source bundle authorization failed" });

    try {
      const result = await archiveProvider.fetchArchive(ticket.repositoryFullName, ticket.commitSha);
      if (result.authMode === "GITHUB_APP") {
        await pool.query(
          `INSERT INTO deployment_events(deployment_id,kind,stream,message)
           VALUES($1,'LOG','system','source archive fetched through Rundea GitHub App')`,
          [request.params.deploymentId],
        );
      }
      return reply
        .header("content-type", "application/gzip")
        .header("cache-control", "no-store")
        .header("x-rundea-source-sha", ticket.commitSha)
        .send(result.archive);
    } catch {
      request.log.warn({ deploymentId: request.params.deploymentId }, "source bundle upstream fetch failed");
      return reply.code(502).send({ error: "source bundle upstream fetch failed" });
    }
  });
}
