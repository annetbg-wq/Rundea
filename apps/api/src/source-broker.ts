import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { createOpaqueToken, equalTokenHash, hashToken } from "@rundea/crypto";

const fullCommitPattern = /^[0-9a-fA-F]{40}$/;
const repoPartPattern = /^[A-Za-z0-9_.-]+$/;
const bundleTicketTtlMs = 2 * 60 * 1000;
const maxCompressedBundleBytes = 64 * 1024 * 1024;

type SourceDelivery = "DIRECT" | "BROKER";

type RepositoryIdentity = {
  owner: string;
  repository: string;
  fullName: string;
};

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
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

const schemaReadyByPool = new WeakMap<Pool, Promise<void>>();

function ensureSchema(pool: Pool): Promise<void> {
  let existing = schemaReadyByPool.get(pool);
  if (!existing) {
    existing = (async () => {
      const migrationUrl = new URL("../migrations/007_source_broker.sql", import.meta.url);
      await pool.query(await readFile(migrationUrl, "utf8"));
    })();
    schemaReadyByPool.set(pool, existing);
  }
  return existing;
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

async function fetchPublicGitHubArchive(repositoryFullName: string, commitSha: string): Promise<Buffer> {
  const [owner, repository] = repositoryFullName.split("/");
  if (!owner || !repository || !repoPartPattern.test(owner) || !repoPartPattern.test(repository) || !fullCommitPattern.test(commitSha)) {
    throw new Error("invalid source bundle identity");
  }
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/tarball/${commitSha.toLowerCase()}`;
  const response = await fetch(endpoint, {
    redirect: "follow",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Rundea-Control-Plane",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub source archive returned ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxCompressedBundleBytes) {
    throw new Error("source archive exceeds v0 compressed size limit");
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length === 0 || archive.length > maxCompressedBundleBytes) {
    throw new Error("source archive is empty or exceeds v0 compressed size limit");
  }
  return archive;
}

export function registerSourceBrokerRoutes(app: FastifyInstance, pool: Pool): void {
  const schemaReady = ensureSchema(pool);
  app.get<{ Params: { deploymentId: string } }>("/v0/source-bundles/:deploymentId", async (request: FastifyRequest<{ Params: { deploymentId: string } }>, reply: FastifyReply) => {
    await schemaReady;
    const token = bearer(request.headers.authorization);
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    if (!token || !nodeId) return reply.code(401).send({ error: "source bundle authorization failed" });

    const ticket = await claimSourceBundleTicket(pool, request.params.deploymentId, nodeId, token);
    if (!ticket) return reply.code(401).send({ error: "source bundle authorization failed" });

    try {
      const archive = await fetchPublicGitHubArchive(ticket.repositoryFullName, ticket.commitSha);
      return reply
        .header("content-type", "application/gzip")
        .header("cache-control", "no-store")
        .header("x-rundea-source-sha", ticket.commitSha)
        .send(archive);
    } catch (error) {
      request.log.error(error, "source bundle upstream fetch failed");
      return reply.code(502).send({ error: "source bundle upstream fetch failed" });
    }
  });
}
