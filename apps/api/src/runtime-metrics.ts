import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { equalTokenHash, hashToken } from "@rundea/crypto";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type RuntimeMetricSample = {
  deploymentId: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
};

type RuntimeMetricBatch = { samples?: RuntimeMetricSample[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBatchSize = 100;
const maxCpuPercent = 100000;
const maxBytes = Number.MAX_SAFE_INTEGER;
const schemaReadyByPool = new WeakMap<Pool, Promise<void>>();
let lastPrunedAt = 0;

function ensureSchema(pool: Pool): Promise<void> {
  let existing = schemaReadyByPool.get(pool);
  if (!existing) {
    existing = (async () => {
      const migrationUrl = new URL("../migrations/008_runtime_metrics.sql", import.meta.url);
      await pool.query(await readFile(migrationUrl, "utf8"));
    })();
    schemaReadyByPool.set(pool, existing);
  }
  return existing;
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maxBytes;
}

export function validateRuntimeMetricSample(sample: RuntimeMetricSample): void {
  if (!sample || !uuidPattern.test(sample.deploymentId)) throw new Error("metric deploymentId must be a UUID");
  if (typeof sample.cpuPercent !== "number" || !Number.isFinite(sample.cpuPercent) || sample.cpuPercent < 0 || sample.cpuPercent > maxCpuPercent) {
    throw new Error("metric cpuPercent is invalid");
  }
  for (const [name, value] of [
    ["memoryBytes", sample.memoryBytes],
    ["memoryLimitBytes", sample.memoryLimitBytes],
    ["networkRxBytes", sample.networkRxBytes],
    ["networkTxBytes", sample.networkTxBytes],
  ] as const) {
    if (!safeInteger(value)) throw new Error(`metric ${name} is invalid`);
  }
}

export function validateRuntimeMetricBatch(body: RuntimeMetricBatch): RuntimeMetricSample[] {
  if (!Array.isArray(body?.samples) || body.samples.length === 0 || body.samples.length > maxBatchSize) {
    throw new Error(`metrics batch must contain between 1 and ${maxBatchSize} samples`);
  }
  for (const sample of body.samples) validateRuntimeMetricSample(sample);
  return body.samples;
}

export function normalizeMetricWindow(value: unknown): number {
  if (value === undefined || value === null || value === "") return 60;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error("minutes must be an integer between 5 and 1440");
  return minutes;
}

async function authenticateNode(pool: Pool, nodeId: string, request: FastifyRequest): Promise<boolean> {
  if (!uuidPattern.test(nodeId)) return false;
  const headerNodeId = singleHeader(request.headers["x-rundea-node-id"]);
  const token = bearer(request.headers.authorization);
  if (!headerNodeId || headerNodeId !== nodeId || !token) return false;
  const result = await pool.query("SELECT token_hash FROM nodes WHERE id=$1", [nodeId]);
  return result.rowCount === 1 && equalTokenHash(result.rows[0].token_hash, hashToken(token));
}

async function maybePrune(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastPrunedAt < 60_000) return;
  lastPrunedAt = now;
  await pool.query("DELETE FROM deployment_runtime_metrics WHERE observed_at < now() - interval '24 hours'");
}

export function registerRuntimeMetricsRoutes(app: FastifyInstance, pool: Pool, requireControl: ControlPreHandler): void {
  const schemaReady = ensureSchema(pool);

  app.post<{ Params: { id: string }; Body: RuntimeMetricBatch }>("/v0/nodes/:id/runtime-metrics", async (request, reply) => {
    await schemaReady;
    const nodeId = request.params.id;
    if (!(await authenticateNode(pool, nodeId, request))) return reply.code(401).send({ error: "runtime metrics authorization failed" });

    let samples: RuntimeMetricSample[];
    try {
      samples = validateRuntimeMetricBatch(request.body ?? {});
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid runtime metrics" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const sample of samples) {
        const inserted = await client.query(
          `INSERT INTO deployment_runtime_metrics(
             deployment_id,node_id,cpu_percent,memory_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes
           )
           SELECT id,$2,$3,$4,$5,$6,$7
             FROM deployments
            WHERE id=$1 AND node_id=$2`,
          [
            sample.deploymentId,
            nodeId,
            sample.cpuPercent,
            sample.memoryBytes,
            sample.memoryLimitBytes,
            sample.networkRxBytes,
            sample.networkTxBytes,
          ],
        );
        if (inserted.rowCount !== 1) throw new Error("metric deployment does not belong to authenticated node");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.warn({ nodeId }, "runtime metrics batch rejected");
      return reply.code(403).send({ error: "runtime metrics ownership validation failed" });
    } finally {
      client.release();
    }

    await maybePrune(pool).catch((error) => request.log.warn(error, "runtime metrics retention cleanup failed"));
    return reply.code(202).send({ accepted: samples.length });
  });

  app.get<{ Params: { id: string }; Querystring: { minutes?: string } }>(
    "/v0/deployments/:id/metrics",
    { preHandler: requireControl },
    async (request, reply) => {
      await schemaReady;
      if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: "invalid deployment id" });
      let minutes: number;
      try {
        minutes = normalizeMetricWindow(request.query?.minutes);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid metric window" });
      }

      const exists = await pool.query("SELECT 1 FROM deployments WHERE id=$1", [request.params.id]);
      if (exists.rowCount !== 1) return reply.code(404).send({ error: "deployment not found" });

      const result = await pool.query(
        `SELECT observed_at,cpu_percent,memory_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes
           FROM deployment_runtime_metrics
          WHERE deployment_id=$1 AND observed_at >= now() - ($2::int * interval '1 minute')
          ORDER BY observed_at ASC
          LIMIT 6000`,
        [request.params.id, minutes],
      );
      return {
        deploymentId: request.params.id,
        minutes,
        metrics: result.rows.map((row) => ({
          observedAt: row.observed_at,
          cpuPercent: Number(row.cpu_percent),
          memoryBytes: Number(row.memory_bytes),
          memoryLimitBytes: Number(row.memory_limit_bytes),
          networkRxBytes: Number(row.network_rx_bytes),
          networkTxBytes: Number(row.network_tx_bytes),
        })),
      };
    },
  );
}
