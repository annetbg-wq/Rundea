import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresOperationAuditRecorder, type OperationAuditStart } from "./operation-audit";

const entry: OperationAuditStart = {
  correlationId: "123e4567-e89b-42d3-a456-426614174000",
  operationName: "service.variables.upsert",
  client: "MCP",
  resourceId: "service:backend",
  effectiveRiskClass: "SAFE_WRITE",
  approvalRefHash: "a".repeat(64),
};

test("audit recorder writes only bounded operation metadata and approval hash", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  const recorder = new PostgresOperationAuditRecorder(pool);

  await recorder.beginAuthorized(entry);
  await recorder.complete(entry.correlationId, "SUCCEEDED");

  assert.equal(calls.length, 2);
  assert.match(calls[0]?.text ?? "", /approval_ref_hash/);
  assert.deepEqual(calls[0]?.params, [
    entry.correlationId,
    entry.operationName,
    entry.client,
    entry.resourceId,
    entry.effectiveRiskClass,
    entry.approvalRefHash,
  ]);
  assert.deepEqual(calls[1]?.params, [entry.correlationId, "SUCCEEDED", null]);

  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes("value"), false);
  assert.equal(serialized.includes("payload"), false);
  assert.equal(serialized.includes("approval:raw-secret"), false);
});

test("denied audit row is terminal and carries only authorization error code", async () => {
  let captured: unknown[] | undefined;
  const pool = {
    query: async (_text: string, params?: unknown[]) => {
      captured = params;
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  const recorder = new PostgresOperationAuditRecorder(pool);
  await recorder.recordDenied(entry, "OPERATION_NOT_AUTHORIZED");
  assert.deepEqual(captured, [
    entry.correlationId,
    entry.operationName,
    entry.client,
    entry.resourceId,
    entry.effectiveRiskClass,
    entry.approvalRefHash,
    "OPERATION_NOT_AUTHORIZED",
  ]);
});

test("audit completion accepts bounded approval failure code", async () => {
  let captured: unknown[] | undefined;
  const pool = {
    query: async (_text: string, params?: unknown[]) => {
      captured = params;
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  const recorder = new PostgresOperationAuditRecorder(pool);
  await recorder.complete(entry.correlationId, "FAILED", "APPROVAL_UNAVAILABLE");
  assert.deepEqual(captured, [entry.correlationId, "FAILED", "APPROVAL_UNAVAILABLE"]);
});

test("audit completion requires an existing authorized row", async () => {
  const pool = {
    query: async () => ({ rowCount: 0, rows: [] }),
  } as unknown as Pool;
  const recorder = new PostgresOperationAuditRecorder(pool);
  await assert.rejects(
    recorder.complete(entry.correlationId, "FAILED", "OPERATION_FAILED"),
    /lost authorized record/,
  );
});
