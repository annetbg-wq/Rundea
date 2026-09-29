import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from "jose";
import type { Pool } from "pg";

export const MCP_OPERATOR_SCOPE = "rundea:mcp:operator";

type Client = Readonly<{
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}>;

type Grant = Readonly<{
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  subject: string;
  expiresAt: number;
}>;

export type BuiltinMcpOAuthConfig = Readonly<{
  issuer: string;
  resource: string;
  connectorCode: string;
  requiredScope: typeof MCP_OPERATOR_SCOPE;
}>;

const codes = new Map<string, Grant>();
let keyPromise: Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; jwk: Record<string, unknown>; kid: string }> | null = null;

function keys() {
  return keyPromise ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const kid = randomUUID();
    const publicJwk = await exportJWK(publicKey);
    return {
      privateKey,
      publicKey,
      kid,
      jwk: { ...publicJwk, alg: "RS256", use: "sig", kid },
    };
  })();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function parseForm(body: unknown): Record<string, string> {
  if (typeof body !== "string") return {};
  return Object.fromEntries(new URLSearchParams(body));
}

function language(request: FastifyRequest): "ru" | "en" {
  return String(request.headers["accept-language"] ?? "").toLowerCase().includes("ru") ? "ru" : "en";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

function authPage(lang: "ru" | "en", params: Record<string, string>, client: Client, error?: string): string {
  const text = lang === "ru"
    ? {
        title: "Доступ к Rundea",
        lead: "Клиент запрашивает доступ к управлению инфраструктурой Rundea.",
        code: "Код коннектора",
        hint: "Используйте отдельный MCP-токен Rundea.",
        grant: "Разрешить доступ",
        wrong: "Неверный код коннектора",
      }
    : {
        title: "Rundea access",
        lead: "A client is requesting access to manage Rundea infrastructure.",
        code: "Connector code",
        hint: "Use the dedicated Rundea MCP token.",
        grant: "Grant access",
        wrong: "Invalid connector code",
      };
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${text.title}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f9fc;font:14px/1.6 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#182133;padding:24px}
.card{background:#fff;border:1px solid #e3e9f3;border-radius:14px;padding:32px;width:420px;max-width:100%;box-shadow:0 18px 60px #1b2b4a14}
h1{font-size:20px;margin:0 0 10px}p{color:#697386;font-size:13px;margin:0 0 18px}
label{display:block;font-size:12px;font-weight:700;margin-bottom:8px}
input{width:100%;box-sizing:border-box;border:1px solid #dce2ec;border-radius:7px;padding:11px 12px;font:inherit}
button{margin-top:18px;width:100%;background:#111827;color:#fff;border:0;border-radius:7px;padding:12px;font:inherit;font-weight:700;cursor:pointer}
.err{background:#fff0f0;border:1px solid #f5dada;color:#b34343;border-radius:7px;padding:10px 12px;font-size:13px;margin-bottom:16px}
</style></head><body><form class="card" method="post" action="/oauth/authorize">
<h1>${text.title}</h1><p><b>${escapeHtml(client.client_name)}</b> — ${text.lead}</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
${Object.entries(params).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}"/>`).join("")}
<label for="connector_code">${text.code}</label><input id="connector_code" name="connector_code" type="password" autofocus required/>
<p style="margin:8px 0 0;font-size:12px">${text.hint}</p><button type="submit">${text.grant}</button></form></body></html>`;
}

async function readClient(pool: Pool, clientId: string): Promise<Client | null> {
  const result = await pool.query(
    "SELECT client_id,client_name,redirect_uris FROM mcp_oauth_clients WHERE client_id=$1",
    [clientId],
  );
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  return {
    client_id: String(row.client_id),
    client_name: String(row.client_name),
    redirect_uris: Array.isArray(row.redirect_uris) ? row.redirect_uris.map(String) : [],
  };
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

export function resolveBuiltinMcpOAuthConfig(
  enabled: boolean,
  connectorCode: string | undefined,
  allowedHosts: readonly string[],
): BuiltinMcpOAuthConfig | null {
  if (!enabled) return null;
  const code = connectorCode?.trim();
  if (!code) throw new Error("RUNDEA_MCP_TOKEN is required when built-in MCP OAuth is enabled");
  const host = allowedHosts[0];
  if (!host) throw new Error("RUNDEA_MCP_ALLOWED_HOSTS is required when built-in MCP OAuth is enabled");
  const issuer = `https://${host}`;
  return {
    issuer,
    resource: `${issuer}/mcp`,
    connectorCode: code,
    requiredScope: MCP_OPERATOR_SCOPE,
  };
}

export async function verifyBuiltinMcpToken(token: string, config: BuiltinMcpOAuthConfig): Promise<JWTPayload> {
  const { publicKey } = await keys();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.issuer,
    audience: config.resource,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "exp"],
    clockTolerance: 5,
  });
  if (!payload.sub) throw new Error("unbound subject");
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
  if (!scopes.includes(config.requiredScope)) throw new Error("insufficient scope");
  return payload;
}

export function registerBuiltinMcpOAuth(
  app: FastifyInstance,
  pool: Pool,
  config: BuiltinMcpOAuthConfig,
): void {
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
  }

  const metadata = {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/oauth/authorize`,
    token_endpoint: `${config.issuer}/oauth/token`,
    registration_endpoint: `${config.issuer}/oauth/register`,
    jwks_uri: `${config.issuer}/oauth/jwks`,
    scopes_supported: [config.requiredScope],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };

  const serveAuthorizationMetadata = async (_request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return metadata;
  };
  app.get("/.well-known/oauth-authorization-server", serveAuthorizationMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", serveAuthorizationMetadata);

  app.get("/oauth/jwks", async () => ({ keys: [(await keys()).jwk] }));

  app.post<{ Body: { redirect_uris?: unknown; client_name?: unknown } }>("/oauth/register", async (request, reply) => {
    const redirectUris = Array.isArray(request.body?.redirect_uris)
      ? request.body.redirect_uris.filter((value): value is string => typeof value === "string")
      : [];
    if (!redirectUris.length || redirectUris.some((uri) => !validRedirectUri(uri))) {
      return reply.code(400).send({ error: "invalid_redirect_uri" });
    }
    const client: Client = {
      client_id: randomUUID(),
      client_name: String(request.body?.client_name ?? "MCP client").slice(0, 80),
      redirect_uris: [...new Set(redirectUris)],
    };
    await pool.query(
      "INSERT INTO mcp_oauth_clients(client_id,client_name,redirect_uris) VALUES($1,$2,$3::jsonb)",
      [client.client_id, client.client_name, JSON.stringify(client.redirect_uris)],
    );
    return reply.code(201).send({
      ...client,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  const collect = (source: Record<string, unknown>) => ({
    client_id: String(source.client_id ?? ""),
    redirect_uri: String(source.redirect_uri ?? ""),
    state: String(source.state ?? ""),
    scope: String(source.scope ?? config.requiredScope),
    code_challenge: String(source.code_challenge ?? ""),
    code_challenge_method: String(source.code_challenge_method ?? ""),
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const params = collect(request.query as Record<string, unknown>);
    const client = await readClient(pool, params.client_id);
    if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
      return reply.code(400).send({ error: "invalid_client" });
    }
    if (params.code_challenge_method !== "S256" || !params.code_challenge) {
      return reply.code(400).send({ error: "invalid_request", error_description: "PKCE S256 required" });
    }
    if (!params.scope.split(/\s+/).includes(config.requiredScope)) {
      return reply.code(400).send({ error: "invalid_scope" });
    }
    return reply.type("text/html; charset=utf-8").send(authPage(language(request), params, client));
  });

  app.post("/oauth/authorize", async (request, reply) => {
    const body = parseForm(request.body);
    const params = collect(body);
    const client = await readClient(pool, params.client_id);
    if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
      return reply.code(400).send({ error: "invalid_client" });
    }
    if (params.code_challenge_method !== "S256" || !params.code_challenge) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!same(String(body.connector_code ?? ""), config.connectorCode)) {
      return reply.type("text/html; charset=utf-8").code(401).send(
        authPage(language(request), params, client, language(request) === "ru" ? "Неверный код коннектора" : "Invalid connector code"),
      );
    }
    const code = randomBytes(32).toString("base64url");
    codes.set(code, {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      challenge: params.code_challenge,
      scope: params.scope,
      subject: "rundea-operator",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const target = new URL(params.redirect_uri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    return reply.redirect(target.toString());
  });

  app.post("/oauth/token", async (request, reply) => {
    const body = parseForm(request.body);
    const grantType = String(body.grant_type ?? "");
    const clientId = String(body.client_id ?? "");
    if (grantType === "refresh_token") {
      const refreshToken = String(body.refresh_token ?? "");
      const result = await pool.query(
        "SELECT client_id,scope,subject FROM mcp_oauth_refresh_tokens WHERE token_hash=$1 AND expires_at>now()",
        [hash(refreshToken)],
      );
      if (result.rowCount !== 1 || String(result.rows[0].client_id) !== clientId) {
        return reply.code(400).send({ error: "invalid_grant" });
      }
      const accessToken = await issueAccessToken(String(result.rows[0].scope), String(result.rows[0].subject), config);
      return reply.send({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: String(result.rows[0].scope),
        refresh_token: refreshToken,
      });
    }

    if (grantType !== "authorization_code") {
      return reply.code(400).send({ error: "unsupported_grant_type" });
    }
    const code = String(body.code ?? "");
    const grant = codes.get(code);
    codes.delete(code);
    if (!grant || grant.expiresAt < Date.now()) return reply.code(400).send({ error: "invalid_grant" });
    if (grant.clientId !== clientId || grant.redirectUri !== String(body.redirect_uri ?? "")) {
      return reply.code(400).send({ error: "invalid_grant" });
    }
    const verifier = String(body.code_verifier ?? "");
    if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
      return reply.code(400).send({ error: "invalid_grant", error_description: "PKCE verification failed" });
    }
    const refreshToken = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO mcp_oauth_refresh_tokens(token_hash,client_id,scope,subject,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')",
      [hash(refreshToken), grant.clientId, grant.scope, grant.subject],
    );
    return reply.send({
      access_token: await issueAccessToken(grant.scope, grant.subject, config),
      token_type: "Bearer",
      expires_in: 3600,
      scope: grant.scope,
      refresh_token: refreshToken,
    });
  });
}

async function issueAccessToken(scope: string, subject: string, config: BuiltinMcpOAuthConfig): Promise<string> {
  const { privateKey, kid } = await keys();
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(config.issuer)
    .setAudience(config.resource)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(randomUUID())
    .sign(privateKey);
}
