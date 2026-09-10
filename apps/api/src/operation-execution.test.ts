import assert from "node:assert/strict";
import test from "node:test";
import type { OperationAuditRecorder, OperationAuditStart, OperationAuditOutcome } from "./operation-audit";
import { executeAuthorizedOperation } from "./operation-execution";
import type { ApprovalEvidence } from "./operation-policy";

const now = new Date("2026-09-10T12:00:00.000Z");
const resourceId = "service:backend";
const approvalRef = "approval:raw-secret-ref";
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
  readonly starts: OperationAuditStart[] = [];
  failBegin = false;
  failComplete = false;

  async recordDenied(entry: OperationAuditStart): Promise<void> {
    this.starts.push(entry);
    this.events.push(`DENIED:${entry.correlationId}`);
  }

  async beginAuthorized(entry: OperationAuditStart): Promise<void> {
    if (this.failBegin) throw new Error("audit unavailable");
    this.starts.push(entry);
    this.events.push(`AUTHORIZED:${entry.correlationId}`);
  }

  async complete(correlationId: string, outcome: OperationAuditOutcome, errorCode?: "APPROVAL_UNAVAILABLE" | "OPERATION_FAILED"): Promise<void> {
    if (this.failComplete) throw new Error("audit completion unavailable");
    this.events.push(`${outcome}:${errorCode ?? "NONE"}:${correlationId}`);
  }
}

const resolveSession = async (ref: string): Promise<ApprovalEvidence | null> => ref === approvalRef ? humanSession : null;
const consume = async (): Promise<boolean> => true;

test("denied operation never consumes approval or invokes executor", async () => {
  let consumptions = 0;
  let executions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId },
    async () => null,
    async () => { consumptions += 1; return true; },
    audit,
    async () => { executions += 1; return { changed: true }; },
    now,
  );
  assert.equal(result.ok, false);
  assert.equal(consumptions, 0);
  assert.equal(executions, 0);
  assert.equal(audit.events.length, 1);
  if (!result.ok) assert.equal(result.error.code, "OPERATION_NOT_AUTHORIZED");
});

test("audit start failure blocks write before approval consumption", async () => {
  let consumptions = 0;
  let executions = 0;
  const audit = new MemoryAudit();
  audit.failBegin = true;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef },
    resolveSession,
    async () => { consumptions += 1; return true; },
    audit,
    async () => { executions += 1; return { changed: true }; },
    now,
  );
  assert.equal(consumptions, 0);
  assert.equal(executions, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "AUDIT_UNAVAILABLE");
});

test("read-only operation remains available when audit is down and never consumes approval", async () => {
  let resolverCalls = 0;
  let consumptions = 0;
  let executions = 0;
  const audit = new MemoryAudit();
  audit.failBegin = true;
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId },
    async () => { resolverCalls += 1; return humanSession; },
    async () => { consumptions += 1; return true; },
    audit,
    async () => { executions += 1; return { variables: [] }; },
    now,
  );
  assert.equal(result.ok, true);
  assert.equal(resolverCalls, 0);
  assert.equal(consumptions, 0);
  assert.equal(executions, 1);
  if (result.ok) assert.equal(result.auditFinalized, false);
});

test("authorized write is audited, consumed once, then executed", async () => {
  const timeline: string[] = [];
  const audit = new MemoryAudit();
  audit.beginAuthorized = async (entry) => {
    audit.starts.push(entry);
    timeline.push("AUDIT_BEGIN");
  };
  audit.complete = async (_id, outcome) => { timeline.push(`AUDIT_${outcome}`); };
  let consumedRef = "";
  let executions = 0;

  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef },
    resolveSession,
    async (ref) => {
      consumedRef = ref;
      timeline.push("CONSUME");
      return true;
    },
    audit,
    async (context) => {
      executions += 1;
      timeline.push("EXECUTE");
      assert.equal("approvalRef" in context, false);
      return { updated: ["API_TOKEN"] };
    },
    now,
  );

  assert.equal(result.ok, true);
  assert.equal(consumedRef, approvalRef);
  assert.equal(executions, 1);
  assert.deepEqual(timeline, ["AUDIT_BEGIN", "CONSUME", "EXECUTE", "AUDIT_SUCCEEDED"]);
  assert.equal(audit.starts.length, 1);
  assert.match(audit.starts[0]?.approvalRefHash ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(audit.starts[0]?.approvalRefHash, approvalRef);
  assert.equal(JSON.stringify(audit.starts).includes(approvalRef), false);
});

test("exhausted or concurrently consumed approval blocks executor", async () => {
  let executions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef },
    resolveSession,
    async () => false,
    audit,
    async () => { executions += 1; return { changed: true }; },
    now,
  );
  assert.equal(executions, 0);
  assert.equal(result.ok, false);
  assert.match(audit.events[1] ?? "", /^FAILED:APPROVAL_UNAVAILABLE:/);
  if (!result.ok) {
    assert.equal(result.error.code, "APPROVAL_UNAVAILABLE");
    assert.equal(result.error.message, "operation approval is unavailable");
  }
});

test("approval consumer exception is sanitized and blocks executor", async () => {
  const secret = "consumer-database-secret";
  let executions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "API", resourceId, approvalRef },
    resolveSession,
    async () => { throw new Error(secret); },
    audit,
    async () => { executions += 1; return { changed: true }; },
    now,
  );
  assert.equal(executions, 0);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  if (!result.ok) assert.equal(result.error.code, "APPROVAL_UNAVAILABLE");
});

test("read-only operation enters audit when available and skips resolver and consumer", async () => {
  let resolverCalls = 0;
  let consumptions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId },
    async () => { resolverCalls += 1; return humanSession; },
    async () => { consumptions += 1; return true; },
    audit,
    async () => ({ variables: [] }),
    now,
  );
  assert.equal(result.ok, true);
  assert.equal(resolverCalls, 0);
  assert.equal(consumptions, 0);
  assert.match(audit.events[0] ?? "", /^AUTHORIZED:/);
  assert.match(audit.events[1] ?? "", /^SUCCEEDED:NONE:/);
});

test("executor exception is sanitized and failure is audited after consumption", async () => {
  const secret = "do-not-leak-this-secret";
  let consumptions = 0;
  const audit = new MemoryAudit();
  const result = await executeAuthorizedOperation(
    { operationName: "service.variables.upsert", client: "API", resourceId, approvalRef },
    resolveSession,
    async () => { consumptions += 1; return true; },
    audit,
    async () => { throw new Error(`database failed while handling ${secret}`); },
    now,
  );
  assert.equal(consumptions, 1);
  assert.equal(result.ok, false);
  assert.match(audit.events[1] ?? "", /^FAILED:OPERATION_FAILED:/);
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
    { operationName: "service.variables.upsert", client: "API", resourceId, approvalRef },
    resolveSession,
    consume,
    audit,
    async () => { executions += 1; return { updated: ["API_TOKEN"] }; },
    now,
  );
  assert.equal(executions, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.auditFinalized, false);
});
