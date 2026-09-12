const buildArgNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxBuildArgs = 64;
const maxBuildArgNameBytes = 128;
const maxBuildArgValueBytes = 4096;

export function normalizeBuildArgs(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("buildArgs must be an object of string values");
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxBuildArgs) {
    throw new Error(`buildArgs supports at most ${maxBuildArgs} entries`);
  }

  const normalized: Array<[string, string]> = [];
  for (const [key, rawValue] of entries) {
    if (!buildArgNamePattern.test(key) || Buffer.byteLength(key, "utf8") > maxBuildArgNameBytes) {
      throw new Error(`invalid build arg name: ${key}`);
    }
    if (typeof rawValue !== "string") {
      throw new Error(`build arg ${key} must be a string`);
    }
    if (Buffer.byteLength(rawValue, "utf8") > maxBuildArgValueBytes || /[\r\n\u0000]/.test(rawValue)) {
      throw new Error(`build arg ${key} contains an invalid or oversized value`);
    }
    normalized.push([key, rawValue]);
  }

  normalized.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(normalized);
}
