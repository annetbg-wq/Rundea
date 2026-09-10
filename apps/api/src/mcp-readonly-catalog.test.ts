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

const oauthActor = {
  authenticationMethod: "OAUTH" as const,
  issuer: "https://auth.rundea.test",
  subject: "user-42",
  scopes: ["rundea:mcp:diagnostics:read"],
};

const deploymentId = "123e4567-e89b-42d3-a456-426614174000";
const nodeId = "223e4567-e89b-42d3-a456-426614174000";

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

test("non-OAuth MCP path still goes through policy and audit before the typed operation", async () => {
  const { audit, calls, deps } = dependencies();
  const result = await executeReadonlyMcpTool(
    deps,
    "rundea_deployment_metrics_read",
    { deploymentId, minutes: 30 },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    name: "deployment.metrics.read",
    input: { deploymentId, minutes: 30 },
  }]);
  assert.match(audit.events[0] ?? "", /^AUTHORIZED:deployment\.metrics\.read:deployment:/);
  assert.match(audit.events[1] ?? "", /^SUCCEEDED:/);
  assert.equal(audit.starts[0]?.actor, null);
});

test("OAuth actor with an exact resource grant reaches the typed operation and audit", async () => {
  const { audit, calls, deps } = dependencies();
  const accessRequests: unknown[] = [];
  const actorDeps: McpReadonlyDependencies = {
    ...deps,
    actorProvider: () => oauthActor,
    resourceAccess: async (request) => {
      accessRequests.push(request);
      return true;
    },
  };

  const result = await executeReadonlyMcpTool(
    actorDeps,
    "rundea_deployment_metrics_read",
    { deploymentId },
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(audit.starts[0]?.actor, oauthActor);
  assert.deepEqual(accessRequests, [{
    actor: oauthActor,
    resourceKind: "DEPLOYMENT",
    resourceId: deploymentId,
    permission: "DIAGNOSTICS_READ",
  }]);
});

test("OAuth actor without a resource grant is denied and the typed operation is never called", async () => {
  const { audit, calls, deps } = dependencies();
  const actorDeps: McpReadonlyDependencies = {
    ...deps,
    actorProvider: () => oauthActor,
    resourceAccess: async () => false,
  };

  const result = await executeReadonlyMcpTool(
    actorDeps,
    "rundea_node_qualifications_read",
    { nodeId },
  );

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.match(audit.events[0] ?? "", /^DENIED:node\.qualifications\.read:node:/);
  assert.deepEqual(audit.starts[0]?.actor, oauthActor);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_NOT_AUTHORIZED");
    assert.equal(result.error.message, "authenticated actor is not authorized for operation resource");
  }
});

test("OAuth resource access fails closed when no resolver is wired", async () => {
  const { calls, deps } = dependencies();
  const result = await executeReadonlyMcpTool(
    { ...deps, actorProvider: () => oauthActor },
    "rundea_deployment_metrics_read",
    { deploymentId },
  );
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("OAuth resource access fails closed when the grant resolver is unavailable", async () => {
  const { calls, deps } = dependencies();
  const result = await executeReadonlyMcpTool(
    {
      ...deps,
      actorProvider: () => oauthActor,
      resourceAccess: async () => { throw new Error("database unavailable"); },
    },
    "rundea_deployment_metrics_read",
    { deploymentId },
  );
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("node qualification MCP tool delegates to the existing typed operation without OAuth actor", async () => {
  const { audit, calls, deps } = dependencies();
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
      { deploymentId, shell: "unexpected" },
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
    { deploymentId },
  );
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  if (!result.ok) {
    assert.equal(result.error.code, "OPERATION_FAILED");
    assert.equal(result.error.message, "operation execution failed");
  }
});
