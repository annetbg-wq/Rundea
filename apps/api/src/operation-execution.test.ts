import assert from "node:assert/strict";
import test from "node:test";
import type { OperationAuditRecorder, OperationAuditStart, OperationAuditOutcome } from "./operation-audit";
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

class MemoryAudit implements OperationAuditRecorder {
  readonly events: string[] = [];
  failBegin = false;
  failComplete = false;

  async recordDenied(entry: OperationAuditStart): Promise<void> {
    this.events.push(`DENIED:${entry.correlationId}`);
  }

  async beginAuthorized(entry: OperationAuditStart): Promise<void> {
    if (this.failBegin) throw new Error("audit unavailable");
    this.events.push(`AUTHORIZED:${entry.correlationId}`);
  }

  async complete(correlationId: string, outcome: OperationAuditOutcome): Promise<void> {
    if (this.failComplete) throw new Error("audit completion unavailable");
    this.events.push(`${outcome}:${correlationId}`);
  }
}

test("denied operation never invokes executor and records denial", async () => {
  let executions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId },
    async () => null,
    audit,
    async () => {
      executions += 1;
      return { changed: true };
    },
    now,
  );
  assert.equal(result.ok, false);
  assert.equal(executions, 0);
  assert.equal(audit.events.length, 1);
  assert.match(audit.events[0] ?? "", /^DENIED:/);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_NOT_AUTHORIZED");
    assert.equal(result.error.requiredApproval, "SESSION_OR_EXPLICIT");
    assert.equal(result.auditFinalized, true);
  }
});

test("audit start failure blocks an otherwise authorized mutation", async () => {
  let executions = 0;
  const audit = new MemoryAudit();
  audit.failBegin = true;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "policy:1" },
    async () => humanSession,
    audit,
    async () => {
      executions += 1;
      return { changed: true };
    },
    now,
  );
  assert.equal(executions, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "AUDIT_UNAVAILABLE");
    assert.equal(result.auditFinalized, false);
  }
});

test("audit start failure does not block an authorized read-only operation", async () => {
  let executions = 0;
  let resolverCalls = 0;
  const audit = new MemoryAudit();
  audit.failBegin = true;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId },
    async () => {
      resolverCalls += 1;
      return humanSession;
    },
    audit,
    async () => {
      executions += 1;
      return { variables: [] };
    },
    now,
  );
  assert.equal(executions, 1);
  assert.equal(resolverCalls, 0);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.auditFinalized, false);
});

test("authorized operation executes exactly once between audit start and success", async () => {
  let executions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "policy:1" },
    async (ref) => ref === "policy:1" ? humanSession : null,
    audit,
    async (context) => {
      executions += 1;
      assert.match(audit.events[0] ?? "", /^AUTHORIZED:/);
      assert.equal(context.operationName, "service.variables.upsert");
      assert.equal(context.client, "MCP");
      assert.equal(context.resourceId, resourceId);
      assert.equal(context.effectiveRiskClass, "SAFE_WRITE");
      assert.equal(context.approvalRef, "policy:1");
      return { updated: ["API_TOKEN"] };
    },
    now,
  );
  assert.equal(executions, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.auditFinalized, true);
  assert.equal(audit.events.length, 2);
  assert.match(audit.events[1] ?? "", /^SUCCEEDED:/);
});

test("read-only operation enters the audit trail when audit is available and skips approval resolver", async () => {
  let resolverCalls = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId },
    async () => {
      resolverCalls += 1;
      return humanSession;
    },
    audit,
    async () => ({ variables: [] }),
    now,
  );
  assert.equal(result.ok, true);
  assert.equal(resolverCalls, 0);
  assert.match(audit.events[0] ?? "", /^AUTHORIZED:/);
  assert.match(audit.events[1] ?? "", /^SUCCEEDED:/);
});

test("executor exception is sanitized and failure is audited", async () => {
  const secret = "do-not-leak-this-secret";
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "API", resourceId, approvalRef: "policy:1" },
    async () => humanSession,
    audit,
    async () => {
      throw new Error(`database failed while handling ${secret}`);
    },
    now,
  );
  assert.equal(result.ok, false);
  assert.match(audit.events[1] ?? "", /^FAILED:/);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_FAILED");
    assert.equal(result.error.message, "operation execution failed");
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("audit completion failure does not misreport an already completed mutation as retryable failure", async () => {
  const audit = new MemoryAudit();
  audit.failComplete = true;
  let executions = 0;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "API", resourceId, approvalRef: "policy:1" },
    async () => humanSession,
    audit,
    async () => {
      executions += 1;
      return { updated: ["API_TOKEN"] };
    },
    now,
  );
  assert.equal(executions, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.auditFinalized, false);
});
