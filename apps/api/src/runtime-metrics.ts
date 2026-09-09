import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentEvent } from "@rundea/contracts";
import { executeRuntimeMetricsReadOperation, RuntimeMetricOperationError } from "./runtime-metric-operations";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type RuntimeMetricEvent = Extract<AgentEvent, { type: "metric" }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  const eligible = await pool.query(
    "SELECT 1 FROM deployments WHERE id=$1 AND node_id=$2 AND status IN ('DEPLOYING','HEALTHCHECK','READY')",
    [event.deploymentId, nodeId],
  );
  if (eligible.rowCount !== 1) throw new Error("runtime metric rejected for authenticated node or inactive deployment");

  await pool.query(
    `INSERT INTO runtime_metrics(
       deployment_id,node_id,sampled_at,cpu_percent,memory_usage_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes
     )
     SELECT $1,$2,now(),$3,$4,$5,$6,$7
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_metrics
         WHERE deployment_id=$1 AND sampled_at > now() - interval '5 seconds'
      )`,
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
  await maybeCleanup(pool).catch(() => undefined);
}

export function registerRuntimeMetricRoutes(app: FastifyInstance, pool: Pool, requireControl: RequireControl): void {
  app.get<{ Params: { id: string }; Querystring: { minutes?: string } }>(
    "/v0/deployments/:id/metrics",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        return await executeRuntimeMetricsReadOperation(pool, {
          deploymentId: request.params.id,
          minutes: request.query?.minutes,
        });
      } catch (error) {
        if (error instanceof RuntimeMetricOperationError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
