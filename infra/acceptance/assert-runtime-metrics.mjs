await import("./service-scope-e2e.mjs");

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");
const headers = { authorization: `Bearer ${controlToken}` };

async function request(path) {
  const response = await fetch(`${api}${path}`, { headers });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body;
}

const deployments = await request("/v0/deployments");
let proof = null;
for (const deployment of deployments) {
  const metrics = await request(`/v0/deployments/${encodeURIComponent(deployment.id)}/metrics?minutes=5`);
  if (Array.isArray(metrics.points) && metrics.points.length > 0 && metrics.nodeDisk) {
    proof = { deployment, metrics };
    break;
  }
}

if (!proof) throw new Error("no deployment produced persisted runtime metrics plus node disk telemetry");
if (proof.metrics.retentionHours !== 48) throw new Error(`unexpected metric retention ${proof.metrics.retentionHours}`);
const latest = proof.metrics.latest;
if (!latest) throw new Error("metrics response has points but no latest sample");
for (const key of ["cpuPercent", "memoryUsageBytes", "memoryLimitBytes", "networkRxBytes", "networkTxBytes"]) {
  if (!Number.isFinite(latest[key]) || latest[key] < 0) throw new Error(`invalid ${key}: ${latest[key]}`);
}
if (latest.memoryUsageBytes <= 0) throw new Error("real container memory usage should be positive");
if (!Number.isInteger(latest.sampleCount) || latest.sampleCount < 1) throw new Error(`invalid sampleCount ${latest.sampleCount}`);
const ageMs = Date.now() - new Date(latest.at).getTime();
if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > 10 * 60_000) throw new Error(`runtime metric timestamp is implausible: ${latest.at}`);

const disk = proof.metrics.nodeDisk;
if (!Number.isSafeInteger(disk.totalBytes) || disk.totalBytes <= 0) throw new Error(`invalid node disk total ${disk.totalBytes}`);
if (!Number.isSafeInteger(disk.availableBytes) || disk.availableBytes < 0 || disk.availableBytes > disk.totalBytes) {
  throw new Error(`invalid node disk available ${disk.availableBytes} / ${disk.totalBytes}`);
}
const diskAgeMs = Date.now() - new Date(disk.sampledAt).getTime();
if (!Number.isFinite(diskAgeMs) || diskAgeMs < -5_000 || diskAgeMs > 10 * 60_000) {
  throw new Error(`node disk metric timestamp is implausible: ${disk.sampledAt}`);
}

console.log(JSON.stringify({
  ok: true,
  verified: ["runtime-metrics", "node-disk-metrics"],
  deploymentId: proof.deployment.id,
  deploymentStatus: proof.deployment.status,
  pointCount: proof.metrics.points.length,
  nodeDisk: disk,
  latest,
}, null, 2));
