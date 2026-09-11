import assert from "node:assert/strict";
import test from "node:test";
import { getOperationDefinition, operationRegistry } from "./operation-registry";

test("GitHub source discovery is a read-only source operation", () => {
  const definition = getOperationDefinition("source.github.discover");
  assert.equal(definition.riskClass, "READ_ONLY");
  assert.equal(definition.resource, "source");
  assert.equal(definition.mutation, false);
  assert.equal(definition.approval, "none");
});

test("runtime metrics are a read-only operation", () => {
  const definition = getOperationDefinition("deployment.metrics.read");
  assert.equal(definition.name, "deployment.metrics.read");
  assert.equal(definition.riskClass, "READ_ONLY");
  assert.equal(definition.mutation, false);
  assert.equal(definition.approval, "none");
  assert.equal(definition.verification, "none");
});

test("node qualification history is a read-only node operation", () => {
  const definition = getOperationDefinition("node.qualifications.read");
  assert.equal(definition.riskClass, "READ_ONLY");
  assert.equal(definition.resource, "node");
  assert.equal(definition.mutation, false);
  assert.equal(definition.approval, "none");
});

test("service variable metadata is read-only", () => {
  const definition = getOperationDefinition("service.variables.read");
  assert.equal(definition.riskClass, "READ_ONLY");
  assert.equal(definition.resource, "service");
  assert.equal(definition.mutation, false);
  assert.equal(definition.approval, "none");
});

test("service variable upsert is a policy-controlled safe write", () => {
  const definition = getOperationDefinition("service.variables.upsert");
  assert.equal(definition.riskClass, "SAFE_WRITE");
  assert.equal(definition.resource, "service");
  assert.equal(definition.mutation, true);
  assert.equal(definition.approval, "session-policy");
});

test("service variable deletion is a sensitive write", () => {
  const definition = getOperationDefinition("service.variable.delete");
  assert.equal(definition.riskClass, "SENSITIVE_WRITE");
  assert.equal(definition.resource, "service");
  assert.equal(definition.mutation, true);
  assert.equal(definition.approval, "explicit-or-policy");
});

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
