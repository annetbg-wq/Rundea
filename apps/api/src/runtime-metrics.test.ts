import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMetricWindow, validateRuntimeMetricBatch, validateRuntimeMetricSample } from "./runtime-metrics";

const sample = {
  deploymentId: "11111111-1111-4111-8111-111111111111",
  cpuPercent: 12.5,
  memoryBytes: 64 * 1024 * 1024,
  memoryLimitBytes: 512 * 1024 * 1024,
  networkRxBytes: 1234,
  networkTxBytes: 5678,
};

test("runtime metric sample accepts finite non-negative runtime values", () => {
  assert.doesNotThrow(() => validateRuntimeMetricSample(sample));
  assert.deepEqual(validateRuntimeMetricBatch({ samples: [sample] }), [sample]);
});

test("runtime metric sample rejects invalid identities and numeric abuse", () => {
  assert.throws(() => validateRuntimeMetricSample({ ...sample, deploymentId: "not-a-uuid" }));
  assert.throws(() => validateRuntimeMetricSample({ ...sample, cpuPercent: Number.NaN }));
  assert.throws(() => validateRuntimeMetricSample({ ...sample, cpuPercent: -1 }));
  assert.throws(() => validateRuntimeMetricSample({ ...sample, memoryBytes: 1.5 }));
  assert.throws(() => validateRuntimeMetricSample({ ...sample, networkTxBytes: Number.MAX_SAFE_INTEGER + 1 }));
});

test("runtime metric batch is bounded", () => {
  assert.throws(() => validateRuntimeMetricBatch({ samples: [] }));
  assert.throws(() => validateRuntimeMetricBatch({ samples: Array.from({ length: 101 }, () => sample) }));
});

test("metric query window defaults to one hour and stays bounded", () => {
  assert.equal(normalizeMetricWindow(undefined), 60);
  assert.equal(normalizeMetricWindow("15"), 15);
  assert.equal(normalizeMetricWindow("1440"), 1440);
  assert.throws(() => normalizeMetricWindow("4"));
  assert.throws(() => normalizeMetricWindow("1441"));
  assert.throws(() => normalizeMetricWindow("10.5"));
});
