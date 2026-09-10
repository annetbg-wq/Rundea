import assert from "node:assert/strict";
import test from "node:test";
import { hashToken } from "@rundea/crypto";
import type { OperationAuditOutcome, OperationAuditRecorder, OperationAuditStart } from "./operation-audit";
import type { McpReadonlyDependencies } from "./mcp-readonly-catalog";
import {
  createReadonlyMcpHandler,
  isReadonlyMcpBearerAuthorized,
  resolveReadonlyMcpHttpConfig,
} from "./mcp-http";

const controlToken = "control-token-that-is-long-enough-for-tests-0001";
const mcpToken = "mcp-token-that-is-distinct-and-long-enough-0002";
const deploymentId = "123e4567-e89b-42d3-a456-426614174000";
const nodeId = "223e4567-e89b-42d3-a456-426614174000";

class MemoryAudit implements OperationAuditRecorder {
  readonly events: string[] = [];

  async recordDenied(entry: OperationAuditStart): Promise<void> {
    this.events.push(`DENIED:${entry.operationName}`);
  }

  async beginAuthorized(entry: OperationAuditStart): Promise<void> {
    this.events.push(`AUTHORIZED:${entry.operationName}`);
  }

  async complete(correlationId: string, outcome: OperationAuditOutcome): Promise<void> {
    this.events.push(`${outcome}:${correlationId}`);
  }
}

function dependencies() {
  const audit = new MemoryAudit();
  const calls: Array<{ name: string; value: unknown }> = [];
  const deps: McpReadonlyDependencies = {
    audit,
    operations: {
      readDeploymentMetrics: async (input) => {
        calls.push({ name: "deployment.metrics.read", value: input });
        return { deploymentId: input.deploymentId, latest: null, points: [] };
      },
      readNodeQualifications: async (value) => {
        calls.push({ name: "node.qualifications.read", value });
        return { qualifications: [] };
      },
    },
  };
  return { audit, calls, deps };
}

function modernRequest(method: string, params: Record<string, unknown> = {}, toolName?: string): Request {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "rundea-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  };
  if (toolName) headers["mcp-name"] = toolName;
  return new Request("https://mcp.rundea.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: meta },
    }),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  return JSON.parse(text) as Record<string, any>;
}

test("MCP HTTP stays disabled when no MCP token is configured", () => {
  assert.equal(resolveReadonlyMcpHttpConfig({}, controlToken), null);
});

test("MCP HTTP requires explicit host allowlist and a distinct strong token", () => {
  assert.throws(
    () => resolveReadonlyMcpHttpConfig({ RUNDEA_MCP_TOKEN: mcpToken }, controlToken),
    /RUNDEA_MCP_ALLOWED_HOSTS is required/,
  );
  assert.throws(
    () => resolveReadonlyMcpHttpConfig({ RUNDEA_MCP_TOKEN: controlToken, RUNDEA_MCP_ALLOWED_HOSTS: "mcp.rundea.test" }, controlToken),
    /must be distinct/,
  );
  assert.throws(
    () => resolveReadonlyMcpHttpConfig({ RUNDEA_MCP_TOKEN: "short", RUNDEA_MCP_ALLOWED_HOSTS: "mcp.rundea.test" }, controlToken),
    /32-512/,
  );
});

test("MCP host/origin configuration is normalized and origin defaults to host allowlist", () => {
  const config = resolveReadonlyMcpHttpConfig({
    RUNDEA_MCP_TOKEN: mcpToken,
    RUNDEA_MCP_ALLOWED_HOSTS: "MCP.Rundea.Test,localhost",
  }, controlToken);
  assert.ok(config);
  assert.deepEqual(config.allowedHosts, ["mcp.rundea.test", "localhost"]);
  assert.deepEqual(config.allowedOrigins, ["mcp.rundea.test", "localhost"]);
});

test("MCP bearer authentication accepts only the configured token", () => {
  const expected = hashToken(mcpToken);
  assert.equal(isReadonlyMcpBearerAuthorized(`Bearer ${mcpToken}`, expected), true);
  assert.equal(isReadonlyMcpBearerAuthorized(`bearer ${mcpToken}`, expected), true);
  assert.equal(isReadonlyMcpBearerAuthorized(`Bearer wrong-token-that-is-also-long-enough-9999`, expected), false);
  assert.equal(isReadonlyMcpBearerAuthorized(undefined, expected), false);
});

test("official modern MCP tools/list exposes exactly the two diagnostic tools", async () => {
  const { deps } = dependencies();
  const handler = createReadonlyMcpHandler(deps);
  try {
    const response = await handler.fetch(modernRequest("tools/list"));
    assert.equal(response.status, 200);
    const body = await json(response);
    const tools = body.result?.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "rundea_deployment_metrics_read",
      "rundea_node_qualifications_read",
    ]);
    assert.equal(tools.every((tool) => tool.annotations?.readOnlyHint === true), true);
    assert.equal(JSON.stringify(tools).includes("service.variables"), false);
  } finally {
    await handler.close();
  }
});

test("official modern MCP tools/call reaches the shared read-only operation gateway", async () => {
  const { audit, calls, deps } = dependencies();
  const handler = createReadonlyMcpHandler(deps);
  try {
    const response = await handler.fetch(modernRequest(
      "tools/call",
      { name: "rundea_deployment_metrics_read", arguments: { deploymentId, minutes: 30 } },
      "rundea_deployment_metrics_read",
    ));
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.result?.isError ?? false, false);
    assert.deepEqual(calls, [{
      name: "deployment.metrics.read",
      value: { deploymentId, minutes: 30 },
    }]);
    assert.match(audit.events[0] ?? "", /^AUTHORIZED:deployment\.metrics\.read$/);
    assert.match(audit.events[1] ?? "", /^SUCCEEDED:/);
  } finally {
    await handler.close();
  }
});

test("strict MCP input schema rejects unexpected fields before a typed operation runs", async () => {
  const { calls, deps } = dependencies();
  const handler = createReadonlyMcpHandler(deps);
  try {
    const response = await handler.fetch(modernRequest(
      "tools/call",
      {
        name: "rundea_node_qualifications_read",
        arguments: { nodeId, shell: "cat /etc/passwd" },
      },
      "rundea_node_qualifications_read",
    ));
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.result?.isError, true);
    assert.equal(calls.length, 0);
  } finally {
    await handler.close();
  }
});
