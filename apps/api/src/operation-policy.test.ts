import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOperationPolicy, type ApprovalEvidence } from "./operation-policy";

const now = new Date("2026-09-10T12:00:00.000Z");
const resourceId = "service:backend";

function session(overrides: Partial<Extract<ApprovalEvidence, { kind: "SESSION_POLICY" }>> = {}): ApprovalEvidence {
  return {
    kind: "SESSION_POLICY",
    policyId: "policy-1",
    approvedBy: "HUMAN",
    expiresAt: "2026-09-10T13:00:00.000Z",
    operationNames: ["service.variables.upsert"],
    resourceIds: [resourceId],
    ...overrides,
  };
}

function explicit(overrides: Partial<Extract<ApprovalEvidence, { kind: "EXPLICIT" }>> = {}): ApprovalEvidence {
  return {
    kind: "EXPLICIT",
    approvalId: "approval-1",
    approvedBy: "HUMAN",
    operationName: "service.variable.delete",
    resourceId,
    issuedAt: "2026-09-10T11:59:00.000Z",
    expiresAt: "2026-09-10T12:05:00.000Z",
    ...overrides,
  };
}

test("read-only MCP operation needs no mutation approval", () => {
  const result = evaluateOperationPolicy({
    operationName: "service.variables.read",
    client: "MCP",
    resourceId,
    now,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.effectiveRiskClass, "READ_ONLY");
  assert.equal(result.requiredApproval, "NONE");
});

test("safe write requires an exact human session policy or explicit approval", () => {
  const denied = evaluateOperationPolicy({
    operationName: "service.variables.upsert",
    client: "MCP",
    resourceId,
    now,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.requiredApproval, "SESSION_OR_EXPLICIT");

  const allowed = evaluateOperationPolicy({
    operationName: "service.variables.upsert",
    client: "MCP",
    resourceId,
    approval: session(),
    now,
  });
  assert.equal(allowed.allowed, true);

  const wrongResource = evaluateOperationPolicy({
    operationName: "service.variables.upsert",
    client: "MCP",
    resourceId,
    approval: session({ resourceIds: ["service:other"] }),
    now,
  });
  assert.equal(wrongResource.allowed, false);
});

test("model-issued approval is never accepted as human approval", () => {
  const result = evaluateOperationPolicy({
    operationName: "service.variables.upsert",
    client: "RUNDEA_AI",
    resourceId,
    approval: session({ approvedBy: "MODEL" }),
    now,
  });
  assert.equal(result.allowed, false);
});

test("sensitive write needs explicit approval or a narrow policy that permits sensitive writes", () => {
  const denied = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "MCP",
    resourceId,
    approval: session({ operationNames: ["service.variable.delete"] }),
    now,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.requiredApproval, "EXPLICIT_OR_NARROW_POLICY");

  const allowedByNarrowPolicy = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "MCP",
    resourceId,
    approval: session({ operationNames: ["service.variable.delete"], allowSensitive: true }),
    now,
  });
  assert.equal(allowedByNarrowPolicy.allowed, true);

  const allowedExplicitly = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "MCP",
    resourceId,
    approval: explicit(),
    now,
  });
  assert.equal(allowedExplicitly.allowed, true);
});

test("context can only escalate operation risk, never downgrade it", () => {
  const escalated = evaluateOperationPolicy({
    operationName: "service.variables.upsert",
    client: "API",
    resourceId,
    contextualRiskClass: "SENSITIVE_WRITE",
    approval: session(),
    now,
  });
  assert.equal(escalated.baseRiskClass, "SAFE_WRITE");
  assert.equal(escalated.effectiveRiskClass, "SENSITIVE_WRITE");
  assert.equal(escalated.allowed, false);

  const cannotDowngrade = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "API",
    resourceId,
    contextualRiskClass: "READ_ONLY",
    approval: { kind: "NONE" },
    now,
  });
  assert.equal(cannotDowngrade.effectiveRiskClass, "SENSITIVE_WRITE");
  assert.equal(cannotDowngrade.allowed, false);
});

test("destructive escalation accepts only fresh exact explicit human approval", () => {
  const sessionDenied = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "MCP",
    resourceId,
    contextualRiskClass: "DESTRUCTIVE",
    approval: session({ operationNames: ["service.variable.delete"], allowSensitive: true }),
    now,
  });
  assert.equal(sessionDenied.allowed, false);
  assert.equal(sessionDenied.requiredApproval, "FRESH_EXPLICIT");

  const modelDenied = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "RUNDEA_AI",
    resourceId,
    contextualRiskClass: "DESTRUCTIVE",
    approval: explicit({ approvedBy: "MODEL" }),
    now,
  });
  assert.equal(modelDenied.allowed, false);

  const staleDenied = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "MCP",
    resourceId,
    contextualRiskClass: "DESTRUCTIVE",
    approval: explicit({ issuedAt: "2026-09-10T11:50:00.000Z" }),
    now,
  });
  assert.equal(staleDenied.allowed, false);

  const freshAllowed = evaluateOperationPolicy({
    operationName: "service.variable.delete",
    client: "MCP",
    resourceId,
    contextualRiskClass: "DESTRUCTIVE",
    approval: explicit(),
    now,
  });
  assert.equal(freshAllowed.allowed, true);
});
