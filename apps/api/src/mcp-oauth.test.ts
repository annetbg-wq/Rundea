import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  createMcpOAuthTokenVerifier,
  MCP_DIAGNOSTICS_READ_SCOPE,
  McpOAuthAuthorizationError,
  oauthBearerChallenge,
  protectedResourceMetadata,
  resolveMcpOAuthConfig,
  type McpOAuthConfig,
} from "./mcp-oauth";

const issuer = "https://auth.rundea.test";
const resource = "https://mcp.rundea.test/mcp";
const jwksUri = "https://auth.rundea.test/.well-known/jwks.json";

function config(): McpOAuthConfig {
  const value = resolveMcpOAuthConfig({
    RUNDEA_MCP_OAUTH_ISSUER: issuer,
    RUNDEA_MCP_OAUTH_RESOURCE: resource,
    RUNDEA_MCP_OAUTH_JWKS_URI: jwksUri,
  }, ["mcp.rundea.test"]);
  assert.ok(value);
  return value;
}

async function accessToken(
  privateKey: CryptoKey,
  options: {
    issuer?: string;
    audience?: string;
    scope?: string;
    subject?: string;
    expiresAt?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: options.scope ?? MCP_DIAGNOSTICS_READ_SCOPE })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? resource)
    .setSubject(options.subject ?? "rundea-user-123")
    .setIssuedAt(now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
}

test("OAuth resource config is atomic and bound to the exact /mcp resource", () => {
  assert.equal(resolveMcpOAuthConfig({}, ["mcp.rundea.test"]), null);
  assert.throws(
    () => resolveMcpOAuthConfig({ RUNDEA_MCP_OAUTH_ISSUER: issuer }, ["mcp.rundea.test"]),
    /must be configured together/,
  );
  assert.throws(
    () => resolveMcpOAuthConfig({
      RUNDEA_MCP_OAUTH_ISSUER: issuer,
      RUNDEA_MCP_OAUTH_RESOURCE: "https://mcp.rundea.test/not-mcp",
      RUNDEA_MCP_OAUTH_JWKS_URI: jwksUri,
    }, ["mcp.rundea.test"]),
    /identify the Rundea \/mcp endpoint exactly/,
  );
  assert.throws(
    () => resolveMcpOAuthConfig({
      RUNDEA_MCP_OAUTH_ISSUER: issuer,
      RUNDEA_MCP_OAUTH_RESOURCE: resource,
      RUNDEA_MCP_OAUTH_JWKS_URI: jwksUri,
    }, ["other.rundea.test"]),
    /hostname must be present/,
  );
});

test("OAuth protected-resource metadata uses the RFC 9728 path for the /mcp resource", () => {
  const value = config();
  assert.equal(value.resourceMetadataUrl, "https://mcp.rundea.test/.well-known/oauth-protected-resource/mcp");
  assert.equal(value.resourceMetadataPath, "/.well-known/oauth-protected-resource/mcp");
  assert.deepEqual(protectedResourceMetadata(value), {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [MCP_DIAGNOSTICS_READ_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Rundea MCP",
  });
  assert.equal(
    oauthBearerChallenge(value),
    `Bearer resource_metadata="https://mcp.rundea.test/.well-known/oauth-protected-resource/mcp", scope="${MCP_DIAGNOSTICS_READ_SCOPE}"`,
  );
});

test("OAuth verifier accepts only a signed token for the exact issuer, audience and read scope", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const verify = createMcpOAuthTokenVerifier(config(), publicKey);
  const principal = await verify(await accessToken(privateKey));
  assert.equal(principal.subject, "rundea-user-123");
  assert.deepEqual(principal.scopes, [MCP_DIAGNOSTICS_READ_SCOPE]);

  await assert.rejects(
    verify(await accessToken(privateKey, { audience: "https://other.rundea.test/mcp" })),
    (error: unknown) => error instanceof McpOAuthAuthorizationError && error.reason === "invalid_token",
  );
  await assert.rejects(
    verify(await accessToken(privateKey, { issuer: "https://attacker.example" })),
    (error: unknown) => error instanceof McpOAuthAuthorizationError && error.reason === "invalid_token",
  );
});

test("OAuth verifier rejects expired tokens and tokens without the diagnostic scope", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const verify = createMcpOAuthTokenVerifier(config(), publicKey);
  const now = Math.floor(Date.now() / 1000);

  await assert.rejects(
    verify(await accessToken(privateKey, { expiresAt: now - 60 })),
    (error: unknown) => error instanceof McpOAuthAuthorizationError && error.reason === "invalid_token",
  );
  await assert.rejects(
    verify(await accessToken(privateKey, { scope: "profile offline_access" })),
    (error: unknown) => error instanceof McpOAuthAuthorizationError && error.reason === "insufficient_scope",
  );
});

test("OAuth verifier does not accept an unsigned or malformed bearer value", async () => {
  const { publicKey } = await generateKeyPair("RS256");
  const verify = createMcpOAuthTokenVerifier(config(), publicKey);
  await assert.rejects(
    verify("not-a-jwt"),
    (error: unknown) => error instanceof McpOAuthAuthorizationError && error.reason === "invalid_token",
  );
  await assert.rejects(
    verify("header.payload.signature with-space"),
    (error: unknown) => error instanceof McpOAuthAuthorizationError && error.reason === "invalid_token",
  );
});
