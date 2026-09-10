import assert from "node:assert/strict";
import test from "node:test";
import { executeAuthorizedOperation } from "./operation-execution";
import type { ApprovalEvidence } from "./operation-policy";

const now = new Date("2026-09-10T12:00:00.000Z");
const resourceId = "service:backend";
const humanSession: ApprovalEvidence = {
  kind: "SESSION_POLICY",
  policyId: "policy-1",
  approvedBy: "HUMAN",
  expiresAt: "2026-09-10T13:00:00.000Z",
  operationNames: ["service.variables.upsert"],
  resourceIds: [resourceId],
};

test("denied operation never invokes executor", async () => {
  let executions = 0;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId },
    async () => null,
    async () => {
      executions += 1;
      return { changed: true };
    },
    now,
  );
  assert.equal(result.ok, false);
  assert.equal(executions, 0);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_NOT_AUTHORIZED");
    assert.equal(result.error.requiredApproval, "SESSION_OR_EXPLICIT");
  }
});

test("authorized operation executes exactly once with server context", async () => {
  let executions = 0;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "policy:1" },
    async (ref) => ref === "policy:1" ? humanSession : null,
    async (context) => {
      executions += 1;
      assert.equal(context.operationName, "service.variables.upsert");
      assert.equal(context.client, "MCP");
      assert.equal(context.resourceId, resourceId);
      assert.equal(context.effectiveRiskClass, "SAFE_WRITE");
      assert.equal(context.approvalRef, "policy:1");
      assert.match(context.correlationId, /^[0-9a-f-]{36}$/i);
      return { updated: ["API_TOKEN"] };
    },
    now,
  );
  assert.equal(executions, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.result, { updated: ["API_TOKEN"] });
});

test("read-only operation executes without approval resolver access", async () => {
  let resolverCalls = 0;
  let executions = 0;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId },
    async () => {
      resolverCalls += 1;
      return humanSession;
    },
    async () => {
      executions += 1;
      return { variables: [] };
    },
    now,
  );
  assert.equal(result.ok, true);
  assert.equal(resolverCalls, 0);
  assert.equal(executions, 1);
});

test("executor exception is sanitized and does not escape secret material", async () => {
  const secret = "do-not-leak-this-secret";
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "API", resourceId, approvalRef: "policy:1" },
    async () => humanSession,
    async () => {
      throw new Error(`database failed while handling ${secret}`);
    },
    now,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_FAILED");
    assert.equal(result.error.message, "operation execution failed");
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("authorization failure and execution failure both preserve correlation id", async () => {
  const denied = await executeAuthorizedOperation(
    { operationName: "service.variable.delete", client: "MCP", resourceId },
    async () => null,
    async () => ({ deleted: true }),
    now,
  );
  const failed = await executeAuthorizedOperation(
    { operationName: "service.variables.read", client: "API", resourceId },
    async () => null,
    async () => { throw new Error("failure"); },
    now,
  );
  assert.match(denied.correlationId, /^[0-9a-f-]{36}$/i);
  assert.match(failed.correlationId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(denied.correlationId, failed.correlationId);
});
