import type { FastifyInstance } from "fastify";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { equalTokenHash, hashToken } from "@rundea/crypto";
import type { Pool } from "pg";
import * as z from "zod/v4";
import {
  createPostgresReadonlyMcpDependencies,
  executeReadonlyMcpTool,
  type McpReadonlyDependencies,
} from "./mcp-readonly-catalog";
import type { OperationExecutionResult } from "./operation-execution";

const maxMcpTokenLength = 512;
const minMcpTokenLength = 32;
const maxMcpRequestBodyBytes = 256 * 1024;
const maxToolResponseBytes = 512 * 1024;
const maxAllowedHostnames = 64;

export type ReadonlyMcpHttpConfig = Readonly<{
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;

export type ReadonlyMcpHttpRegistration = Readonly<{
  close(): Promise<void>;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function parseAllowedHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  if (!hostname || hostname.length > 253) throw new Error("MCP allowed hostname is invalid");
  if (/^\[[0-9a-f:]+\]$/i.test(hostname)) return hostname;
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) {
    throw new Error("MCP allowed hostname is invalid");
  }
  return hostname;
}

function parseHostnameList(raw: string | undefined, name: string): string[] {
  if (!raw?.trim()) throw new Error(`${name} is required when RUNDEA_MCP_TOKEN is configured`);
  const items = raw.split(",").map(parseAllowedHostname);
  if (items.length < 1 || items.length > maxAllowedHostnames) throw new Error(`${name} contains too many entries`);
  if (new Set(items).size !== items.length) throw new Error(`${name} contains duplicate hostnames`);
  return items;
}

export function resolveReadonlyMcpHttpConfig(
  env: Environment,
  controlToken: string,
): ReadonlyMcpHttpConfig | null {
  const token = env.RUNDEA_MCP_TOKEN?.trim();
  if (!token) return null;
  if (token.length < minMcpTokenLength || token.length > maxMcpTokenLength || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new Error(`RUNDEA_MCP_TOKEN must contain ${minMcpTokenLength}-${maxMcpTokenLength} non-whitespace safe characters`);
  }
  if (equalTokenHash(hashToken(token), hashToken(controlToken))) {
    throw new Error("RUNDEA_MCP_TOKEN must be distinct from RUNDEA_CONTROL_TOKEN");
  }
  const allowedHosts = parseHostnameList(env.RUNDEA_MCP_ALLOWED_HOSTS, "RUNDEA_MCP_ALLOWED_HOSTS");
  const allowedOrigins = env.RUNDEA_MCP_ALLOWED_ORIGINS?.trim()
    ? parseHostnameList(env.RUNDEA_MCP_ALLOWED_ORIGINS, "RUNDEA_MCP_ALLOWED_ORIGINS")
    : [...allowedHosts];
  return { token, allowedHosts, allowedOrigins };
}

function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function isReadonlyMcpBearerAuthorized(header: string | undefined, expectedTokenHash: string): boolean {
  const token = bearer(header);
  if (!token || token.length > maxMcpTokenLength) return false;
  return equalTokenHash(hashToken(token), expectedTokenHash);
}

function safeToolResult(result: OperationExecutionResult<unknown>) {
  if (!result.ok) {
    const body = {
      ok: false,
      correlationId: result.correlationId,
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(result.result);
  } catch {
    serialized = "";
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > maxToolResponseBytes) {
    const body = {
      ok: false,
      correlationId: result.correlationId,
      error: { code: "MCP_RESULT_UNAVAILABLE", message: "tool result could not be safely returned" },
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }

  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: result.result,
  };
}

export function createReadonlyMcpServer(dependencies: McpReadonlyDependencies): McpServer {
  const server = new McpServer({
    name: "rundea",
    title: "Rundea",
    version: "0.1.0",
    description: "Read-only diagnostic access to the Rundea infrastructure control plane.",
  });

  server.registerTool(
    "rundea_deployment_metrics_read",
    {
      title: "Read deployment metrics",
      description: "Read bounded runtime metrics for one Rundea deployment. This tool never changes infrastructure.",
      inputSchema: z.strictObject({
        deploymentId: z.string().uuid(),
        minutes: z.number().int().min(5).max(2880).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolResult(await executeReadonlyMcpTool(dependencies, "rundea_deployment_metrics_read", input)),
  );

  server.registerTool(
    "rundea_node_qualifications_read",
    {
      title: "Read node qualifications",
      description: "Read recent bounded qualification results for one Rundea node. This tool never changes infrastructure.",
      inputSchema: z.strictObject({ nodeId: z.string().uuid() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safeToolResult(await executeReadonlyMcpTool(dependencies, "rundea_node_qualifications_read", input)),
  );

  return server;
}

export function createReadonlyMcpHandler(dependencies: McpReadonlyDependencies) {
  return createMcpHandler(() => createReadonlyMcpServer(dependencies), {
    onerror: () => undefined,
  });
}

export function registerReadonlyMcpHttp(
  app: FastifyInstance,
  pool: Pool,
  config: ReadonlyMcpHttpConfig,
): ReadonlyMcpHttpRegistration {
  const expectedTokenHash = hashToken(config.token);
  const dependencies = createPostgresReadonlyMcpDependencies(pool);
  const handler = createMcpHandler(() => createReadonlyMcpServer(dependencies), {
    onerror: (error) => app.log.error({ err: error }, "MCP protocol handler failed"),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => app.log.error({ err: error }, "MCP HTTP adapter failed"),
  });
  const validateHost = hostHeaderValidation([...config.allowedHosts]);
  const validateOrigin = originValidation([...config.allowedOrigins]);

  app.all("/mcp", { bodyLimit: maxMcpRequestBodyBytes }, async (request, reply) => {
    if (!isReadonlyMcpBearerAuthorized(request.headers.authorization, expectedTokenHash)) {
      reply.header("WWW-Authenticate", 'Bearer realm="rundea-mcp"');
      return reply.code(401).send({ error: "unauthorized" });
    }

    reply.hijack();
    if (!validateHost(request.raw, reply.raw)) return;
    if (!validateOrigin(request.raw, reply.raw)) return;
    await nodeHandler(request.raw, reply.raw, request.body);
  });

  return { close: () => handler.close() };
}
