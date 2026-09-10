import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Pool } from "pg";
import { registerReadonlyMcpHttp, resolveReadonlyMcpHttpConfig } from "./mcp-http";
import { MCP_DIAGNOSTICS_READ_SCOPE } from "./mcp-oauth";

const controlToken = "control-token-that-is-long-enough-for-tests-0001";

function oauthConfig() {
  const config = resolveReadonlyMcpHttpConfig({
    RUNDEA_MCP_ALLOWED_HOSTS: "mcp.rundea.test",
    RUNDEA_MCP_OAUTH_ISSUER: "https://auth.rundea.test",
    RUNDEA_MCP_OAUTH_RESOURCE: "https://mcp.rundea.test/mcp",
    RUNDEA_MCP_OAUTH_JWKS_URI: "https://auth.rundea.test/.well-known/jwks.json",
  }, controlToken);
  assert.ok(config);
  assert.equal(config.authMode, "oauth");
  if (config.authMode !== "oauth") throw new Error("expected OAuth MCP config");
  return config;
}

test("OAuth MCP publishes protected-resource discovery and challenges unauthenticated /mcp requests", async () => {
  const app = Fastify();
  const registration = registerReadonlyMcpHttp(app, {} as Pool, oauthConfig());
  try {
    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
      headers: { host: "mcp.rundea.test" },
    });
    assert.equal(metadata.statusCode, 200);
    const contentType = metadata.headers["content-type"];
    assert.match(Array.isArray(contentType) ? contentType.join(", ") : contentType ?? "", /^application\/json/);
    assert.deepEqual(metadata.json(), {
      resource: "https://mcp.rundea.test/mcp",
      authorization_servers: ["https://auth.rundea.test"],
      scopes_supported: [MCP_DIAGNOSTICS_READ_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Rundea MCP",
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "mcp.rundea.test",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    assert.equal(response.statusCode, 401);
    const rawChallenge = response.headers["www-authenticate"];
    const challenge = Array.isArray(rawChallenge) ? rawChallenge.join(", ") : rawChallenge ?? "";
    assert.match(challenge, /resource_metadata="https:\/\/mcp\.rundea\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(challenge, new RegExp(`scope="${MCP_DIAGNOSTICS_READ_SCOPE}"`));
  } finally {
    await registration.close();
    await app.close();
  }
});
