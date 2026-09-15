import assert from "node:assert/strict";
import test from "node:test";
import { validateNodeDiskMetric, validateRuntimeMetricEvent } from "./runtime-metrics";

const deploymentId = "123e4567-e89b-42d3-a456-426614174000";

function metric(overrides: Record<string, unknown> = {}) {
  return {
    type: "metric" as const,
    deploymentId,
    cpuPercent: 12.5,
    memoryUsageBytes: 64 * 1024 * 1024,
    memoryLimitBytes: 512 * 1024 * 1024,
    networkRxBytes: 12345,
    networkTxBytes: 67890,
    at: new Date().toISOString(),
    ...overrides,
  };
}

test("runtime metric validation accepts finite bounded Docker samples", () => {
  const value = validateRuntimeMetricEvent(metric());
  assert.equal(value.deploymentId, deploymentId);
  assert.equal(value.cpuPercent, 12.5);
  assert.equal(value.memoryUsageBytes, 64 * 1024 * 1024);
});

test("runtime metric validation accepts bounded continuous-health detail", () => {
  const value = validateRuntimeMetricEvent(metric({
    runtimeHealth: "DOWN",
    restartDelta: 1,
    uptimeSeconds: 42,
    healthError: "HTTP 503",
  }));
  assert.equal(value.runtimeHealth, "DOWN");
  assert.equal(value.restartDelta, 1);
  assert.equal(value.uptimeSeconds, 42);
  assert.equal(value.healthError, "HTTP 503");
});

test("runtime metric validation rejects invalid ownership identity and counters", () => {
  assert.throws(() => validateRuntimeMetricEvent(metric({ deploymentId: "not-a-uuid" })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ cpuPercent: Number.NaN })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ cpuPercent: -1 })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ memoryUsageBytes: 1.5 })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ networkTxBytes: Number.MAX_SAFE_INTEGER + 1 })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ at: "not-a-date" })));
});

test("runtime health detail fails closed when malformed", () => {
  assert.throws(() => validateRuntimeMetricEvent(metric({ runtimeHealth: "BROKEN" })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ restartDelta: 1 })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ runtimeHealth: "DOWN", restartDelta: 2 })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ runtimeHealth: "DOWN", healthError: "x".repeat(1001) })));
});

test("node disk metric validation accepts bounded filesystem telemetry", () => {
  const value = validateNodeDiskMetric({
    diskTotalBytes: 200 * 1024 * 1024 * 1024,
    diskAvailableBytes: 120 * 1024 * 1024 * 1024,
    at: "2026-09-15T19:00:00.000Z",
  });
  assert.equal(value.diskTotalBytes, 200 * 1024 * 1024 * 1024);
  assert.equal(value.diskAvailableBytes, 120 * 1024 * 1024 * 1024);
  assert.equal(value.at, "2026-09-15T19:00:00.000Z");
});

test("node disk metric validation rejects impossible or unsafe values", () => {
  const valid = { diskTotalBytes: 1000, diskAvailableBytes: 500, at: new Date().toISOString() };
  assert.throws(() => validateNodeDiskMetric({ ...valid, diskTotalBytes: 0 }));
  assert.throws(() => validateNodeDiskMetric({ ...valid, diskAvailableBytes: 1001 }));
  assert.throws(() => validateNodeDiskMetric({ ...valid, diskAvailableBytes: -1 }));
  assert.throws(() => validateNodeDiskMetric({ ...valid, diskTotalBytes: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => validateNodeDiskMetric({ ...valid, at: "not-a-date" }));
});
