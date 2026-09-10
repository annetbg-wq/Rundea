import type { Pool } from "pg";
import type { OperationActor } from "./operation-actor";
import { PostgresOperationAuditRecorder, type OperationAuditRecorder } from "./operation-audit";
import { executeAuthorizedOperation, type OperationExecutionResult } from "./operation-execution";
import { getOperationDefinition, type OperationName } from "./operation-registry";
import { executeNodeQualificationsReadOperation } from "./node-qualification-operations";
import { executeRuntimeMetricsReadOperation } from "./runtime-metric-operations";

export type McpReadonlyToolName =
  | "rundea_deployment_metrics_read"
  | "rundea_node_qualifications_read";

export type McpReadonlyToolDefinition = Readonly<{
  name: McpReadonlyToolName;
  operationName: OperationName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>;

export const readonlyMcpTools = [
  {
    name: "rundea_deployment_metrics_read",
    operationName: "deployment.metrics.read",
    description: "Read bounded runtime metrics for one Rundea deployment.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["deploymentId"],
      properties: {
        deploymentId: { type: "string", description: "Rundea deployment UUID." },
        minutes: { type: "integer", minimum: 5, maximum: 2880, default: 60 },
      },
    },
  },
  {
    name: "rundea_node_qualifications_read",
    operationName: "node.qualifications.read",
    description: "Read the latest bounded qualification results for one Rundea node.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["nodeId"],
      properties: {
        nodeId: { type: "string", description: "Rundea node UUID." },
      },
    },
  },
] as const satisfies readonly McpReadonlyToolDefinition[];

for (const tool of readonlyMcpTools) {
  const operation = getOperationDefinition(tool.operationName);
  if (operation.riskClass !== "READ_ONLY" || operation.mutation || operation.approval !== "none") {
    throw new Error(`MCP read-only catalog cannot expose mutating operation ${tool.operationName}`);
  }
}

export class McpReadonlyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpReadonlyInputError";
  }
}

export type McpReadonlyOperations = Readonly<{
  readDeploymentMetrics(input: { deploymentId: string; minutes?: unknown }): Promise<unknown>;
  readNodeQualifications(nodeId: string): Promise<unknown>;
}>;

export type McpReadonlyDependencies = Readonly<{
  audit: OperationAuditRecorder;
  operations: McpReadonlyOperations;
  actorProvider?: () => OperationActor | undefined;
}>;

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpReadonlyInputError("tool input must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new McpReadonlyInputError(`unexpected tool input field: ${key}`);
  }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\r\n\u0000]/.test(value)) {
    throw new McpReadonlyInputError(`${key} must be a bounded string`);
  }
  return value;
}

function metricsInput(value: unknown): { deploymentId: string; minutes?: unknown } {
  const input = objectInput(value);
  exactKeys(input, ["deploymentId", "minutes"]);
  const deploymentId = requiredString(input, "deploymentId");
  return input.minutes === undefined ? { deploymentId } : { deploymentId, minutes: input.minutes };
}

function nodeInput(value: unknown): { nodeId: string } {
  const input = objectInput(value);
  exactKeys(input, ["nodeId"]);
  return { nodeId: requiredString(input, "nodeId") };
}

function neverResolveApproval(): Promise<null> {
  throw new Error("READ_ONLY MCP operation attempted to resolve approval state");
}

function neverConsumeApproval(): Promise<boolean> {
  throw new Error("READ_ONLY MCP operation attempted to consume approval state");
}

export async function executeReadonlyMcpTool(
  dependencies: McpReadonlyDependencies,
  toolName: McpReadonlyToolName,
  rawInput: unknown,
): Promise<OperationExecutionResult<unknown>> {
  const actor = dependencies.actorProvider?.();

  if (toolName === "rundea_deployment_metrics_read") {
    const input = metricsInput(rawInput);
    return executeAuthorizedOperation(
      {
        operationName: "deployment.metrics.read",
        client: "MCP",
        resourceId: `deployment:${input.deploymentId}`,
        actor,
      },
      neverResolveApproval,
      neverConsumeApproval,
      dependencies.audit,
      async () => dependencies.operations.readDeploymentMetrics(input),
    );
  }

  if (toolName === "rundea_node_qualifications_read") {
    const input = nodeInput(rawInput);
    return executeAuthorizedOperation(
      {
        operationName: "node.qualifications.read",
        client: "MCP",
        resourceId: `node:${input.nodeId}`,
        actor,
      },
      neverResolveApproval,
      neverConsumeApproval,
      dependencies.audit,
      async () => dependencies.operations.readNodeQualifications(input.nodeId),
    );
  }

  const exhaustive: never = toolName;
  throw new McpReadonlyInputError(`unknown MCP tool: ${String(exhaustive)}`);
}

export function createPostgresReadonlyMcpDependencies(
  pool: Pool,
  actorProvider?: () => OperationActor | undefined,
): McpReadonlyDependencies {
  return {
    audit: new PostgresOperationAuditRecorder(pool),
    operations: {
      readDeploymentMetrics: async (input) => executeRuntimeMetricsReadOperation(pool, input),
      readNodeQualifications: async (nodeId) => executeNodeQualificationsReadOperation(pool, nodeId),
    },
    actorProvider,
  };
}
