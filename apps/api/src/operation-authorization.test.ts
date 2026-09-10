import assert from "node:assert/strict";
import test from "node:test";
import { authorizeOperation, type ApprovalResolver } from "./operation-authorization";
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

function resolverFor(evidence: ApprovalEvidence | null, calls: string[] = []): ApprovalResolver {
  return async (ref) => {
    calls.push(ref);
    return evidence;
  };
}

test("read-only operation does not resolve or require approval evidence", async () => {
  const calls: string[] = [];
  const result = await authorizeOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId, approvalRef: "attacker-supplied-ref" },
    resolverFor(humanSession, calls),
    now,
  );
  assert.equal(result.decision.allowed, true);
  assert.equal(result.approvalRef, null);
  assert.equal(calls.length, 0);
  assert.match(result.correlationId, /^[0-9a-f-]{36}$/i);
});

test("write without approval reference is denied before resolver access", async () => {
  const calls: string[] = [];
  const result = await authorizeOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId },
    resolverFor(humanSession, calls),
    now,
  );
  assert.equal(result.decision.allowed, false);
  assert.equal(calls.length, 0);
});

test("malformed and unknown approval references cannot authorize a write", async () => {
  const malformedCalls: string[] = [];
  const malformed = await authorizeOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "bad ref with spaces" },
    resolverFor(humanSession, malformedCalls),
    now,
  );
  assert.equal(malformed.decision.allowed, false);
  assert.equal(malformedCalls.length, 0);

  const unknownCalls: string[] = [];
  const unknown = await authorizeOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "approval:missing" },
    resolverFor(null, unknownCalls),
    now,
  );
  assert.equal(unknown.decision.allowed, false);
  assert.deepEqual(unknownCalls, ["approval:missing"]);
  assert.match(unknown.decision.reason, /unknown or unavailable/);
});

test("approval resolver outage is a bounded denial, not an uncaught exception", async () => {
  const secret = "approval-database-secret";
  const result = await authorizeOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "approval:present" },
    async () => { throw new Error(secret); },
    now,
  );
  assert.equal(result.decision.allowed, false);
  assert.equal(result.approvalRef, "approval:present");
  assert.equal(result.decision.reason, "approval service is unavailable");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("only evidence returned by the server resolver reaches policy evaluation", async () => {
  const calls: string[] = [];
  const result = await authorizeOperation(
    { operationName: "service.variables.upsert", client: "MCP", resourceId, approvalRef: "policy:1" },
    resolverFor(humanSession, calls),
    now,
  );
  assert.equal(result.decision.allowed, true);
  assert.equal(result.approvalRef, "policy:1");
  assert.deepEqual(calls, ["policy:1"]);
});

test("server-resolved model approval is still rejected", async () => {
  const modelEvidence: ApprovalEvidence = { ...humanSession, approvedBy: "MODEL" };
  const result = await authorizeOperation(
    { operationName: "service.variables.upsert", client: "RUNDEA_AI", resourceId, approvalRef: "policy:model" },
    resolverFor(modelEvidence),
    now,
  );
  assert.equal(result.decision.allowed, false);
});

test("authorization rejects invalid resource scope before resolver access", async () => {
  const calls: string[] = [];
  const result = await authorizeOperation(
    { operationName: "service.variables.read", client: "MCP", resourceId: "bad\nresource", approvalRef: "policy:1" },
    resolverFor(humanSession, calls),
    now,
  );
  assert.equal(result.decision.allowed, false);
  assert.match(result.decision.reason, /invalid operation resource scope/);
  assert.equal(calls.length, 0);
});

test("correlation ids are server generated per authorization attempt", async () => {
  const resolver = resolverFor(null);
  const one = await authorizeOperation(
    { operationName: "service.variables.read", client: "API", resourceId },
    resolver,
    now,
  );
  const two = await authorizeOperation(
    { operationName: "service.variables.read", client: "API", resourceId },
    resolver,
    now,
  );
  assert.notEqual(one.correlationId, two.correlationId);
});
