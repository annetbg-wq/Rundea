import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { executeRuntimeMetricsReadOperation, RuntimeMetricOperationError } from "./runtime-metric-operations";

const deploymentId = "123e4567-e89b-42d3-a456-426614174000";
function poolFromQuery(query: (text: string, params?: unknown[]) => Promise<{ rowCount: number; rows: Record<string, unknown>[] }>): Pool { return { query } as unknown as Pool; }
test("runtime metrics operation rejects invalid input before touching the database", async () => {
  let queries = 0; const pool = poolFromQuery(async () => { queries += 1; return { rowCount: 0, rows: [] }; });
  await assert.rejects(executeRuntimeMetricsReadOperation(pool, { deploymentId: "not-a-uuid", minutes: "60" }), (error: unknown) => error instanceof RuntimeMetricOperationError && error.statusCode === 400);
  assert.equal(queries, 0);
});
test("runtime metrics operation reports a missing deployment as 404", async () => {
  await assert.rejects(executeRuntimeMetricsReadOperation(poolFromQuery(async () => ({ rowCount: 0, rows: [] })), { deploymentId, minutes: "60" }), (error: unknown) => error instanceof RuntimeMetricOperationError && error.statusCode === 404);
});
test("runtime metrics operation returns telemetry and server-authoritative health", async () => {
  const sampledAt = "2026-09-09T12:00:00.000Z"; const checkedAt = "2026-09-09T12:00:05.000Z";
  const pool = poolFromQuery(async (text) => {
    if (text.startsWith("SELECT id,node_id,status,runtime_health")) return { rowCount: 1, rows: [{ id: deploymentId, node_id: "node-1", status: "READY", runtime_health: "HEALTHY", runtime_health_checked_at: checkedAt, runtime_restart_count: 2, runtime_uptime_seconds: 3600, runtime_health_error: null }] };
    if (text.includes("date_bin")) return { rowCount: 1, rows: [{ sampled_at: sampledAt, cpu_percent: 12.5, memory_usage_bytes: 1024, memory_limit_bytes: 4096, network_rx_bytes: 100, network_tx_bytes: 200, sample_count: 3 }] };
    if (text.includes("ORDER BY sampled_at DESC,id DESC")) return { rowCount: 1, rows: [{ sampled_at: sampledAt, cpu_percent: 13, memory_usage_bytes: 2048, memory_limit_bytes: 4096, network_rx_bytes: 150, network_tx_bytes: 250 }] };
    throw new Error(`unexpected query: ${text}`);
  });
  const result = await executeRuntimeMetricsReadOperation(pool, { deploymentId, minutes: "120" });
  assert.equal(result.runtimeHealth, "HEALTHY"); assert.equal(result.runtimeHealthCheckedAt, checkedAt); assert.equal(result.restartCount, 2); assert.equal(result.uptimeSeconds, 3600);
  assert.equal(result.minutes, 120); assert.equal(result.bucketSeconds, 30); assert.equal(result.latest?.sampleCount, 1); assert.equal(result.points[0]?.sampleCount, 3);
});
