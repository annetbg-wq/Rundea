import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { resolveActiveCanonicalService, runtimeServiceKey } from "./service-scope";

const serviceId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";

test("runtime service key separates equal human names by UUID", () => {
  const first = runtimeServiceKey("api", serviceId);
  const second = runtimeServiceKey("api", "22222222-2222-4222-8222-222222222222");
  assert.notEqual(first, second);
  assert.match(first, /^api-[0-9a-f]{10}$/);
});

test("canonical resolver rejects non-UUID before database access", async () => {
  let queries = 0;
  const pool = { query: async () => { queries += 1; return { rowCount: 0, rows: [] }; } } as unknown as Pool;
  await assert.rejects(resolveActiveCanonicalService(pool, "api"), /serviceId must be a UUID/);
  assert.equal(queries, 0);
});

test("canonical resolver returns project and workspace scoped active service", async () => {
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      assert.match(text, /JOIN projects/);
      assert.equal(params?.[0], serviceId);
      return {
        rowCount: 1,
        rows: [{ id: serviceId, project_id: projectId, workspace_id: workspaceId, slug: "api", name: "api" }],
      };
    },
  } as unknown as Pool;
  const scope = await resolveActiveCanonicalService(pool, serviceId);
  assert.equal(scope.id, serviceId);
  assert.equal(scope.projectId, projectId);
  assert.equal(scope.workspaceId, workspaceId);
  assert.equal(scope.runtimeKey, "api-1111111111");
});
