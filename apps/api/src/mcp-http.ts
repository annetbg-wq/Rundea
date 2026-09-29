import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
import {
  createMcpOAuthTokenVerifier,
  McpOAuthAuthorizationError,
  oauthBearerChallenge,
  protectedResourceMetadata,
  resolveMcpOAuthConfig,
  type McpOAuthConfig,
} from "./mcp-oauth";
import { OperationActorContext, staticTokenOperationActor, type OperationActor } from "./operation-actor";
import {
  MCP_OPERATOR_SCOPE,
  registerBuiltinMcpOAuth,
  resolveBuiltinMcpOAuthConfig,
  verifyBuiltinMcpToken,
  type BuiltinMcpOAuthConfig,
} from "./mcp-builtin-oauth";
import type { OperationExecutionResult } from "./operation-execution";
import { registerStaticControlMcpTools, type McpControlHttpDependencies } from "./mcp-control-tools";

const maxMcpTokenLength = 512;
const minMcpTokenLength = 32;
const maxMcpRequestBodyBytes = 256 * 1024;
const maxToolResponseBytes = 512 * 1024;
const maxAllowedHostnames = 64;

export type StaticReadonlyMcpHttpConfig = Readonly<{
  authMode: "static";
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;

export type OAuthReadonlyMcpHttpConfig = Readonly<{
  authMode: "oauth";
  oauth: McpOAuthConfig;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;

export type BuiltinOAuthMcpHttpConfig = Readonly<{
  authMode: "oauth-builtin";
  oauth: McpOAuthConfig;
  builtin: BuiltinMcpOAuthConfig;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;

export type ReadonlyMcpHttpConfig = StaticReadonlyMcpHttpConfig | OAuthReadonlyMcpHttpConfig | BuiltinOAuthMcpHttpConfig;

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
  if (!raw?.trim()) throw new Error(`${name} is required when MCP HTTP is configured`);
  const items = raw.split(",").map(parseAllowedHostname);
  if (items.length < 1 || items.length > maxAllowedHostnames) throw new Error(`${name} contains too many entries`);
  if (new Set(items).size !== items.length) throw new Error(`${name} contains duplicate hostnames`);
  return items;
}

function oauthEnvironmentPresent(env: Environment): boolean {
  return [
    env.RUNDEA_MCP_OAUTH_ISSUER,
    env.RUNDEA_MCP_OAUTH_RESOURCE,
    env.RUNDEA_MCP_OAUTH_JWKS_URI,
  ].some((value) => Boolean(value?.trim()));
}

export function resolveReadonlyMcpHttpConfig(
  env: Environment,
  controlToken: string,
): ReadonlyMcpHttpConfig | null {
  const token = env.RUNDEA_MCP_TOKEN?.trim();
  const oauthConfigured = oauthEnvironmentPresent(env);
  const builtinOauth = ["1", "true", "yes", "on"].includes((env.RUNDEA_MCP_BUILTIN_OAUTH ?? "").trim().toLowerCase());
  if (!token && !oauthConfigured) return null;
  if (builtinOauth && oauthConfigured) throw new Error("built-in and external MCP OAuth cannot be enabled together");
  if (token && oauthConfigured) {
    throw new Error("RUNDEA_MCP_TOKEN and external MCP OAuth configuration are mutually exclusive");
  }

  const allowedHosts = parseHostnameList(env.RUNDEA_MCP_ALLOWED_HOSTS, "RUNDEA_MCP_ALLOWED_HOSTS");
  const allowedOrigins = env.RUNDEA_MCP_ALLOWED_ORIGINS?.trim()
    ? parseHostnameList(env.RUNDEA_MCP_ALLOWED_ORIGINS, "RUNDEA_MCP_ALLOWED_ORIGINS")
    : [...allowedHosts];

  if (token) {
    if (token.length < minMcpTokenLength || token.length > maxMcpTokenLength || /[\s\u0000-\u001f\u007f]/.test(token)) {
      throw new Error(`RUNDEA_MCP_TOKEN must contain ${minMcpTokenLength}-${maxMcpTokenLength} non-whitespace safe characters`);
    }
    if (equalTokenHash(hashToken(token), hashToken(controlToken))) {
      throw new Error("RUNDEA_MCP_TOKEN must be distinct from RUNDEA_CONTROL_TOKEN");
    }
    if (builtinOauth) {
      const builtin = resolveBuiltinMcpOAuthConfig(true, token, allowedHosts)!;
      const oauth: McpOAuthConfig = {
        issuer: builtin.issuer,
        resource: builtin.resource,
        jwksUri: `${builtin.issuer}/oauth/jwks`,
        requiredScope: MCP_OPERATOR_SCOPE,
        resourceMetadataUrl: `${builtin.issuer}/.well-known/oauth-protected-resource/mcp`,
        resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
      };
      return { authMode: "oauth-builtin", oauth, builtin, allowedHosts, allowedOrigins };
    }
    return { authMode: "static", token, allowedHosts, allowedOrigins };
  }

  const oauth = resolveMcpOAuthConfig(env, allowedHosts);
  if (!oauth) throw new Error("MCP OAuth configuration is incomplete");
  return { authMode: "oauth", oauth, allowedHosts, allowedOrigins };
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

export function createReadonlyMcpServer(
  dependencies: McpReadonlyDependencies,
  control?: McpControlHttpDependencies,
): McpServer {
  const server = new McpServer({
    name: "rundea",
    title: "Rundea",
    version: control ? "0.2.0" : "0.1.0",
    description: control
      ? "Operator access to the Rundea infrastructure control plane. Mutating tools are available to authenticated MCP operators."
      : "Read-only diagnostic access to the Rundea infrastructure control plane.",
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

  if (control) registerStaticControlMcpTools(server, control);

  return server;
}

export function createReadonlyMcpHandler(
  dependencies: McpReadonlyDependencies,
  control?: McpControlHttpDependencies,
) {
  return createMcpHandler(() => createReadonlyMcpServer(dependencies, control), {
    onerror: () => undefined,
  });
}

async function authorizeMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ReadonlyMcpHttpConfig,
  expectedStaticTokenHash: string | null,
  oauthVerifier: ReturnType<typeof createMcpOAuthTokenVerifier> | null,
): Promise<OperationActor | null> {
  if (config.authMode === "static") {
    if (!expectedStaticTokenHash || !isReadonlyMcpBearerAuthorized(request.headers.authorization, expectedStaticTokenHash)) {
      reply.header("WWW-Authenticate", 'Bearer realm="rundea-mcp"');
      await reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return staticTokenOperationActor;
  }

  const token = bearer(request.headers.authorization);
  if (!token) {
    reply.header("WWW-Authenticate", oauthBearerChallenge(config.oauth));
    await reply.code(401).send({ error: "unauthorized" });
    return null;
  }

  try {
    if (config.authMode === "oauth-builtin") {
      const payload = await verifyBuiltinMcpToken(token, config.builtin);
      return {
        authenticationMethod: "OAUTH",
        issuer: config.builtin.issuer,
        subject: String(payload.sub),
        scopes: [MCP_OPERATOR_SCOPE],
      };
    }
    if (!oauthVerifier) throw new Error("OAuth verifier unavailable");
    const principal = await oauthVerifier(token);
    return {
      authenticationMethod: "OAUTH",
      issuer: principal.issuer,
      subject: principal.subject,
      scopes: principal.scopes,
    };
  } catch (error) {
    const reason = error instanceof McpOAuthAuthorizationError ? error.reason : "invalid_token";
    reply.header("WWW-Authenticate", oauthBearerChallenge(config.oauth, reason));
    await reply.code(reason === "insufficient_scope" ? 403 : 401).send({ error: reason });
    return null;
  }
}

export function registerReadonlyMcpHttp(
  app: FastifyInstance,
  pool: Pool,
  config: ReadonlyMcpHttpConfig,
  controlToken?: string,
): ReadonlyMcpHttpRegistration {
  const expectedStaticTokenHash = config.authMode === "static" ? hashToken(config.token) : null;
  const oauthVerifier = config.authMode === "oauth" ? createMcpOAuthTokenVerifier(config.oauth) : null;
  if (config.authMode === "oauth-builtin") registerBuiltinMcpOAuth(app, pool, config.builtin);
  const actorContext = new OperationActorContext();
  const dependencies = createPostgresReadonlyMcpDependencies(pool, () => actorContext.current());
  if ((config.authMode === "static" || config.authMode === "oauth-builtin") && !controlToken) {
    throw new Error("RUNDEA_CONTROL_TOKEN is required for MCP operator tools");
  }
  const control = config.authMode === "oauth" ? undefined : { controlToken: controlToken! };
  const handler = createMcpHandler(() => createReadonlyMcpServer(dependencies, control), {
    onerror: (error) => app.log.error({ err: error }, "MCP protocol handler failed"),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => app.log.error({ err: error }, "MCP HTTP adapter failed"),
  });
  const validateHost = hostHeaderValidation([...config.allowedHosts]);
  const validateOrigin = originValidation([...config.allowedOrigins]);

  if (config.authMode === "oauth" || config.authMode === "oauth-builtin") {
    app.get(config.oauth.resourceMetadataPath, async (request, reply) => {
      if (!validateHost(request.raw, reply.raw)) {
        reply.hijack();
        return;
      }
      reply.header("Cache-Control", "public, max-age=300");
      return reply.send(protectedResourceMetadata(config.oauth));
    });
  }

  app.all("/mcp", { bodyLimit: maxMcpRequestBodyBytes }, async (request, reply) => {
    if (!validateHost(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    if (!validateOrigin(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    const actor = await authorizeMcpRequest(request, reply, config, expectedStaticTokenHash, oauthVerifier);
    if (!actor) return;

    reply.hijack();
    await actorContext.run(actor, async () => {
      await nodeHandler(request.raw, reply.raw, request.body);
    });
  });

  return { close: () => handler.close() };
}
