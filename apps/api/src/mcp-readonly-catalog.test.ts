import assert from "node:assert/strict";
import test from "node:test";
import type { OperationAuditOutcome, OperationAuditRecorder, OperationAuditStart } from "./operation-audit";
import { getOperationDefinition } from "./operation-registry";
import {
  executeReadonlyMcpTool,
  McpReadonlyInputError,
  readonlyMcpTools,
  type McpReadonlyDependencies,
} from "./mcp-readonly-catalog";

class MemoryAudit implements OperationAuditRecorder {
  readonly events: string[] = [];
  readonly starts: OperationAuditStart[] = [];

  async recordDenied(entry: OperationAuditStart): Promise<void> {
    this.starts.push(entry);
    this.events.push(`DENIED:${entry.operationName}:${entry.resourceId}`);
  }

  async beginAuthorized(entry: OperationAuditStart): Promise<void> {
    this.starts.push(entry);
    this.events.push(`AUTHORIZED:${entry.operationName}:${entry.resourceId}`);
  }

  async complete(correlationId: string, outcome: OperationAuditOutcome): Promise<void> {
    this.events.push(`${outcome}:${correlationId}`);
  }
}

function dependencies() {
  const audit = new MemoryAudit();
  const calls: Array<{ name: string; input: unknown }> = [];
  const deps: McpReadonlyDependencies = {
    audit,
    operations: {
      readDeploymentMetrics: async (input) => {
        calls.push({ name: "deployment.metrics.read", input });
        return { deploymentId: input.deploymentId, points: [] };
      },
      readNodeQualifications: async (nodeId) => {
        calls.push({ name: "node.qualifications.read", input: nodeId });
        return { qualifications: [] };
      },
    },
  };
  return { audit, calls, deps };
}

test("initial MCP catalog exposes only two diagnostic read-only operations", () => {
  assert.deepEqual(
    readonlyMcpTools.map((tool) => tool.name),
    ["rundea_deployment_metrics_read", "rundea_node_qualifications_read"],
  );
  for (const tool of readonlyMcpTools) {
    const operation = getOperationDefinition(tool.operationName);
    assert.equal(operation.riskClass, "READ_ONLY");
    assert.equal(operation.mutation, false);
    assert.equal(operation.approval, "none");
  }
  const exposedOperations: readonly string[] = readonlyMcpTools.map((tool) => tool.operationName);
  assert.equal(exposedOperations.includes("service.variables.read"), false);
});

test("deployment metrics MCP tool goes through policy and audit before the typed operation", async () => {
  const { audit, calls, deps } = dependencies();
  const result = await executeReadonlyMcpTool(
    deps,
    "rundea_deployment_metrics_read",
    { deploymentId: "123e4567-e89b-42d3-a456-426614174000", minutes: 30 },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    name: "deployment.metrics.read",
    input: { deploymentId: "123e4567-e89b-42d3-a456-426614174000", minutes: 30 },
  });
  assert.match(audit.events[0] ?? "", /^AUTHORIZED:deployment\.metrics\.read:deployment:/);
  assert.match(audit.events[1] ?? "", /^SUCCEEDED:/);
  assert.equal(audit.starts[0]?.actor, null);
});

test("authenticated MCP actor is transport context, not tool input, and reaches audit", async () => {
  const { audit, deps } = dependencies();
  const actor = {
    authenticationMethod: "OAUTH" as const,
    issuer: "https://auth.rundea.test",
    subject: "user-42",
    scopes: ["rundea:mcp:diagnostics:read"],
  };
  const actorDeps: McpReadonlyDependencies = { ...deps, actorProvider: () => actor };

  const result = await executeReadonlyMcpTool(
    actorDeps,
    "rundea_deployment_metrics_read",
    { deploymentId: "123e4567-e89b-42d3-a456-426614174000" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(audit.starts[0]?.actor, actor);
});

test("node qualification MCP tool delegates to the existing typed operation", async () => {
  const { audit, calls, deps } = dependencies();
  const nodeId = "123e4567-e89b-42d3-a456-426614174000";
  const result = await executeReadonlyMcpTool(
    deps,
    "rundea_node_qualifications_read",
    { nodeId },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ name: "node.qualifications.read", input: nodeId }]);
  assert.match(audit.events[0] ?? "", /^AUTHORIZED:node\.qualifications\.read:node:/);
});

test("MCP adapter rejects extra fields before touching an operation", async () => {
  const { calls, deps } = dependencies();
  await assert.rejects(
    executeReadonlyMcpTool(
      deps,
      "rundea_deployment_metrics_read",
      {
        deploymentId: "123e4567-e89b-42d3-a456-426614174000",
        shell: "cat /etc/passwd",
      },
    ),
    McpReadonlyInputError,
  );
  assert.equal(calls.length, 0);
});

test("MCP adapter rejects malformed resource ids before touching an operation", async () => {
  const { calls, deps } = dependencies();
  await assert.rejects(
    executeReadonlyMcpTool(
      deps,
      "rundea_node_qualifications_read",
      { nodeId: "bad\nnode" },
    ),
    McpReadonlyInputError,
  );
  assert.equal(calls.length, 0);
});

test("typed operation failures are sanitized by the common execution gateway", async () => {
  const secret = "private-runtime-secret";
  const audit = new MemoryAudit();
  const deps: McpReadonlyDependencies = {
    audit,
    operations: {
      readDeploymentMetrics: async () => {
        throw new Error(`database failed with ${secret}`);
      },
      readNodeQualifications: async () => ({ qualifications: [] }),
    },
  };

  const result = await executeReadonlyMcpTool(
    deps,
    "rundea_deployment_metrics_read",
    { deploymentId: "123e4567-e89b-42d3-a456-426614174000" },
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_FAILED");
    assert.equal(result.error.message, "operation execution failed");
  }
});
