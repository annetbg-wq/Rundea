import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createOpaqueToken, equalTokenHash, hashToken } from "@rundea/crypto";

const ticketTtlMs = 2 * 60 * 1000;

export type RegistryPullConfig = Readonly<{
  registryHost: string | null;
  username: string | null;
  password: string | null;
}>;

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function registryHostFromPrefix(prefix: string | undefined): string | null {
  const raw = prefix?.trim();
  if (!raw) return null;
  if (raw.includes("://") || raw.includes("@") || /[\s\r\n]/.test(raw)) {
    throw new Error("RUNDEA_BUILD_REGISTRY_PREFIX is invalid");
  }
  const host = raw.replace(/^\/+|\/+$/g, "").split("/")[0]?.toLowerCase() ?? "";
  if (!host || host.length > 255 || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) {
    throw new Error("RUNDEA_BUILD_REGISTRY_PREFIX registry host is invalid");
  }
  return host;
}

export function resolveRegistryPullConfig(env: NodeJS.ProcessEnv = process.env): RegistryPullConfig {
  const username = env.RUNDEA_REGISTRY_PULL_USERNAME?.trim() || null;
  const password = env.RUNDEA_REGISTRY_PULL_PASSWORD ?? null;
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("RUNDEA_REGISTRY_PULL_USERNAME and RUNDEA_REGISTRY_PULL_PASSWORD must be configured together");
  }
  if (username && (username.length > 512 || /[\r\n\0]/.test(username))) {
    throw new Error("RUNDEA_REGISTRY_PULL_USERNAME is invalid");
  }
  if (password && (password.length > 4096 || /[\r\n\0]/.test(password))) {
    throw new Error("RUNDEA_REGISTRY_PULL_PASSWORD is invalid");
  }
  return {
    registryHost: registryHostFromPrefix(env.RUNDEA_BUILD_REGISTRY_PREFIX),
    username,
    password,
  };
}

export function registryHostFromImageRef(imageRef: string): string {
  const at = imageRef.lastIndexOf("@");
  const name = at >= 0 ? imageRef.slice(0, at) : imageRef;
  const slash = name.indexOf("/");
  const host = slash > 0 ? name.slice(0, slash).toLowerCase() : "";
  if (!host || host.length > 255 || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) {
    throw new Error("registry image reference has an invalid registry host");
  }
  return host;
}

export async function issueRegistryPullTicket(
  pool: Pool,
  deploymentId: string,
  nodeId: string,
  imageRef: string,
  config: RegistryPullConfig = resolveRegistryPullConfig(),
): Promise<string | null> {
  if (!config.username || config.password === null) return null;
  const registryHost = registryHostFromImageRef(imageRef);
  if (!config.registryHost || registryHost !== config.registryHost) {
    throw new Error("prebuilt artifact registry does not match configured pull credential host");
  }

  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + ticketTtlMs);
  await pool.query(
    `INSERT INTO registry_pull_tickets(
       deployment_id,node_id,token_hash,registry_host,expires_at,consumed_at,created_at
     ) VALUES($1,$2,$3,$4,$5,NULL,now())
     ON CONFLICT(deployment_id) DO UPDATE SET
       node_id=EXCLUDED.node_id,
       token_hash=EXCLUDED.token_hash,
       registry_host=EXCLUDED.registry_host,
       expires_at=EXCLUDED.expires_at,
       consumed_at=NULL,
       created_at=now()`,
    [deploymentId, nodeId, hashToken(token), registryHost, expiresAt],
  );
  return token;
}

async function claimRegistryPullTicket(
  pool: Pool,
  deploymentId: string,
  nodeId: string,
  token: string,
  config: RegistryPullConfig,
): Promise<{ registryHost: string; username: string; password: string } | null> {
  if (!config.username || config.password === null || !config.registryHost) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT node_id,token_hash,registry_host,expires_at,consumed_at
         FROM registry_pull_tickets
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
      row.registry_host === config.registryHost &&
      !row.consumed_at &&
      new Date(row.expires_at).getTime() > Date.now() &&
      equalTokenHash(row.token_hash, hashToken(token));
    if (!valid) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("UPDATE registry_pull_tickets SET consumed_at=now() WHERE deployment_id=$1", [deploymentId]);
    await client.query("COMMIT");
    return {
      registryHost: row.registry_host,
      username: config.username,
      password: config.password,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function registerRegistryPullBrokerRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: RegistryPullConfig = resolveRegistryPullConfig(),
): void {
  app.get<{ Params: { deploymentId: string } }>("/v0/registry-pull-credentials/:deploymentId", async (request, reply) => {
    const token = bearer(request.headers.authorization);
    const nodeId = singleHeader(request.headers["x-rundea-node-id"]);
    if (!token || !nodeId) return reply.code(401).send({ error: "registry pull authorization failed" });

    const credentials = await claimRegistryPullTicket(pool, request.params.deploymentId, nodeId, token, config);
    if (!credentials) return reply.code(401).send({ error: "registry pull authorization failed" });

    return reply
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send({
        server: credentials.registryHost,
        username: credentials.username,
        password: credentials.password,
      });
  });
}
