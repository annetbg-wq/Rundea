import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { equalTokenHash, hashToken } from "@rundea/crypto";
import { canonicalGitHubRepository } from "./github-autodeploy";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

type SourceFetch = {
  repositoryFullName: string;
  sourceCommitSha: string;
  installationId: string;
};

type SourceFetchDecision =
  | { kind: "public" }
  | { kind: "denied"; reason: "unauthorized" | "inactive" | "consumed" | "expired" | "busy" | "not-exact" }
  | { kind: "private"; fetch: SourceFetch };

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

async function beginSourceFetch(pool: Pool, deploymentId: string, nodeId: string, nodeToken: string): Promise<SourceFetchDecision> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deployment = await client.query(
      `SELECT d.id,d.node_id,d.source_repository,d.source_ref,d.status,n.token_hash AS node_token_hash
         FROM deployments d JOIN nodes n ON n.id=d.node_id
        WHERE d.id=$1
        FOR UPDATE OF d`,
      [deploymentId],
    );
    if (deployment.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "unauthorized" };
    }
    const row = deployment.rows[0];
    if (row.node_id !== nodeId || !equalTokenHash(row.node_token_hash, hashToken(nodeToken))) {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "unauthorized" };
    }
    if (row.status !== "BUILDING") {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "inactive" };
    }

    const repository = canonicalGitHubRepository(row.source_repository);
    const mapping = await client.query(
      "SELECT installation_id::text AS installation_id FROM github_repository_installations WHERE repository_full_name=$1",
      [repository.fullName],
    );
    if (mapping.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { kind: "public" };
    }
    const sourceCommitSha = String(row.source_ref).toLowerCase();
    if (!fullCommitPattern.test(sourceCommitSha)) {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "not-exact" };
    }

    await client.query(
      `INSERT INTO source_fetches(deployment_id,node_id,repository_full_name,source_commit_sha,expires_at)
       VALUES($1,$2,$3,$4,now()+interval '5 minutes')
       ON CONFLICT(deployment_id) DO NOTHING`,
      [deploymentId, nodeId, repository.fullName, sourceCommitSha],
    );
    const fetchRow = await client.query(
      `SELECT expires_at,lease_until,consumed_at
         FROM source_fetches WHERE deployment_id=$1 FOR UPDATE`,
      [deploymentId],
    );
    const state = fetchRow.rows[0];
    if (state.consumed_at) {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "consumed" };
    }
    if (new Date(state.expires_at).getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "expired" };
    }
    if (state.lease_until && new Date(state.lease_until).getTime() > Date.now()) {
      await client.query("ROLLBACK");
      return { kind: "denied", reason: "busy" };
    }
    await client.query("UPDATE source_fetches SET lease_until=now()+interval '2 minutes' WHERE deployment_id=$1", [deploymentId]);
    await client.query("COMMIT");
    return {
      kind: "private",
      fetch: {
        repositoryFullName: repository.fullName,
        sourceCommitSha,
        installationId: mapping.rows[0].installation_id,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function clearFetchLease(pool: Pool, deploymentId: string): Promise<void> {
  await pool.query("UPDATE source_fetches SET lease_until=NULL WHERE deployment_id=$1 AND consumed_at IS NULL", [deploymentId]);
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

  app.get<{ Params: { id: string } }>("/v0/deployments/:id/source-archive", async (request, reply) => {
    await ready;
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: "invalid deployment id" });
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    const nodeToken = bearer(request.headers.authorization);
    if (!nodeId || !nodeToken) return reply.code(401).send({ error: "node credentials are required" });

    let decision: SourceFetchDecision;
    try {
      decision = await beginSourceFetch(pool, request.params.id, nodeId, nodeToken);
    } catch (error) {
      request.log.error({ err: error }, "private source authorization failed");
      return reply.code(500).send({ error: "private source authorization failed" });
    }
    if (decision.kind === "public") return reply.code(404).send({ brokered: false });
    if (decision.kind === "denied") {
      const status = decision.reason === "busy" ? 409 : decision.reason === "consumed" || decision.reason === "expired" ? 410 : decision.reason === "not-exact" || decision.reason === "inactive" ? 409 : 401;
      return reply.code(status).send({ error: `private source fetch denied: ${decision.reason}` });
    }

    try {
      const archive = await fetchPrivateArchive(
        decision.fetch.installationId,
        decision.fetch.repositoryFullName,
        decision.fetch.sourceCommitSha,
      );
      const consumed = await pool.query(
        "UPDATE source_fetches SET consumed_at=now(),lease_until=NULL WHERE deployment_id=$1 AND node_id=$2 AND consumed_at IS NULL RETURNING deployment_id",
        [request.params.id, nodeId],
      );
      if (consumed.rowCount !== 1) throw new Error("private source fetch could not be consumed atomically");
      reply.header("content-type", "application/gzip");
      reply.header("cache-control", "no-store");
      reply.header("x-rundea-source-sha", decision.fetch.sourceCommitSha);
      return reply.send(archive);
    } catch (error) {
      await clearFetchLease(pool, request.params.id).catch(() => undefined);
      request.log.error({ err: error }, "private GitHub source fetch failed");
      return reply.code(502).send({ error: "private GitHub source could not be fetched" });
    }
  });
}
