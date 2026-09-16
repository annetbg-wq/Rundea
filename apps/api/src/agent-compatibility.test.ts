import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentHello } from "./agent-compatibility";

const compatible = {
  type: "hello" as const,
  agentVersion: "0.1.10",
  buildSha: "a".repeat(40),
  capabilities: [
    "runtimeMetrics",
    "managedIngress",
    "nodeCapacity",
    "nodeDiskMetrics",
    "persistentVolumes",
    "continuousHealth",
    "buildArgs",
    "buildGuardrails",
    "resourceGuardrails",
    "artifactRetention",
    "safePromotion",
  ],
};

test("accepts immutable compatible Agent and sorts capabilities", () => {
  const identity = validateAgentHello(compatible, "staging");
  assert.equal(identity.agentVersion, "0.1.10");
  assert.equal(identity.buildSha, "a".repeat(40));
  assert.deepEqual(identity.capabilities, [
    "artifactRetention",
    "buildArgs",
    "buildGuardrails",
    "continuousHealth",
    "managedIngress",
    "nodeCapacity",
    "nodeDiskMetrics",
    "persistentVolumes",
    "resourceGuardrails",
    "runtimeMetrics",
    "safePromotion",
  ]);
});

test("allows explicit development build only in development", () => {
  const identity = validateAgentHello({ ...compatible, buildSha: "development" }, "development");
  assert.equal(identity.buildSha, "development");
  assert.throws(
    () => validateAgentHello({ ...compatible, buildSha: "development" }, "staging"),
    /immutable 40-character build SHA/,
  );
});

test("rejects an Agent missing continuous health capability", () => {
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: compatible.capabilities.filter((value) => value !== "continuousHealth") }, "production"),
    /continuousHealth/,
  );
});

test("rejects an Agent missing node disk metrics capability", () => {
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: compatible.capabilities.filter((value) => value !== "nodeDiskMetrics") }, "production"),
    /nodeDiskMetrics/,
  );
});

test("rejects an Agent missing persistent volume capability", () => {
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: compatible.capabilities.filter((value) => value !== "persistentVolumes") }, "production"),
    /persistentVolumes/,
  );
});

test("rejects malformed or duplicate capabilities", () => {
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: [...compatible.capabilities, "bad value"] }, "staging"),
    /invalid capability/,
  );
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: [...compatible.capabilities, "runtimeMetrics"] }, "staging"),
    /duplicate capabilities/,
  );
});