import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresOperationApprovalStore } from "./operation-approval-store";

const now = new Date("2026-09-10T12:00:00.000Z");

function poolWithQuery(handler: (text: string, params?: unknown[]) => { rowCount: number; rows: unknown[] } | Promise<{ rowCount: number; rows: unknown[] }>): Pool {
  return { query: handler } as unknown as Pool;
}

test("session policy stores only a hash of the opaque approval reference", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const store = new PostgresOperationApprovalStore(poolWithQuery(async (text, params) => {
    calls.push({ text, params });
    return { rowCount: 1, rows: [] };
  }));

  const issued = await store.issueHumanSessionPolicy({
    operationNames: ["service.variables.upsert", "deployment.restart"],
    resourceIds: ["service:backend", "deployment:abc"],
    expiresAt: new Date("2026-09-10T13:00:00.000Z"),
    maxUses: 20,
  }, now);

  assert.match(issued.approvalRef, /^approval:[A-Za-z0-9_-]+$/);
  assert.equal(issued.evidence.kind, "SESSION_POLICY");
  assert.equal(calls.length, 1);
  const params = calls[0]?.params ?? [];
  assert.match(String(params[0]), /^[0-9a-f]{64}$/);
  assert.equal(params.includes(issued.approvalRef), false);
  assert.equal(JSON.stringify(calls).includes(issued.approvalRef), false);
  assert.equal(params[6], 20);
});

test("explicit approval is issued as human-only and one-use in storage", async () => {
  let capturedText = "";
  let capturedParams: unknown[] = [];
  const store = new PostgresOperationApprovalStore(poolWithQuery(async (text, params) => {
    capturedText = text;
    capturedParams = params ?? [];
    return { rowCount: 1, rows: [] };
  }));

  const issued = await store.issueHumanExplicitApproval({
    operationName: "deployment.rollback",
    resourceId: "deployment:abc",
    expiresAt: new Date("2026-09-10T12:05:00.000Z"),
  }, now);

  assert.equal(issued.evidence.kind, "EXPLICIT");
  if (issued.evidence.kind === "EXPLICIT") {
    assert.equal(issued.evidence.approvedBy, "HUMAN");
    assert.equal(issued.evidence.operationName, "deployment.rollback");
  }
  assert.match(capturedText, /'EXPLICIT','HUMAN'/);
  assert.match(capturedText, /,1\)/);
  assert.equal(capturedParams.includes(issued.approvalRef), false);
});

test("resolve reconstructs policy evidence only from an active server row", async () => {
  const store = new PostgresOperationApprovalStore(poolWithQuery(async (text) => {
    assert.match(text, /revoked_at IS NULL/);
    assert.match(text, /expires_at>\$2/);
    assert.match(text, /use_count<max_uses/);
    return {
      rowCount: 1,
      rows: [{
        kind: "SESSION_POLICY",
        operation_name: null,
        resource_id: null,
        operation_names: ["service.variables.upsert"],
        resource_ids: ["service:backend"],
        allow_sensitive: false,
        issued_at: now,
        expires_at: new Date("2026-09-10T13:00:00.000Z"),
      }],
    };
  }));

  const evidence = await store.resolve("approval:opaque", now);
  assert.equal(evidence?.kind, "SESSION_POLICY");
  if (evidence?.kind === "SESSION_POLICY") {
    assert.equal(evidence.approvedBy, "HUMAN");
    assert.deepEqual(evidence.operationNames, ["service.variables.upsert"]);
    assert.deepEqual(evidence.resourceIds, ["service:backend"]);
  }
});

test("consume is an atomic bounded update and reports exhausted approval", async () => {
  let calls = 0;
  const store = new PostgresOperationApprovalStore(poolWithQuery(async (text) => {
    calls += 1;
    assert.match(text, /SET use_count=use_count\+1/);
    assert.match(text, /revoked_at IS NULL/);
    assert.match(text, /use_count<max_uses/);
    return { rowCount: calls === 1 ? 1 : 0, rows: [] };
  }));

  assert.equal(await store.consume("approval:one-use", now), true);
  assert.equal(await store.consume("approval:one-use", now), false);
});

test("invalid scope and usage limits are rejected before database access", async () => {
  let calls = 0;
  const store = new PostgresOperationApprovalStore(poolWithQuery(async () => {
    calls += 1;
    return { rowCount: 1, rows: [] };
  }));

  await assert.rejects(
    store.issueHumanSessionPolicy({
      operationNames: ["service.variables.upsert"],
      resourceIds: ["service:backend", "service:backend"],
      expiresAt: new Date("2026-09-10T13:00:00.000Z"),
    }, now),
    /duplicate/,
  );
  await assert.rejects(
    store.issueHumanSessionPolicy({
      operationNames: ["service.variables.upsert"],
      resourceIds: ["service:backend"],
      expiresAt: new Date("2026-09-10T13:00:00.000Z"),
      maxUses: 0,
    }, now),
    /maxUses/,
  );
  await assert.rejects(
    store.issueHumanExplicitApproval({
      operationName: "deployment.rollback",
      resourceId: "bad\nresource",
      expiresAt: new Date("2026-09-10T12:05:00.000Z"),
    }, now),
    /resource scope/,
  );
  assert.equal(calls, 0);
});
