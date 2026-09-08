import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentEvent } from "@rundea/contracts";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type RuntimeMetricEvent = Extract<AgentEvent, { type: "metric" }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const retentionMs = 48 * 60 * 60 * 1000;
let lastCleanupAt = 0;

function finiteNumber(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${name} is outside the accepted runtime metric range`);
  }
  return value;
}

function safeCounter(value: unknown, name: string): number {
  const parsed = finiteNumber(value, name, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

export function validateRuntimeMetricEvent(event: RuntimeMetricEvent): RuntimeMetricEvent {
  if (!uuidPattern.test(event.deploymentId)) throw new Error("runtime metric deploymentId is invalid");
  const at = new Date(event.at);
  if (!Number.isFinite(at.getTime())) throw new Error("runtime metric timestamp is invalid");
  return {
    type: "metric",
    deploymentId: event.deploymentId,
    cpuPercent: finiteNumber(event.cpuPercent, "cpuPercent", 100000),
    memoryUsageBytes: safeCounter(event.memoryUsageBytes, "memoryUsageBytes"),
    memoryLimitBytes: safeCounter(event.memoryLimitBytes, "memoryLimitBytes"),
    networkRxBytes: safeCounter(event.networkRxBytes, "networkRxBytes"),
    networkTxBytes: safeCounter(event.networkTxBytes, "networkTxBytes"),
    at: at.toISOString(),
  };
}

async function maybeCleanup(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < 15 * 60 * 1000) return;
  lastCleanupAt = now;
  await pool.query("DELETE FROM runtime_metrics WHERE sampled_at < now() - interval '48 hours'");
}

export async function recordRuntimeMetric(pool: Pool, nodeId: string, rawEvent: RuntimeMetricEvent): Promise<void> {
  const event = validateRuntimeMetricEvent(rawEvent);
  const inserted = await pool.query(
    `INSERT INTO runtime_metrics(
       deployment_id,node_id,sampled_at,cpu_percent,memory_usage_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes
     )
     SELECT id,$2,now(),$3,$4,$5,$6,$7
       FROM deployments
      WHERE id=$1 AND node_id=$2 AND status IN ('DEPLOYING','HEALTHCHECK','READY')`,
    [
      event.deploymentId,
      nodeId,
      event.cpuPercent,
      event.memoryUsageBytes,
      event.memoryLimitBytes,
      event.networkRxBytes,
      event.networkTxBytes,
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("runtime metric rejected for authenticated node or inactive deployment");
  await maybeCleanup(pool).catch(() => undefined);
}

function parseMinutes(value: unknown): number {
  const minutes = value === undefined ? 60 : Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 2880) {
    throw new Error("minutes must be an integer between 5 and 2880");
  }
  return minutes;
}

function metricPoint(row: Record<string, unknown>, sampleCount: number) {
  return {
    at: new Date(String(row.sampled_at)).toISOString(),
    cpuPercent: Number(row.cpu_percent),
    memoryUsageBytes: Math.round(Number(row.memory_usage_bytes)),
    memoryLimitBytes: Number(row.memory_limit_bytes),
    networkRxBytes: Number(row.network_rx_bytes),
    networkTxBytes: Number(row.network_tx_bytes),
    sampleCount,
  };
}

export function registerRuntimeMetricRoutes(app: FastifyInstance, pool: Pool, requireControl: RequireControl): void {
  app.get<{ Params: { id: string }; Querystring: { minutes?: string } }>(
    "/v0/deployments/:id/metrics",
    { preHandler: requireControl },
    async (request, reply) => {
      if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: "invalid deployment id" });
      let minutes: number;
      try {
        minutes = parseMinutes(request.query?.minutes);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid metrics window" });
      }

      const deployment = await pool.query("SELECT id,node_id,status FROM deployments WHERE id=$1", [request.params.id]);
      if (deployment.rowCount !== 1) return reply.code(404).send({ error: "deployment not found" });

      const targetPoints = 240;
      const rawBucket = Math.ceil((minutes * 60) / targetPoints);
      const bucketSeconds = Math.max(15, Math.ceil(rawBucket / 15) * 15);
      const [seriesResult, latestResult] = await Promise.all([
        pool.query(
          `SELECT
             date_bin(make_interval(secs => $2::int), sampled_at, timestamptz '1970-01-01 00:00:00+00') AS sampled_at,
             avg(cpu_percent)::double precision AS cpu_percent,
             avg(memory_usage_bytes)::double precision AS memory_usage_bytes,
             max(memory_limit_bytes) AS memory_limit_bytes,
             max(network_rx_bytes) AS network_rx_bytes,
             max(network_tx_bytes) AS network_tx_bytes,
             count(*)::int AS sample_count
           FROM runtime_metrics
          WHERE deployment_id=$1
            AND sampled_at >= now() - make_interval(mins => $3::int)
          GROUP BY 1
          ORDER BY 1 ASC`,
          [request.params.id, bucketSeconds, minutes],
        ),
        pool.query(
          `SELECT sampled_at,cpu_percent,memory_usage_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes
             FROM runtime_metrics
            WHERE deployment_id=$1
            ORDER BY sampled_at DESC,id DESC
            LIMIT 1`,
          [request.params.id],
        ),
      ]);

      const points = seriesResult.rows.map((row) => metricPoint(row, Number(row.sample_count)));
      const latest = latestResult.rowCount === 1 ? metricPoint(latestResult.rows[0], 1) : null;
      return {
        deploymentId: request.params.id,
        nodeId: deployment.rows[0].node_id,
        deploymentStatus: deployment.rows[0].status,
        minutes,
        bucketSeconds,
        retentionHours: retentionMs / (60 * 60 * 1000),
        latest,
        points,
      };
    },
  );
}
