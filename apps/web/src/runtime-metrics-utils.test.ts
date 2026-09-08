import assert from "node:assert/strict";
import test from "node:test";
import { formatMetricBytes, memoryPercent, metricIsStale, networkRateBytesPerSecond, sparklinePath, type MetricPoint } from "./runtime-metrics-utils";

function point(overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    at: "2026-09-08T20:00:00.000Z",
    cpuPercent: 10,
    memoryUsageBytes: 50_000_000,
    memoryLimitBytes: 100_000_000,
    networkRxBytes: 1_000,
    networkTxBytes: 2_000,
    sampleCount: 1,
    ...overrides,
  };
}

test("network rate uses cumulative Docker counters and rejects resets", () => {
  const rate = networkRateBytesPerSecond([
    point(),
    point({ at: "2026-09-08T20:00:10.000Z", networkRxBytes: 2_000, networkTxBytes: 4_000 }),
  ]);
  assert.equal(rate, 300);
  assert.equal(networkRateBytesPerSecond([
    point({ networkRxBytes: 5_000, networkTxBytes: 5_000 }),
    point({ at: "2026-09-08T20:00:10.000Z", networkRxBytes: 1_000, networkTxBytes: 1_000 }),
  ]), null);
});

test("memory percent and byte formatting remain bounded", () => {
  assert.equal(memoryPercent(point()), 50);
  assert.equal(memoryPercent(point({ memoryLimitBytes: 0 })), null);
  assert.equal(formatMetricBytes(1_500_000), "1.5 MB");
  assert.equal(formatMetricBytes(Number.NaN), "—");
});

test("sparkline path and stale detection are deterministic", () => {
  const path = sparklinePath([0, 50, 100], 100, 50);
  assert.match(path, /^M 0\.00 /);
  assert.match(path, /L 100\.00 /);
  const sample = point();
  assert.equal(metricIsStale(sample, new Date(sample.at).getTime() + 44_000), false);
  assert.equal(metricIsStale(sample, new Date(sample.at).getTime() + 46_000), true);
});
