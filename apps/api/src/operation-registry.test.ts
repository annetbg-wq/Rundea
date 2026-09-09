import assert from "node:assert/strict";
import test from "node:test";
import { getOperationDefinition, operationRegistry } from "./operation-registry";

test("runtime operation registry classifies restart as safe write", () => {
  const definition = getOperationDefinition("deployment.restart");
  assert.equal(definition.name, "deployment.restart");
  assert.equal(definition.riskClass, "SAFE_WRITE");
  assert.equal(definition.mutation, true);
  assert.equal(definition.verification, "runtime-health");
});

test("runtime operation registry escalates rollback above restart", () => {
  const definition = getOperationDefinition("deployment.rollback");
  assert.equal(definition.riskClass, "SENSITIVE_WRITE");
  assert.equal(definition.approval, "explicit-or-policy");
});

test("operation definitions keep canonical names equal to registry keys", () => {
  for (const [name, definition] of Object.entries(operationRegistry)) {
    assert.equal(definition.name, name);
  }
});
