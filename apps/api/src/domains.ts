import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentCommand, AgentEvent } from "@rundea/contracts";
import type { NodeCommandSocket } from "./node-qualification";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const serviceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const hostnamePattern = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeDomainHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function validateDomainHostname(value: string): string {
  const hostname = normalizeDomainHostname(value);
  if (!hostnamePattern.test(hostname) || hostname.includes("*") || hostname === "localhost") throw new Error("invalid public hostname");
  return hostname;
}

function validUuid(value: string): boolean {
  return uuidPattern.test(value);
}

type DesiredDomainRow = {
  id: string;
  hostname: string;
  service_name: string;
  host_port: number | null;
};

async function desiredDomainRows(pool: Pool, nodeId: string): Promise<DesiredDomainRow[]> {
  const result = await pool.query(
    `SELECT d.id,d.hostname,d.service_name,active.host_port
       FROM service_domains d
       LEFT JOIN LATERAL (
         SELECT host_port
           FROM deployments
          WHERE service_name=d.service_name AND node_id=d.node_id AND status='READY'
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
       ) active ON true
      WHERE d.node_id=$1
      ORDER BY d.hostname ASC`,
    [nodeId],
  );
  return result.rows as DesiredDomainRow[];
}

export async function reconcileNodeIngress(pool: Pool, sockets: Map<string, NodeCommandSocket>, nodeId: string): Promise<boolean> {
  const rows = await desiredDomainRows(pool, nodeId);
  const routable = rows.filter((row) => Number.isInteger(row.host_port));
  const reconciliationId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE service_domains
          SET status='PENDING', reconciliation_id=NULL,
              last_error='service has no READY deployment on this node', verified_at=NULL, updated_at=now()
        WHERE node_id=$1`,
      [nodeId],
    );
    if (routable.length > 0) {
      await client.query(
        `UPDATE service_domains
            SET status='CONFIGURING', reconciliation_id=$2, last_error=NULL, verified_at=NULL, updated_at=now()
          WHERE node_id=$1 AND id = ANY($3::uuid[])`,
        [nodeId, reconciliationId, routable.map((row) => row.id)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const socket = sockets.get(nodeId);
  if (!socket) {
    await pool.query(
      `UPDATE service_domains
          SET status='PENDING', reconciliation_id=NULL, last_error='node agent is not connected', updated_at=now()
        WHERE node_id=$1 AND reconciliation_id=$2`,
      [nodeId, reconciliationId],
    );
    return false;
  }

  const command: AgentCommand = {
    type: "reconcileIngress",
    reconciliationId,
    routes: routable.map((row) => ({ hostname: row.hostname, hostPort: row.host_port as number })),
  };
  try {
    socket.send(JSON.stringify(command));
    return true;
  } catch {
    await pool.query(
      `UPDATE service_domains
          SET status='FAILED', reconciliation_id=NULL, last_error='ingress command could not be sent', updated_at=now()
        WHERE node_id=$1 AND reconciliation_id=$2`,
      [nodeId, reconciliationId],
    );
    return false;
  }
}

export async function reconcileServiceDomainsAfterReady(
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  serviceName: string,
  readyNodeId: string,
): Promise<void> {
  const oldNodes = await pool.query(
    "SELECT DISTINCT node_id FROM service_domains WHERE service_name=$1 AND node_id<>$2",
    [serviceName, readyNodeId],
  );
  await pool.query(
    `UPDATE service_domains
        SET node_id=$2,status='PENDING',reconciliation_id=NULL,last_error='service deployment moved to another node',verified_at=NULL,updated_at=now()
      WHERE service_name=$1 AND node_id<>$2`,
    [serviceName, readyNodeId],
  );
  for (const row of oldNodes.rows) {
    await reconcileNodeIngress(pool, sockets, row.node_id);
  }
  await reconcileNodeIngress(pool, sockets, readyNodeId);
}

export async function recordIngressResult(
  pool: Pool,
  nodeId: string,
  event: Extract<AgentEvent, { type: "ingress" }>,
): Promise<void> {
  if (!validUuid(event.reconciliationId) || !Array.isArray(event.routes) || event.routes.length > 100) throw new Error("invalid ingress result");
  const known = await pool.query(
    "SELECT hostname FROM service_domains WHERE node_id=$1 AND reconciliation_id=$2 ORDER BY hostname",
    [nodeId, event.reconciliationId],
  );
  const expected = new Set<string>(known.rows.map((row) => row.hostname));
  const seen = new Set<string>();
  for (const route of event.routes) {
    const hostname = validateDomainHostname(route.hostname);
    if (!expected.has(hostname)) throw new Error("ingress result contains an unexpected hostname");
    if (seen.has(hostname)) throw new Error("ingress result contains duplicate hostname");
    if (route.error && route.error.length > 500) throw new Error("ingress route error is too long");
    seen.add(hostname);
  }
  if (seen.size !== expected.size) throw new Error("ingress result does not cover current reconciliation set");
  const aggregate = event.routes.every((route) => route.ok);
  if (event.ok !== aggregate) throw new Error("ingress aggregate result does not match routes");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const route of event.routes) {
      const updated = await client.query(
        `UPDATE service_domains
            SET status=$4, reconciliation_id=NULL, last_error=$5,
                verified_at=CASE WHEN $4='ACTIVE' THEN now() ELSE NULL END, updated_at=now()
          WHERE node_id=$1 AND reconciliation_id=$2 AND hostname=$3`,
        [nodeId, event.reconciliationId, route.hostname, route.ok ? "ACTIVE" : "FAILED", route.error ?? null],
      );
      if (updated.rowCount !== 1) throw new Error("ingress route result lost reconciliation ownership");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function registerDomainRoutes(
  app: FastifyInstance,
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  requireControl: ControlPreHandler,
): void {
  app.get("/v0/domains", { preHandler: requireControl }, async () => {
    const result = await pool.query(
      `SELECT id,hostname,service_name,node_id,status,last_error,created_at,updated_at,verified_at
         FROM service_domains ORDER BY created_at DESC`,
    );
    return { domains: result.rows };
  });

  app.post<{ Body: { hostname?: string; serviceName?: string } }>(
    "/v0/domains",
    { preHandler: requireControl },
    async (request, reply) => {
      const serviceName = request.body?.serviceName?.trim() ?? "";
      if (!serviceNamePattern.test(serviceName)) return reply.code(400).send({ error: "invalid service name" });
      let hostname: string;
      try {
        hostname = validateDomainHostname(request.body?.hostname ?? "");
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid hostname" });
      }
      const deployment = await pool.query(
        `SELECT node_id
           FROM deployments
          WHERE service_name=$1 AND status='READY'
          ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        [serviceName],
      );
      if (deployment.rowCount !== 1) return reply.code(409).send({ error: "service needs a READY deployment before a domain can be attached" });
      const nodeId = deployment.rows[0].node_id as string;
      const id = randomUUID();
      try {
        await pool.query(
          "INSERT INTO service_domains(id,hostname,service_name,node_id,status) VALUES($1,$2,$3,$4,'PENDING')",
          [id, hostname, serviceName, nodeId],
        );
      } catch (error) {
        request.log.error(error, "domain could not be created");
        return reply.code(409).send({ error: "hostname is already attached or domain could not be created" });
      }
      await reconcileNodeIngress(pool, sockets, nodeId);
      const created = await pool.query(
        "SELECT id,hostname,service_name,node_id,status,last_error,created_at,updated_at,verified_at FROM service_domains WHERE id=$1",
        [id],
      );
      return reply.code(201).send(created.rows[0]);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v0/domains/:id/reconcile",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid domain id" });
      const domain = await pool.query("SELECT node_id FROM service_domains WHERE id=$1", [request.params.id]);
      if (domain.rowCount !== 1) return reply.code(404).send({ error: "domain not found" });
      const sent = await reconcileNodeIngress(pool, sockets, domain.rows[0].node_id);
      return reply.code(sent ? 202 : 409).send({ status: sent ? "CONFIGURING" : "PENDING" });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v0/domains/:id",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid domain id" });
      const result = await pool.query("DELETE FROM service_domains WHERE id=$1 RETURNING node_id", [request.params.id]);
      if (result.rowCount !== 1) return reply.code(404).send({ error: "domain not found" });
      await reconcileNodeIngress(pool, sockets, result.rows[0].node_id);
      return reply.code(204).send();
    },
  );
}
