import type { Pool } from "pg";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const retentionHours = 48;

export class RuntimeMetricOperationError extends Error {
  constructor(
    public readonly statusCode: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeMetricOperationError";
  }
}

export type RuntimeMetricsReadInput = Readonly<{
  deploymentId: string;
  minutes?: unknown;
}>;

function parseMinutes(value: unknown): number {
  const minutes = value === undefined ? 60 : Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 2880) {
    throw new RuntimeMetricOperationError(400, "minutes must be an integer between 5 and 2880");
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

export async function executeRuntimeMetricsReadOperation(pool: Pool, input: RuntimeMetricsReadInput) {
  if (!uuidPattern.test(input.deploymentId)) {
    throw new RuntimeMetricOperationError(400, "invalid deployment id");
  }
  const minutes = parseMinutes(input.minutes);

  const deployment = await pool.query("SELECT id,node_id,status FROM deployments WHERE id=$1", [input.deploymentId]);
  if (deployment.rowCount !== 1) throw new RuntimeMetricOperationError(404, "deployment not found");

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
      [input.deploymentId, bucketSeconds, minutes],
    ),
    pool.query(
      `SELECT sampled_at,cpu_percent,memory_usage_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes
         FROM runtime_metrics
        WHERE deployment_id=$1
        ORDER BY sampled_at DESC,id DESC
        LIMIT 1`,
      [input.deploymentId],
    ),
  ]);

  const points = seriesResult.rows.map((row) => metricPoint(row, Number(row.sample_count)));
  const latest = latestResult.rowCount === 1 ? metricPoint(latestResult.rows[0], 1) : null;
  return {
    deploymentId: input.deploymentId,
    nodeId: deployment.rows[0].node_id,
    deploymentStatus: deployment.rows[0].status,
    minutes,
    bucketSeconds,
    retentionHours,
    latest,
    points,
  };
}
