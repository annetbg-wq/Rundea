import type { Pool } from "pg";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NodeQualificationOperationError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "NodeQualificationOperationError";
  }
}

export async function executeNodeQualificationsReadOperation(pool: Pool, nodeId: string) {
  if (!uuidPattern.test(nodeId)) throw new NodeQualificationOperationError(400, "invalid node id");
  const node = await pool.query("SELECT 1 FROM nodes WHERE id=$1", [nodeId]);
  if (node.rowCount !== 1) throw new NodeQualificationOperationError(404, "node not found");

  const result = await pool.query(
    `SELECT q.id,q.node_id,q.profile,q.status,q.failure_reason,q.started_at,q.completed_at,q.created_at,
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
    [nodeId],
  );
  return { qualifications: result.rows };
}
