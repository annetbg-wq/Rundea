export type BuilderConfig = Readonly<{
  controlPlaneUrl: string;
  token: string;
  workerId: string;
  pollMs: number;
  timeoutMs: number;
  memoryBytes: number;
  cpuQuota: number;
  cpuPeriod: number;
  registryUsername: string | null;
  registryPassword: string | null;
}>;

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function resolveBuilderConfig(env: NodeJS.ProcessEnv = process.env): BuilderConfig {
  const rawUrl = env.RUNDEA_CONTROL_PLANE_URL?.trim();
  const token = env.RUNDEA_BUILDER_TOKEN?.trim();
  const workerId = env.RUNDEA_BUILDER_ID?.trim() || `builder-${process.pid}`;
  if (!rawUrl) throw new Error("RUNDEA_CONTROL_PLANE_URL is required");
  const url = new URL(rawUrl);
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("RUNDEA_CONTROL_PLANE_URL must be an HTTP(S) origin");
  }
  if (!token) throw new Error("RUNDEA_BUILDER_TOKEN is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(workerId)) throw new Error("RUNDEA_BUILDER_ID is invalid");
  const username = env.RUNDEA_REGISTRY_USERNAME?.trim() || null;
  const password = env.RUNDEA_REGISTRY_PASSWORD ?? null;
  if (Boolean(username) !== Boolean(password)) throw new Error("RUNDEA_REGISTRY_USERNAME and RUNDEA_REGISTRY_PASSWORD must be configured together");
  return {
    controlPlaneUrl: url.origin,
    token,
    workerId,
    pollMs: positiveInt(env.RUNDEA_BUILD_POLL_MS, 2000, "RUNDEA_BUILD_POLL_MS"),
    timeoutMs: positiveInt(env.RUNDEA_BUILD_TIMEOUT_SECONDS, 900, "RUNDEA_BUILD_TIMEOUT_SECONDS") * 1000,
    memoryBytes: positiveInt(env.RUNDEA_BUILD_MEMORY_BYTES, 4294967296, "RUNDEA_BUILD_MEMORY_BYTES"),
    cpuQuota: positiveInt(env.RUNDEA_BUILD_CPU_QUOTA, 200000, "RUNDEA_BUILD_CPU_QUOTA"),
    cpuPeriod: positiveInt(env.RUNDEA_BUILD_CPU_PERIOD, 100000, "RUNDEA_BUILD_CPU_PERIOD"),
    registryUsername: username,
    registryPassword: password,
  };
}
