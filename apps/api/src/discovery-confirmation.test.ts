import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { confirmDiscoveredServices, normalizeDiscoverySelections } from "./discovery-confirmation";

test("normalizes discovery selections and rejects duplicate paths", () => {
  assert.deepEqual(normalizeDiscoverySelections([{ path: "apps/api", name: "API", slug: "api", containerPort: 8080 }]), [
    { path: "apps/api", name: "API", slug: "api", containerPort: 8080, healthcheckPath: undefined },
  ]);
  assert.throws(() => normalizeDiscoverySelections([{ path: "apps/api" }, { path: "apps/api" }]), /duplicate discovery selection/);
  assert.throws(() => normalizeDiscoverySelections([{ path: "../api" }]), /path is invalid/);
});

test("confirmation creates a service from exact stored discovery and persists immutable source config", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: null, rows: [] };
      if (text.includes("FROM project_sources")) {
        return {
          rowCount: 1,
          rows: [{
            repository_full_name: "acme/mono",
            selected_branch: "main",
            revision_sha: "a".repeat(40),
            discovery: {
              services: [{
                name: "api",
                path: "apps/api",
                dockerfile: "apps/api/Dockerfile",
                containerPorts: [8080],
                healthcheckPath: "/health",
                buildArgumentNames: ["PUBLIC_ORIGIN"],
                environmentVariableNames: ["DATABASE_URL", "REDIS_URL"],
              }],
            },
          }],
        };
      }
      if (text.includes("FROM services s") && text.includes("LEFT JOIN service_source_configs")) return { rowCount: 0, rows: [] };
      if (text.includes("INSERT INTO services")) return { rowCount: 1, rows: [] };
      if (text.includes("INSERT INTO service_source_configs")) return { rowCount: 1, rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const result = await confirmDiscoveredServices(pool, "11111111-1111-4111-8111-111111111111", [{ path: "apps/api" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.sourcePath, "apps/api");
  assert.equal(result[0]?.containerPort, 8080);
  assert.equal(result[0]?.healthcheckPath, "/health");
  assert.deepEqual(result[0]?.buildVariableNames, ["PUBLIC_ORIGIN"]);
  assert.deepEqual(result[0]?.runtimeVariableNames, ["DATABASE_URL", "REDIS_URL"]);
  assert.equal(result[0]?.revisionSha, "a".repeat(40));
  assert.equal(result[0]?.reused, false);

  const configInsert = queries.find((entry) => entry.text.includes("INSERT INTO service_source_configs"));
  assert.ok(configInsert);
  assert.equal(configInsert.params?.[2], "acme/mono");
  assert.equal(configInsert.params?.[5], "apps/api");
  assert.equal(configInsert.params?.[6], "apps/api/Dockerfile");
  assert.equal(configInsert.params?.[7], 8080);
});
