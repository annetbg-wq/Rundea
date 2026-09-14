import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeMetricEvent } from "./runtime-metrics";

const deploymentId = "123e4567-e89b-42d3-a456-426614174000";
function metric(overrides: Record<string, unknown> = {}) {
  return { type: "metric" as const, deploymentId, cpuPercent: 12.5, memoryUsageBytes: 64 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, networkRxBytes: 12345, networkTxBytes: 67890, at: new Date().toISOString(), ...overrides };
}
test("runtime metric validation accepts finite bounded Docker samples", () => {
  const value = validateRuntimeMetricEvent(metric()); assert.equal(value.deploymentId, deploymentId); assert.equal(value.cpuPercent, 12.5);
});
test("runtime metric validation accepts bounded continuous-health detail", () => {
  const value = validateRuntimeMetricEvent(metric({ runtimeHealth: "DOWN", restartDelta: 1, uptimeSeconds: 42, healthError: "HTTP 503" }));
  assert.equal(value.runtimeHealth, "DOWN"); assert.equal(value.restartDelta, 1); assert.equal(value.uptimeSeconds, 42); assert.equal(value.healthError, "HTTP 503");
});
test("runtime metric validation rejects invalid ownership identity and counters", () => {
  assert.throws(() => validateRuntimeMetricEvent(metric({ deploymentId: "not-a-uuid" })));
  assert.throws(() => validateRuntimeMetricEvent(metric({ cpuPercent: Number.NaN })));
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
