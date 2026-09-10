import { createRemoteJWKSet, jwtVerify } from "jose";

export const MCP_DIAGNOSTICS_READ_SCOPE = "rundea:mcp:diagnostics:read";

const maxAccessTokenLength = 16 * 1024;
const maxSubjectLength = 256;
const maxScopeClaimLength = 2048;
const maxOAuthUrlLength = 2048;
const allowedAlgorithms = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;
type VerificationKey = Parameters<typeof jwtVerify>[1];

export type McpOAuthConfig = Readonly<{
  issuer: string;
  resource: string;
  jwksUri: string;
  requiredScope: typeof MCP_DIAGNOSTICS_READ_SCOPE;
  resourceMetadataUrl: string;
  resourceMetadataPath: string;
}>;

export type McpOAuthPrincipal = Readonly<{
  issuer: string;
  subject: string;
  scopes: readonly string[];
}>;

export type McpOAuthFailureReason = "invalid_token" | "insufficient_scope";

export class McpOAuthAuthorizationError extends Error {
  readonly reason: McpOAuthFailureReason;

  constructor(reason: McpOAuthFailureReason, message: string) {
    super(message);
    this.name = "McpOAuthAuthorizationError";
    this.reason = reason;
  }
}

function requireHttpsUrl(raw: string | undefined, name: string): { value: string; url: URL } {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required when MCP OAuth is configured`);
  if (value.length > maxOAuthUrlLength) throw new Error(`${name} is too long`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} must be a valid HTTPS URL without credentials or fragment`);
  }
  return { value, url };
}

export function resolveMcpOAuthConfig(
  env: Environment,
  allowedHosts: readonly string[],
): McpOAuthConfig | null {
  const fields = [
    env.RUNDEA_MCP_OAUTH_ISSUER,
    env.RUNDEA_MCP_OAUTH_RESOURCE,
    env.RUNDEA_MCP_OAUTH_JWKS_URI,
  ];
  const configured = fields.filter((value) => Boolean(value?.trim())).length;
  if (configured === 0) return null;
  if (configured !== fields.length) {
    throw new Error(
      "RUNDEA_MCP_OAUTH_ISSUER, RUNDEA_MCP_OAUTH_RESOURCE and RUNDEA_MCP_OAUTH_JWKS_URI must be configured together",
    );
  }

  const issuer = requireHttpsUrl(env.RUNDEA_MCP_OAUTH_ISSUER, "RUNDEA_MCP_OAUTH_ISSUER");
  const resource = requireHttpsUrl(env.RUNDEA_MCP_OAUTH_RESOURCE, "RUNDEA_MCP_OAUTH_RESOURCE");
  const jwks = requireHttpsUrl(env.RUNDEA_MCP_OAUTH_JWKS_URI, "RUNDEA_MCP_OAUTH_JWKS_URI");

  if (issuer.url.search) throw new Error("RUNDEA_MCP_OAUTH_ISSUER must not contain a query string");
  if (resource.url.search) throw new Error("RUNDEA_MCP_OAUTH_RESOURCE must not contain a query string");
  if (resource.url.pathname !== "/mcp") {
    throw new Error("RUNDEA_MCP_OAUTH_RESOURCE must identify the Rundea /mcp endpoint exactly");
  }
  if (!allowedHosts.includes(resource.url.hostname.toLowerCase())) {
    throw new Error("RUNDEA_MCP_OAUTH_RESOURCE hostname must be present in RUNDEA_MCP_ALLOWED_HOSTS");
  }

  const metadata = new URL(resource.value);
  metadata.pathname = `/.well-known/oauth-protected-resource${resource.url.pathname}`;
  metadata.search = "";
  metadata.hash = "";

  return {
    issuer: issuer.value,
    resource: resource.value,
    jwksUri: jwks.value,
    requiredScope: MCP_DIAGNOSTICS_READ_SCOPE,
    resourceMetadataUrl: metadata.toString(),
    resourceMetadataPath: metadata.pathname,
  };
}

function invalidToken(message = "OAuth access token is invalid"): McpOAuthAuthorizationError {
  return new McpOAuthAuthorizationError("invalid_token", message);
}

function tokenScopes(scope: unknown): readonly string[] {
  if (typeof scope !== "string" || scope.length < 1 || scope.length > maxScopeClaimLength) {
    return [];
  }
  return [...new Set(scope.split(/\s+/).filter(Boolean))];
}

export function createMcpOAuthTokenVerifier(config: McpOAuthConfig, key?: VerificationKey) {
  const verificationKey = key ?? createRemoteJWKSet(new URL(config.jwksUri));

  return async (token: string): Promise<McpOAuthPrincipal> => {
    if (
      token.length < 1 ||
      token.length > maxAccessTokenLength ||
      /[\s\u0000-\u001f\u007f]/.test(token)
    ) {
      throw invalidToken();
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, verificationKey, {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: [...allowedAlgorithms],
        requiredClaims: ["sub", "exp"],
        clockTolerance: 5,
      }));
    } catch {
      throw invalidToken();
    }

    const subject = payload.sub;
    if (
      typeof subject !== "string" ||
      subject.length < 1 ||
      subject.length > maxSubjectLength ||
      /[\r\n\u0000]/.test(subject)
    ) {
      throw invalidToken();
    }

    const scopes = tokenScopes(payload.scope);
    if (!scopes.includes(config.requiredScope)) {
      throw new McpOAuthAuthorizationError(
        "insufficient_scope",
        "OAuth access token does not grant the required MCP scope",
      );
    }

    return {
      issuer: config.issuer,
      subject,
      scopes: [config.requiredScope],
    };
  };
}

export function protectedResourceMetadata(config: McpOAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [config.requiredScope],
    bearer_methods_supported: ["header"],
    resource_name: "Rundea MCP",
  } as const;
}

export function oauthBearerChallenge(
  config: McpOAuthConfig,
  reason?: McpOAuthFailureReason,
): string {
  const fields = [
    `resource_metadata="${config.resourceMetadataUrl}"`,
    `scope="${config.requiredScope}"`,
  ];
  if (reason) fields.unshift(`error="${reason}"`);
  return `Bearer ${fields.join(", ")}`;
}
