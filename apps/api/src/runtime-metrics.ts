import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentEvent, RuntimeHealthStatus } from "@rundea/contracts";
import { equalTokenHash, hashToken, parseMasterKey } from "@rundea/crypto";
import { registerManagedRedisRoutes } from "./managed-redis";
import { executeRuntimeMetricsReadOperation, RuntimeMetricOperationError } from "./runtime-metric-operations";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export type RuntimeMetricEvent = Extract<AgentEvent, { type: "metric" }>;
export type NodeDiskMetricInput = Readonly<{
  diskTotalBytes: number;
  diskAvailableBytes: number;
  at: string;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runtimeHealthStatuses = new Set<RuntimeHealthStatus>(["HEALTHY", "DEGRADED", "DOWN"]);
let lastCleanupAt = 0;

function finiteNumber(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${name} is outside the accepted runtime metric range`);
  }
  return value;
}

function safeCounter(value: unknown, name: string): number {
  const parsed = finiteNumber(value, name, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

export function validateNodeDiskMetric(input: NodeDiskMetricInput): NodeDiskMetricInput {
  const diskTotalBytes = safeCounter(input.diskTotalBytes, "diskTotalBytes");
  const diskAvailableBytes = safeCounter(input.diskAvailableBytes, "diskAvailableBytes");
  if (diskTotalBytes <= 0) throw new Error("diskTotalBytes must be positive");
  if (diskAvailableBytes > diskTotalBytes) throw new Error("diskAvailableBytes cannot exceed diskTotalBytes");
  const at = new Date(input.at);
  if (!Number.isFinite(at.getTime())) throw new Error("node disk metric timestamp is invalid");
  return { diskTotalBytes, diskAvailableBytes, at: at.toISOString() };
}

export function validateRuntimeMetricEvent(event: RuntimeMetricEvent): RuntimeMetricEvent {
  if (!uuidPattern.test(event.deploymentId)) {
    throw new Error("runtime metric deploymentId is invalid");
  }
  const at = new Date(event.at);
  if (!Number.isFinite(at.getTime())) {
    throw new Error("runtime metric timestamp is invalid");
  }
  const base = {
    type: "metric" as const,
    deploymentId: event.deploymentId,
    cpuPercent: finiteNumber(event.cpuPercent, "cpuPercent", 100000),
    memoryUsageBytes: safeCounter(event.memoryUsageBytes, "memoryUsageBytes"),
    memoryLimitBytes: safeCounter(event.memoryLimitBytes, "memoryLimitBytes"),
    networkRxBytes: safeCounter(event.networkRxBytes, "networkRxBytes"),
    networkTxBytes: safeCounter(event.networkTxBytes, "networkTxBytes"),
    at: at.toISOString(),
  };

  if (event.runtimeHealth === undefined) {
    if (event.restartDelta !== undefined || event.uptimeSeconds !== undefined || event.healthError !== undefined) {
      throw new Error("runtime health detail requires runtimeHealth");
    }
    return base;
  }
  if (!runtimeHealthStatuses.has(event.runtimeHealth)) {
    throw new Error("runtimeHealth is invalid");
  }
  const restartDelta = safeCounter(event.restartDelta ?? 0, "restartDelta");
  if (restartDelta > 1) {
    throw new Error("restartDelta must be 0 or 1");
  }
  const uptimeSeconds = safeCounter(event.uptimeSeconds ?? 0, "uptimeSeconds");
  let healthError: string | undefined;
  if (event.healthError !== undefined) {
    if (typeof event.healthError !== "string" || event.healthError.length > 1000 || event.healthError.includes("\0")) {
      throw new Error("healthError is invalid");
    }
    healthError = event.healthError.trim();
  }

  return {
    ...base,
    runtimeHealth: event.runtimeHealth,
    restartDelta,
    uptimeSeconds,
    ...(healthError ? { healthError } : {}),
  };
}

async function maybeCleanup(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < 15 * 60 * 1000) return;
  lastCleanupAt = now;
  await pool.query("DELETE FROM runtime_metrics WHERE sampled_at < now() - interval '48 hours'");
}

export async function recordNodeDiskMetric(pool: Pool, nodeId: string, rawInput: NodeDiskMetricInput): Promise<void> {
  const input = validateNodeDiskMetric(rawInput);
  await pool.query(
    `UPDATE nodes
        SET disk_total_bytes=$2,disk_available_bytes=$3,disk_sampled_at=$4
      WHERE id=$1 AND (disk_sampled_at IS NULL OR disk_sampled_at < $4)`,
    [nodeId, input.diskTotalBytes, input.diskAvailableBytes, input.at],
  );
}

export async function recordRuntimeMetric(pool: Pool, nodeId: string, rawEvent: RuntimeMetricEvent): Promise<void> {
  const event = validateRuntimeMetricEvent(rawEvent);
  const eligible = await pool.query(
    "SELECT status,runtime_health FROM deployments WHERE id=$1 AND node_id=$2 AND status IN ('DEPLOYING','HEALTHCHECK','READY')",
    [event.deploymentId, nodeId],
  );
  if (eligible.rowCount !== 1) {
    throw new Error("runtime metric rejected for authenticated node or inactive deployment");
  }

  await pool.query(
    `INSERT INTO runtime_metrics(deployment_id,node_id,sampled_at,cpu_percent,memory_usage_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes)
     SELECT $1,$2,now(),$3,$4,$5,$6,$7
      WHERE NOT EXISTS (
        SELECT 1 FROM runtime_metrics
         WHERE deployment_id=$1 AND sampled_at > now() - interval '5 seconds'
      )`,
    [event.deploymentId, nodeId, event.cpuPercent, event.memoryUsageBytes, event.memoryLimitBytes, event.networkRxBytes, event.networkTxBytes],
  );

  if (event.runtimeHealth !== undefined) {
    const update = await pool.query(
      `UPDATE deployments
          SET runtime_health=$3,
              runtime_health_checked_at=$4,
              runtime_restart_count=runtime_restart_count+$5,
              runtime_uptime_seconds=$6,
              runtime_health_error=$7
        WHERE id=$1 AND node_id=$2 AND status='READY'
          AND (runtime_health_checked_at IS NULL OR runtime_health_checked_at < $4)
      RETURNING runtime_health`,
      [event.deploymentId, nodeId, event.runtimeHealth, event.at, event.restartDelta ?? 0, event.uptimeSeconds ?? 0, event.healthError ?? null],
    );
    if (update.rowCount === 1 && eligible.rows[0]?.runtime_health !== event.runtimeHealth) {
      const suffix = event.healthError ? `: ${event.healthError.slice(0, 800)}` : "";
      await pool.query(
        "INSERT INTO deployment_events(deployment_id,kind,stream,message,created_at) VALUES($1,'LOG','system',$2,$3)",
        [event.deploymentId, `runtime-health ${event.runtimeHealth}${suffix}`, event.at],
      );
    }
  }

  await maybeCleanup(pool).catch(() => undefined);
}

export function registerRuntimeMetricRoutes(app: FastifyInstance, pool: Pool, requireControl: RequireControl): void {
  const masterKeyEncoded = process.env.RUNDEA_MASTER_KEY;
  if (!masterKeyEncoded) throw new Error("RUNDEA_MASTER_KEY is required");
  registerManagedRedisRoutes(app, pool, parseMasterKey(masterKeyEncoded), requireControl);

  app.post<{ Body: NodeDiskMetricInput }>("/v0/agent/node-metrics", async (request, reply) => {
    const nodeIdHeader = request.headers["x-rundea-node-id"];
    const nodeId = Array.isArray(nodeIdHeader) ? nodeIdHeader[0] : nodeIdHeader;
    const token = bearer(request.headers.authorization);
    if (!nodeId || !uuidPattern.test(nodeId) || !token) {
      return reply.code(401).send({ error: "invalid node credentials" });
    }
    const auth = await pool.query("SELECT token_hash FROM nodes WHERE id=$1", [nodeId]);
    if (auth.rowCount !== 1 || !equalTokenHash(hashToken(token), String(auth.rows[0].token_hash))) {
      return reply.code(401).send({ error: "invalid node credentials" });
    }
    try {
      await recordNodeDiskMetric(pool, nodeId, request.body);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid node disk metric" });
    }
  });

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
