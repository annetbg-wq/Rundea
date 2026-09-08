import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { createOpaqueToken, equalTokenHash, hashToken } from "@rundea/crypto";
import { canonicalGitHubRepository } from "./github-autodeploy";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type PrivateSourceAccess = {
  kind: "rundeaGrant";
  grantId: string;
  token: string;
};

const fullCommitPattern = /^[0-9a-f]{40}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const officialGitHubApi = "https://api.github.com";
const maxArchiveBytes = 64 * 1024 * 1024;
const schemaReady = new WeakMap<Pool, Promise<void>>();

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function ensurePrivateSourceSchema(pool: Pool): Promise<void> {
  let promise = schemaReady.get(pool);
  if (!promise) {
    promise = (async () => {
      const migrationUrl = new URL("../migrations/007_private_github_source.sql", import.meta.url);
      await pool.query(await readFile(migrationUrl, "utf8"));
    })();
    schemaReady.set(pool, promise);
  }
  await promise;
}

function normalizeInstallationId(value: unknown): string {
  const id = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^[1-9][0-9]{0,19}$/.test(id)) throw new Error("installationId must be a positive decimal GitHub installation id");
  return id;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  if (!/^[1-9][0-9]*$/.test(appId)) throw new Error("RUNDEA_GITHUB_APP_ID must be a positive integer");
  const now = Math.floor(nowMs / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({ iat: now - 60, exp: now + 540, iss: appId });
  const input = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  const signature = signer.sign(privateKeyPem.replace(/\\n/g, "\n")).toString("base64url");
  return `${input}.${signature}`;
}

function githubApiBase(): URL {
  const raw = process.env.RUNDEA_GITHUB_API_BASE_URL?.trim() || officialGitHubApi;
  const base = new URL(raw);
  const normalized = base.origin + base.pathname.replace(/\/$/, "");
  if (normalized !== officialGitHubApi && process.env.RUNDEA_ALLOW_TEST_GITHUB_BASE_URL !== "1") {
    throw new Error("non-GitHub API base URL is allowed only with RUNDEA_ALLOW_TEST_GITHUB_BASE_URL=1");
  }
  return new URL(normalized + "/");
}

async function installationToken(installationId: string, repositoryFullName: string): Promise<string> {
  const base = githubApiBase();
  const testToken = process.env.RUNDEA_GITHUB_TEST_INSTALLATION_TOKEN;
  if (base.origin !== "https://api.github.com" && testToken) return testToken;

  const appId = process.env.RUNDEA_GITHUB_APP_ID?.trim();
  const privateKey = process.env.RUNDEA_GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) throw new Error("GitHub App credentials are not configured on the Control Plane");
  const jwt = createGitHubAppJwt(appId, privateKey);
  const repositoryName = repositoryFullName.split("/")[1]!;
  const endpoint = new URL(`app/installations/${installationId}/access_tokens`, base);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Rundea-Control-Plane",
    },
    body: JSON.stringify({ repositories: [repositoryName], permissions: { contents: "read" } }),
  });
  if (!response.ok) throw new Error(`GitHub installation token request failed with HTTP ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) throw new Error("GitHub installation token response did not contain a token");
  return body.token;
}

async function fetchPrivateArchive(installationId: string, repositoryFullName: string, sourceCommitSha: string): Promise<Buffer> {
  const token = await installationToken(installationId, repositoryFullName);
  const endpoint = new URL(`repos/${repositoryFullName}/tarball/${sourceCommitSha}`, githubApiBase());
  const response = await fetch(endpoint, {
    redirect: "follow",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "Rundea-Control-Plane",
    },
  });
  if (!response.ok) throw new Error(`GitHub source archive request failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxArchiveBytes) throw new Error("GitHub source archive exceeds the 64 MiB v0 limit");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxArchiveBytes) throw new Error("GitHub source archive exceeds the 64 MiB v0 limit");
  if (buffer.length === 0) throw new Error("GitHub source archive was empty");
  return buffer;
}

export async function preparePrivateSourceAccess(
  pool: Pool,
  deploymentId: string,
  nodeId: string,
  sourceRepository: string,
  sourceRef: string,
): Promise<PrivateSourceAccess | undefined> {
  await ensurePrivateSourceSchema(pool);
  const repository = canonicalGitHubRepository(sourceRepository);
  const mapping = await pool.query(
    "SELECT installation_id::text AS installation_id FROM github_repository_installations WHERE repository_full_name=$1",
    [repository.fullName],
  );
  if (mapping.rowCount !== 1) return undefined;
  if (!fullCommitPattern.test(sourceRef)) throw new Error("private GitHub source requires an exact 40-hex commit SHA");

  const grantId = randomUUID();
  const token = createOpaqueToken();
  await pool.query(
    `INSERT INTO source_grants(id,deployment_id,node_id,token_hash,repository_full_name,source_commit_sha,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')
     ON CONFLICT(deployment_id) DO UPDATE SET
       id=EXCLUDED.id,
       node_id=EXCLUDED.node_id,
       token_hash=EXCLUDED.token_hash,
       repository_full_name=EXCLUDED.repository_full_name,
       source_commit_sha=EXCLUDED.source_commit_sha,
       expires_at=EXCLUDED.expires_at,
       lease_until=NULL,
       consumed_at=NULL,
       created_at=now()`,
    [grantId, deploymentId, nodeId, hashToken(token), repository.fullName, sourceRef.toLowerCase()],
  );
  return { kind: "rundeaGrant", grantId, token };
}

async function beginGrantFetch(
  pool: Pool,
  grantId: string,
  nodeId: string,
  nodeToken: string,
  grantToken: string,
): Promise<{ repositoryFullName: string; sourceCommitSha: string; installationId: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT g.node_id,g.token_hash,g.repository_full_name,g.source_commit_sha,g.expires_at,g.lease_until,g.consumed_at,
              n.token_hash AS node_token_hash,i.installation_id::text AS installation_id
         FROM source_grants g
         JOIN nodes n ON n.id=g.node_id
         JOIN github_repository_installations i ON i.repository_full_name=g.repository_full_name
        WHERE g.id=$1
        FOR UPDATE OF g`,
      [grantId],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = result.rows[0];
    const authorized =
      row.node_id === nodeId &&
      equalTokenHash(row.node_token_hash, hashToken(nodeToken)) &&
      equalTokenHash(row.token_hash, hashToken(grantToken));
    if (!authorized || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return null;
    }
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) {
      await client.query("ROLLBACK");
      throw new Error("source grant is already being consumed");
    }
    await client.query("UPDATE source_grants SET lease_until=now()+interval '2 minutes' WHERE id=$1", [grantId]);
    await client.query("COMMIT");
    return {
      repositoryFullName: row.repository_full_name,
      sourceCommitSha: row.source_commit_sha,
      installationId: row.installation_id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function clearGrantLease(pool: Pool, grantId: string): Promise<void> {
  await pool.query("UPDATE source_grants SET lease_until=NULL WHERE id=$1 AND consumed_at IS NULL", [grantId]);
}

export function registerPrivateSourceRoutes(app: FastifyInstance, pool: Pool, requireControl: RequireControl): void {
  const ready = ensurePrivateSourceSchema(pool);

  app.put<{ Body: { repository?: string; installationId?: string | number } }>(
    "/v0/github/repositories",
    { preHandler: requireControl },
    async (request, reply) => {
      await ready;
      try {
        if (!request.body?.repository) throw new Error("repository is required");
        const repository = canonicalGitHubRepository(request.body.repository);
        const installationId = normalizeInstallationId(request.body.installationId);
        const result = await pool.query(
          `INSERT INTO github_repository_installations(repository_full_name,installation_id,updated_at)
           VALUES($1,$2,now())
           ON CONFLICT(repository_full_name) DO UPDATE SET installation_id=EXCLUDED.installation_id,updated_at=now()
           RETURNING repository_full_name,installation_id::text AS installation_id,created_at,updated_at`,
          [repository.fullName, installationId],
        );
        return reply.send({ repository: result.rows[0] });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid GitHub repository mapping" });
      }
    },
  );

  app.get("/v0/github/repositories", { preHandler: requireControl }, async () => {
    await ready;
    const result = await pool.query(
      "SELECT repository_full_name,installation_id::text AS installation_id,created_at,updated_at FROM github_repository_installations ORDER BY repository_full_name",
    );
    return { repositories: result.rows };
  });

  app.delete<{ Params: { owner: string; repository: string } }>(
    "/v0/github/repositories/:owner/:repository",
    { preHandler: requireControl },
    async (request, reply) => {
      await ready;
      try {
        const canonical = canonicalGitHubRepository(`https://github.com/${request.params.owner}/${request.params.repository}.git`);
        const result = await pool.query("DELETE FROM github_repository_installations WHERE repository_full_name=$1", [canonical.fullName]);
        return result.rowCount === 1 ? reply.code(204).send() : reply.code(404).send({ error: "repository mapping not found" });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid repository" });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/v0/source-grants/:id/archive", async (request, reply) => {
    await ready;
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: "invalid source grant" });
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    const nodeToken = bearer(request.headers.authorization);
    const grantToken = singleHeader(request.headers["x-rundea-source-grant"]);
    if (!nodeId || !nodeToken || !grantToken) return reply.code(401).send({ error: "source grant credentials are required" });

    let grant;
    try {
      grant = await beginGrantFetch(pool, request.params.id, nodeId, nodeToken, grantToken);
    } catch (error) {
      request.log.warn({ err: error }, "source grant is busy");
      return reply.code(409).send({ error: "source grant is already being consumed" });
    }
    if (!grant) return reply.code(401).send({ error: "invalid or expired source grant" });

    try {
      const archive = await fetchPrivateArchive(grant.installationId, grant.repositoryFullName, grant.sourceCommitSha);
      const consumed = await pool.query(
        "UPDATE source_grants SET consumed_at=now(),lease_until=NULL WHERE id=$1 AND node_id=$2 AND consumed_at IS NULL RETURNING id",
        [request.params.id, nodeId],
      );
      if (consumed.rowCount !== 1) throw new Error("source grant could not be consumed atomically");
      reply.header("content-type", "application/gzip");
      reply.header("cache-control", "no-store");
      reply.header("x-rundea-source-sha", grant.sourceCommitSha);
      return reply.send(archive);
    } catch (error) {
      await clearGrantLease(pool, request.params.id).catch(() => undefined);
      request.log.error({ err: error }, "private GitHub source fetch failed");
      return reply.code(502).send({ error: "private GitHub source could not be fetched" });
    }
  });
}
