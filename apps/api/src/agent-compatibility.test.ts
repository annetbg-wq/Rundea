import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentHello } from "./agent-compatibility";

const compatible = {
  type: "hello" as const,
  agentVersion: "0.1.5",
  buildSha: "a".repeat(40),
  capabilities: ["runtimeMetrics", "managedIngress", "buildArgs", "resourceGuardrails", "artifactRetention", "safePromotion"],
};

test("accepts immutable compatible Agent and sorts capabilities", () => {
  const identity = validateAgentHello(compatible, "staging");
  assert.equal(identity.agentVersion, "0.1.5");
  assert.equal(identity.buildSha, "a".repeat(40));
  assert.deepEqual(identity.capabilities, ["artifactRetention", "buildArgs", "managedIngress", "resourceGuardrails", "runtimeMetrics", "safePromotion"]);
});

test("allows explicit development build only in development", () => {
  const identity = validateAgentHello({ ...compatible, buildSha: "development" }, "development");
  assert.equal(identity.buildSha, "development");
  assert.throws(
    () => validateAgentHello({ ...compatible, buildSha: "development" }, "staging"),
    /immutable 40-character build SHA/,
  );
});

test("rejects an Agent missing a required capability", () => {
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: ["buildArgs", "managedIngress", "resourceGuardrails", "runtimeMetrics"] }, "production"),
    /artifactRetention/,
  );
});

test("rejects malformed or duplicate capabilities", () => {
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: ["artifactRetention", "buildArgs", "managedIngress", "resourceGuardrails", "runtimeMetrics", "bad value"] }, "staging"),
    /invalid capability/,
  );
  assert.throws(
    () => validateAgentHello({ ...compatible, capabilities: ["artifactRetention", "buildArgs", "managedIngress", "resourceGuardrails", "runtimeMetrics", "runtimeMetrics"] }, "staging"),
    /duplicate capabilities/,
  );
});
