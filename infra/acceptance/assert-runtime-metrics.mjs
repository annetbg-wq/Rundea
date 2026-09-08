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
  if (Array.isArray(metrics.points) && metrics.points.length > 0) {
    proof = { deployment, metrics };
    break;
  }
}

if (!proof) throw new Error("no deployment produced a persisted runtime metric sample");
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

console.log(JSON.stringify({
  ok: true,
  verified: "runtime-metrics",
  deploymentId: proof.deployment.id,
  deploymentStatus: proof.deployment.status,
  pointCount: proof.metrics.points.length,
  latest,
}, null, 2));
