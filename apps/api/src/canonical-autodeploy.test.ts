import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { configureCanonicalAutodeploy } from "./canonical-autodeploy";

const serviceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const nodeId = "44444444-4444-4444-8444-444444444444";

function sourceRow() {
  return {
    service_id: serviceId,
    project_id: projectId,
    repository_full_name: "acme/mono",
    selected_branch: "main",
    revision_sha: "a".repeat(40),
    source_path: "apps/web",
    dockerfile: "apps/web/Dockerfile",
    container_port: 3000,
    healthcheck_path: "/",
    build_variable_names: ["NEXT_PUBLIC_API_URL"],
    runtime_variable_names: [],
    confirmed_at: new Date("2026-09-14T00:00:00Z"),
    updated_at: new Date("2026-09-14T00:00:00Z"),
  };
}

test("canonical autodeploy uses confirmed source, ONLINE workspace node and Rundea managed port", async () => {
  const clientQueries: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      clientQueries.push({ text, params });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: null, rows: [] };
      if (text.includes("FROM nodes")) return { rowCount: 1, rows: [{ id: nodeId }] };
      if (text.includes("rundea_allocate_host_port")) return { rowCount: 1, rows: [{ host_port: 18000 }] };
      if (text.includes("INSERT INTO service_autodeploys")) return {
        rowCount: 1,
        rows: [{ service_id: serviceId, node_id: nodeId, source_branch: "main", enabled: true, created_at: new Date(), updated_at: new Date() }],
      };
      throw new Error(`unexpected client query: ${text}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes("FROM services s") && text.includes("JOIN projects")) {
        return { rowCount: 1, rows: [{ id: serviceId, project_id: projectId, workspace_id: workspaceId, slug: "web", name: "web" }] };
      }
      if (text.includes("FROM service_source_configs")) return { rowCount: 1, rows: [sourceRow()] };
      if (text.includes("FROM service_variables")) {
        assert.deepEqual(params, [serviceId, ["NEXT_PUBLIC_API_URL"]]);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected pool query: ${text}`);
    },
    connect: async () => client,
  } as unknown as Pool;

  const result = await configureCanonicalAutodeploy(pool, serviceId, {
    buildArgs: { NEXT_PUBLIC_API_URL: "https://api.example.test" },
  });
  assert.equal(result.serviceId, serviceId);
  assert.equal(result.nodeId, nodeId);
  assert.equal(result.repositoryFullName, "acme/mono");
  assert.equal(result.branch, "main");

  const insert = clientQueries.find((entry) => entry.text.includes("INSERT INTO service_autodeploys"));
  assert.ok(insert);
  assert.equal(insert.params?.[0], serviceId);
  assert.match(String(insert.params?.[1]), /^web-[0-9a-f]{10}$/);
  assert.equal(insert.params?.[2], nodeId);
  assert.equal(insert.params?.[3], "acme/mono");
  assert.equal(insert.params?.[8], 3000);
  assert.equal(insert.params?.[9], 18000);
});

test("canonical autodeploy rejects build args that were not discovered in Docker ARG", async () => {
  let connects = 0;
  const pool = {
    query: async (text: string) => {
      if (text.includes("FROM services s") && text.includes("JOIN projects")) {
        return { rowCount: 1, rows: [{ id: serviceId, project_id: projectId, workspace_id: workspaceId, slug: "web", name: "web" }] };
      }
      if (text.includes("FROM service_source_configs")) return { rowCount: 1, rows: [sourceRow()] };
      throw new Error(`unexpected query: ${text}`);
    },
    connect: async () => { connects += 1; throw new Error("should not connect"); },
  } as unknown as Pool;
  await assert.rejects(
    configureCanonicalAutodeploy(pool, serviceId, { buildArgs: { SECRET_TOKEN: "nope" } }),
    /was not discovered as a Docker build ARG/,
  );
  assert.equal(connects, 0);
});
