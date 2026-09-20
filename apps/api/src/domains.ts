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
  status: string;
  host_port: number | null;
};

async function desiredDomainRows(pool: Pool, nodeId: string): Promise<DesiredDomainRow[]> {
  const result = await pool.query(
    `SELECT d.id,d.hostname,d.service_name,d.status,active.host_port
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

async function failReconciliationBeforeSend(pool: Pool, nodeId: string, reconciliationId: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE service_domains
          SET status=CASE WHEN status='DELETING' THEN 'DELETING' ELSE 'PENDING' END,
              reconciliation_id=NULL,last_error=$3,verified_at=NULL,updated_at=now()
        WHERE node_id=$1 AND reconciliation_id=$2`,
      [nodeId, reconciliationId, reason],
    );
    await client.query(
      "UPDATE node_ingress_reconciliations SET status='FAILED',error=$3,completed_at=now() WHERE id=$2 AND node_id=$1 AND status='RUNNING'",
      [nodeId, reconciliationId, reason],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileNodeIngress(pool: Pool, sockets: Map<string, NodeCommandSocket>, nodeId: string): Promise<boolean> {
  const rows = await desiredDomainRows(pool, nodeId);
  const routable = rows.filter((row) => row.status !== "DELETING" && Number.isInteger(row.host_port));
  const deleting = rows.filter((row) => row.status === "DELETING");
  const reconciliationId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize ingress reconciliation per node so concurrent domain changes
    // cannot both create a RUNNING reconciliation.
    const nodeLock = await client.query(
      "SELECT id FROM nodes WHERE id=$1 FOR UPDATE",
      [nodeId],
    );
    if (nodeLock.rowCount !== 1) throw new Error("node is unavailable");
    await client.query(
      `UPDATE node_ingress_reconciliations
          SET status='FAILED',error='superseded by newer ingress reconciliation',completed_at=now()
        WHERE node_id=$1 AND status='RUNNING'`,
      [nodeId],
    );
    await client.query(
      "INSERT INTO node_ingress_reconciliations(id,node_id,status) VALUES($1,$2,'RUNNING')",
      [reconciliationId, nodeId],
    );
    await client.query(
      `UPDATE service_domains
          SET status='PENDING',reconciliation_id=NULL,
              last_error='service has no READY deployment on this node',verified_at=NULL,updated_at=now()
        WHERE node_id=$1 AND status<>'DELETING'`,
      [nodeId],
    );
    if (routable.length > 0) {
      await client.query(
        `UPDATE service_domains
            SET status='CONFIGURING',reconciliation_id=$2,last_error=NULL,verified_at=NULL,updated_at=now()
          WHERE node_id=$1 AND id = ANY($3::uuid[])`,
        [nodeId, reconciliationId, routable.map((row) => row.id)],
      );
    }
    if (deleting.length > 0) {
      await client.query(
        `UPDATE service_domains
            SET reconciliation_id=$2,last_error=NULL,verified_at=NULL,updated_at=now()
          WHERE node_id=$1 AND id = ANY($3::uuid[]) AND status='DELETING'`,
        [nodeId, reconciliationId, deleting.map((row) => row.id)],
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
    await failReconciliationBeforeSend(pool, nodeId, reconciliationId, "node agent is not connected");
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
    await failReconciliationBeforeSend(pool, nodeId, reconciliationId, "ingress command could not be sent");
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
    "SELECT DISTINCT node_id FROM service_domains WHERE service_name=$1 AND node_id<>$2 AND status<>'DELETING'",
    [serviceName, readyNodeId],
  );
  await pool.query(
    `UPDATE service_domains
        SET node_id=$2,status='PENDING',reconciliation_id=NULL,last_error='service deployment moved to another node',verified_at=NULL,updated_at=now()
      WHERE service_name=$1 AND node_id<>$2 AND status<>'DELETING'`,
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
  if (event.error && event.error.length > 500) throw new Error("ingress reconciliation error is too long");
  const reconciliation = await pool.query(
    "SELECT status FROM node_ingress_reconciliations WHERE id=$1 AND node_id=$2",
    [event.reconciliationId, nodeId],
  );
  if (reconciliation.rowCount !== 1 || reconciliation.rows[0].status !== "RUNNING") throw new Error("stale or unknown ingress reconciliation");

  const known = await pool.query(
    "SELECT hostname FROM service_domains WHERE node_id=$1 AND reconciliation_id=$2 AND status='CONFIGURING' ORDER BY hostname",
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
  const routesPassed = event.routes.every((route) => route.ok);
  if (!event.applied && event.ok) throw new Error("unapplied ingress result cannot be successful");
  if (!event.applied && !event.error) throw new Error("unapplied ingress result must contain a global error");
  if (event.applied && event.ok !== routesPassed) throw new Error("ingress aggregate result does not match route verification");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const route of event.routes) {
      const active = event.applied && route.ok;
      const updated = await client.query(
        `UPDATE service_domains
            SET status=$4,reconciliation_id=NULL,last_error=$5,
                verified_at=CASE WHEN $4='ACTIVE' THEN now() ELSE NULL END,updated_at=now()
          WHERE node_id=$1 AND reconciliation_id=$2 AND hostname=$3 AND status='CONFIGURING'`,
        [nodeId, event.reconciliationId, route.hostname, active ? "ACTIVE" : "FAILED", route.error ?? event.error ?? null],
      );
      if (updated.rowCount !== 1) throw new Error("ingress route result lost reconciliation ownership");
    }
    if (event.applied) {
      await client.query(
        "DELETE FROM service_domains WHERE node_id=$1 AND reconciliation_id=$2 AND status='DELETING'",
        [nodeId, event.reconciliationId],
      );
    } else {
      await client.query(
        `UPDATE service_domains
            SET reconciliation_id=NULL,last_error=$3,verified_at=NULL,updated_at=now()
          WHERE node_id=$1 AND reconciliation_id=$2 AND status='DELETING'`,
        [nodeId, event.reconciliationId, event.error ?? "ingress reconciliation was not applied"],
      );
    }
    const reconciliationError = event.error ?? (event.ok ? null : "one or more ingress routes failed verification");
    await client.query(
      `UPDATE node_ingress_reconciliations
          SET status=$3,error=$4,completed_at=now()
        WHERE id=$1 AND node_id=$2 AND status='RUNNING'`,
      [event.reconciliationId, nodeId, event.applied && event.ok ? "SUCCEEDED" : "FAILED", reconciliationError],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failRunningIngressForNode(pool: Pool, nodeId: string): Promise<void> {
  const reason = "agent disconnected during ingress reconciliation";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const running = await client.query(
      "SELECT id FROM node_ingress_reconciliations WHERE node_id=$1 AND status='RUNNING' FOR UPDATE",
      [nodeId],
    );
    for (const row of running.rows) {
      await client.query(
        `UPDATE service_domains
            SET status=CASE WHEN status='DELETING' THEN 'DELETING' ELSE 'PENDING' END,
                reconciliation_id=NULL,last_error=$3,verified_at=NULL,updated_at=now()
          WHERE node_id=$1 AND reconciliation_id=$2`,
        [nodeId, row.id, reason],
      );
      await client.query(
        "UPDATE node_ingress_reconciliations SET status='FAILED',error=$3,completed_at=now() WHERE id=$2 AND node_id=$1",
        [nodeId, row.id, reason],
      );
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
      const domain = await pool.query("SELECT node_id,status FROM service_domains WHERE id=$1", [request.params.id]);
      if (domain.rowCount !== 1) return reply.code(404).send({ error: "domain not found" });
      const sent = await reconcileNodeIngress(pool, sockets, domain.rows[0].node_id);
      return reply.code(sent ? 202 : 409).send({ status: sent ? domain.rows[0].status === "DELETING" ? "DELETING" : "CONFIGURING" : domain.rows[0].status });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v0/domains/:id",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!validUuid(request.params.id)) return reply.code(400).send({ error: "invalid domain id" });
      const result = await pool.query(
        `UPDATE service_domains
            SET status='DELETING',reconciliation_id=NULL,last_error=NULL,verified_at=NULL,updated_at=now()
          WHERE id=$1 RETURNING node_id`,
        [request.params.id],
      );
      if (result.rowCount !== 1) return reply.code(404).send({ error: "domain not found" });
      const sent = await reconcileNodeIngress(pool, sockets, result.rows[0].node_id);
      return reply.code(202).send({ status: "DELETING", agentConnected: sent });
    },
  );
}
