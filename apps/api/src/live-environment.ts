export type RundeaEnvironment = "development" | "staging" | "production";
export type PublicWebMode = "disabled" | "external-auth";

type Environment = Readonly<Record<string, string | undefined>>;

export type LiveEnvironmentConfig = Readonly<{
  environment: RundeaEnvironment;
  webOrigin: string;
  publicOrigin: string | null;
  publicControlPlaneOrigin: string | null;
  publicWebMode: PublicWebMode;
}>;

function parseEnvironment(raw: string | undefined): RundeaEnvironment {
  const value = raw?.trim() || "development";
  if (value !== "development" && value !== "staging" && value !== "production") {
    throw new Error("RUNDEA_ENVIRONMENT must be development, staging or production");
  }
  return value;
}

function parseOrigin(raw: string | undefined, name: string, requireHttps: boolean): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid origin URL`);
  }

  if (
    (requireHttps && url.protocol !== "https:") ||
    (!requireHttps && url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${name} must be an ${requireHttps ? "HTTPS " : ""}origin without path, credentials, query or fragment`);
  }

  return url.origin;
}

function parsePublicWebMode(raw: string | undefined, environment: RundeaEnvironment): PublicWebMode {
  const value = raw?.trim() || "disabled";
  if (value !== "disabled" && value !== "external-auth") {
    throw new Error("RUNDEA_PUBLIC_WEB_MODE must be disabled or external-auth");
  }
  if (environment === "development" && value === "external-auth") {
    throw new Error("RUNDEA_PUBLIC_WEB_MODE=external-auth is only valid for staging or production");
  }
  return value;
}

export function resolveLiveEnvironment(env: Environment): LiveEnvironmentConfig {
  const environment = parseEnvironment(env.RUNDEA_ENVIRONMENT);
  const publicWebMode = parsePublicWebMode(env.RUNDEA_PUBLIC_WEB_MODE, environment);

  if (environment === "development") {
    return {
      environment,
      webOrigin: parseOrigin(env.RUNDEA_WEB_ORIGIN ?? "http://localhost:5173", "RUNDEA_WEB_ORIGIN", false),
      publicOrigin: null,
      publicControlPlaneOrigin: null,
      publicWebMode,
    };
  }

  const publicOrigin = parseOrigin(env.RUNDEA_PUBLIC_ORIGIN, "RUNDEA_PUBLIC_ORIGIN", true);
  const webOrigin = parseOrigin(env.RUNDEA_WEB_ORIGIN, "RUNDEA_WEB_ORIGIN", true);
  const publicControlPlaneOrigin = parseOrigin(
    env.RUNDEA_PUBLIC_CONTROL_PLANE_URL,
    "RUNDEA_PUBLIC_CONTROL_PLANE_URL",
    true,
  );

  if (webOrigin !== publicOrigin) {
    throw new Error("RUNDEA_WEB_ORIGIN must match RUNDEA_PUBLIC_ORIGIN for the single-origin live surface");
  }
  if (publicControlPlaneOrigin !== publicOrigin) {
    throw new Error("RUNDEA_PUBLIC_CONTROL_PLANE_URL must match RUNDEA_PUBLIC_ORIGIN for the live surface");
  }

  const oauthResource = env.RUNDEA_MCP_OAUTH_RESOURCE?.trim();
  if (oauthResource) {
    const expected = `${publicOrigin}/mcp`;
    if (oauthResource !== expected) {
      throw new Error(`RUNDEA_MCP_OAUTH_RESOURCE must be ${expected} in ${environment}`);
    }
  }

  return {
    environment,
    webOrigin,
    publicOrigin,
    publicControlPlaneOrigin,
    publicWebMode,
  };
}
