export type MetricPoint = {
  at: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  sampleCount: number;
};

export function formatMetricBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const digits = scaled >= 100 || unit === 0 ? 0 : scaled >= 10 ? 1 : 2;
  const display = Number(scaled.toFixed(digits)).toString();
  return `${display} ${units[unit]}`;
}

export function networkRateBytesPerSecond(points: MetricPoint[]): number | null {
  if (points.length < 2) return null;
  const previous = points[points.length - 2]!;
  const latest = points[points.length - 1]!;
  const elapsedSeconds = (new Date(latest.at).getTime() - new Date(previous.at).getTime()) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;
  const previousTotal = previous.networkRxBytes + previous.networkTxBytes;
  const latestTotal = latest.networkRxBytes + latest.networkTxBytes;
  const delta = latestTotal - previousTotal;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return delta / elapsedSeconds;
}

export function memoryPercent(point: MetricPoint | null): number | null {
  if (!point || !Number.isFinite(point.memoryUsageBytes) || !Number.isFinite(point.memoryLimitBytes) || point.memoryLimitBytes <= 0) return null;
  return Math.max(0, (point.memoryUsageBytes / point.memoryLimitBytes) * 100);
}

export function sparklinePath(values: number[], width = 320, height = 72): string {
  const finite = values.map(value => Number.isFinite(value) ? Math.max(0, value) : 0);
  if (!finite.length) return "";
  if (finite.length === 1) return `M 0 ${height / 2} L ${width} ${height / 2}`;
  const max = Math.max(...finite, 1);
  return finite.map((value, index) => {
    const x = (index / (finite.length - 1)) * width;
    const y = height - (value / max) * (height - 4) - 2;
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

export function metricIsStale(point: MetricPoint | null, nowMs = Date.now(), staleAfterMs = 45_000): boolean {
  if (!point) return true;
  const sampledAt = new Date(point.at).getTime();
  return !Number.isFinite(sampledAt) || nowMs - sampledAt > staleAfterMs;
}
