import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { executeNodeQualificationsReadOperation, NodeQualificationOperationError } from "./node-qualification-operations";

const nodeId = "123e4567-e89b-42d3-a456-426614174000";

function poolFromQuery(query: (text: string, params?: unknown[]) => Promise<{ rowCount: number; rows: Record<string, unknown>[] }>): Pool {
  return { query } as unknown as Pool;
}

test("node qualification read rejects an invalid node id before database access", async () => {
  let queries = 0;
  const pool = poolFromQuery(async () => {
    queries += 1;
    return { rowCount: 0, rows: [] };
  });

  await assert.rejects(
    executeNodeQualificationsReadOperation(pool, "not-a-uuid"),
    (error: unknown) => error instanceof NodeQualificationOperationError && error.statusCode === 400 && error.message === "invalid node id",
  );
  assert.equal(queries, 0);
});

test("node qualification read reports a missing node as 404", async () => {
  const pool = poolFromQuery(async () => ({ rowCount: 0, rows: [] }));
  await assert.rejects(
    executeNodeQualificationsReadOperation(pool, nodeId),
    (error: unknown) => error instanceof NodeQualificationOperationError && error.statusCode === 404 && error.message === "node not found",
  );
});

test("node qualification read preserves bounded history and probe payload", async () => {
  let calls = 0;
  const row = {
    id: "qual-1",
    node_id: nodeId,
    profile: "sendina-egress-v1",
    status: "PASSED",
    probes: [{ name: "smtp-tls", ok: true }],
  };
  const pool = poolFromQuery(async (text) => {
    calls += 1;
    if (text.startsWith("SELECT 1 FROM nodes")) return { rowCount: 1, rows: [{ exists: 1 }] };
    if (text.includes("FROM node_qualifications q")) return { rowCount: 1, rows: [row] };
    throw new Error(`unexpected query: ${text}`);
  });

  const result = await executeNodeQualificationsReadOperation(pool, nodeId);
  assert.equal(calls, 2);
  assert.deepEqual(result.qualifications, [row]);
});
