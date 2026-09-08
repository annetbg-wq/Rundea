import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentCommand, AgentEvent, NodeProbeResult } from "@rundea/contracts";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type NodeCommandSocket = { send(payload: string): void };

const profile = "sendina-egress-v1" as const;
const expectedProbes = new Map([
  ["smtp-tls", { host: "smtp.gmail.com", port: 465 }],
  ["smtp-starttls", { host: "smtp.gmail.com", port: 587 }],
  ["imap-tls", { host: "imap.gmail.com", port: 993 }],
]);

export function validateQualificationEvent(event: Extract<AgentEvent, { type: "qualification" }>): void {
  if (event.profile !== profile) throw new Error("unexpected qualification profile");
  if (!Array.isArray(event.probes) || event.probes.length !== expectedProbes.size) throw new Error("qualification must contain exactly three probes");
  const seen = new Set<string>();
  for (const probe of event.probes) {
    if (seen.has(probe.name)) throw new Error("qualification contains a duplicate probe");
    seen.add(probe.name);
    const expected = expectedProbes.get(probe.name);
    if (!expected || probe.host !== expected.host || probe.port !== expected.port) throw new Error("qualification contains an unexpected probe target");
    if (!Number.isFinite(probe.latencyMs ?? 0) || (probe.latencyMs ?? 0) < 0) throw new Error("qualification contains an invalid latency");
    if (probe.error && probe.error.length > 500) throw new Error("qualification probe error is too long");
  }
  const probesPassed = event.probes.every((probe) => probe.ok);
  if (event.ok !== probesPassed) throw new Error("qualification aggregate result does not match probes");
}

export function registerNodeQualificationRoutes(
  app: FastifyInstance,
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  requireControl: ControlPreHandler,
): void {
  app.post<{ Params: { id: string } }>(
    "/v0/nodes/:id/qualifications",
    { preHandler: requireControl },
    async (request, reply) => {
      const nodeId = request.params.id;
      const socket = sockets.get(nodeId);
      if (!socket) return reply.code(409).send({ error: "node is not connected" });

      const node = await pool.query("SELECT 1 FROM nodes WHERE id=$1", [nodeId]).catch(() => null);
      if (!node || node.rowCount !== 1) return reply.code(404).send({ error: "node not found" });
      const running = await pool.query("SELECT id FROM node_qualifications WHERE node_id=$1 AND status='RUNNING' LIMIT 1", [nodeId]);
      if ((running.rowCount ?? 0) > 0) return reply.code(409).send({ error: "qualification already running", qualificationId: running.rows[0].id });

      const qualificationId = randomUUID();
      await pool.query(
        "INSERT INTO node_qualifications(id,node_id,profile,status) VALUES($1,$2,$3,'RUNNING')",
        [qualificationId, nodeId, profile],
      );
      const command: AgentCommand = { type: "qualify", qualificationId, profile };
      try {
        socket.send(JSON.stringify(command));
      } catch (error) {
        await pool.query("UPDATE node_qualifications SET status='FAILED', completed_at=now() WHERE id=$1", [qualificationId]);
        request.log.error(error, "qualification command could not be sent");
        return reply.code(502).send({ error: "qualification command could not be sent" });
      }
      return reply.code(202).send({ id: qualificationId, nodeId, profile, status: "RUNNING" });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v0/nodes/:id/qualifications",
    { preHandler: requireControl },
    async (request) => {
      const result = await pool.query(
        `SELECT q.id,q.node_id,q.profile,q.status,q.started_at,q.completed_at,q.created_at,
                COALESCE(json_agg(json_build_object(
                  'name',p.name,'host',p.host,'port',p.port,'ok',p.ok,
                  'latencyMs',p.latency_ms,'error',p.error,'checkedAt',p.checked_at
                ) ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL),'[]'::json) AS probes
           FROM node_qualifications q
           LEFT JOIN node_probe_results p ON p.qualification_id=q.id
          WHERE q.node_id=$1
          GROUP BY q.id
          ORDER BY q.created_at DESC
          LIMIT 20`,
        [request.params.id],
      );
      return { qualifications: result.rows };
    },
  );
}

export async function recordNodeQualification(
  pool: Pool,
  nodeId: string,
  event: Extract<AgentEvent, { type: "qualification" }>,
): Promise<void> {
  validateQualificationEvent(event);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT status,profile FROM node_qualifications WHERE id=$1 AND node_id=$2 FOR UPDATE",
      [event.qualificationId, nodeId],
    );
    if (current.rowCount !== 1) throw new Error("qualification not found for node");
    if (current.rows[0].status !== "RUNNING") throw new Error("qualification is not running");
    if (current.rows[0].profile !== event.profile) throw new Error("qualification profile mismatch");

    await client.query(
      "UPDATE node_qualifications SET status=$2, completed_at=now() WHERE id=$1",
      [event.qualificationId, event.ok ? "PASSED" : "FAILED"],
    );
    await client.query("DELETE FROM node_probe_results WHERE qualification_id=$1", [event.qualificationId]);
    for (const probe of event.probes) {
      await insertProbe(client, event.qualificationId, probe);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertProbe(client: { query(text: string, values?: unknown[]): Promise<unknown> }, qualificationId: string, probe: NodeProbeResult): Promise<void> {
  await client.query(
    `INSERT INTO node_probe_results(qualification_id,name,host,port,ok,latency_ms,error)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [qualificationId, probe.name, probe.host, probe.port, probe.ok, probe.latencyMs ?? null, probe.error ?? null],
  );
}

export async function failRunningQualificationsForNode(pool: Pool, nodeId: string): Promise<void> {
  await pool.query(
    "UPDATE node_qualifications SET status='FAILED', completed_at=now() WHERE node_id=$1 AND status='RUNNING'",
    [nodeId],
  );
}
