import assert from "node:assert/strict";
import test from "node:test";
import { resolveLiveEnvironment } from "./live-environment";

const production = {
  RUNDEA_ENVIRONMENT: "production",
  RUNDEA_PUBLIC_ORIGIN: "https://rundea.buxopus.com",
  RUNDEA_WEB_ORIGIN: "https://rundea.buxopus.com",
  RUNDEA_PUBLIC_CONTROL_PLANE_URL: "https://rundea.buxopus.com",
  RUNDEA_PUBLIC_WEB_MODE: "external-auth",
  RUNDEA_MCP_OAUTH_RESOURCE: "https://rundea.buxopus.com/mcp",
} as const;

test("development keeps the existing localhost origin by default", () => {
  const config = resolveLiveEnvironment({});
  assert.equal(config.environment, "development");
  assert.equal(config.webOrigin, "http://localhost:5173");
  assert.equal(config.publicOrigin, null);
  assert.equal(config.publicWebMode, "disabled");
});

test("production accepts the canonical buxopus single-origin surface", () => {
  assert.deepEqual(resolveLiveEnvironment(production), {
    environment: "production",
    webOrigin: "https://rundea.buxopus.com",
    publicOrigin: "https://rundea.buxopus.com",
    publicControlPlaneOrigin: "https://rundea.buxopus.com",
    publicWebMode: "external-auth",
  });
});

test("staging and production require HTTPS public origin", () => {
  assert.throws(
    () => resolveLiveEnvironment({ ...production, RUNDEA_PUBLIC_ORIGIN: "http://rundea.buxopus.com" }),
    /HTTPS origin/,
  );
});

test("live web and control-plane origins cannot drift from canonical origin", () => {
  assert.throws(
    () => resolveLiveEnvironment({ ...production, RUNDEA_WEB_ORIGIN: "https://admin.buxopus.com" }),
    /RUNDEA_WEB_ORIGIN must match/,
  );
  assert.throws(
    () => resolveLiveEnvironment({ ...production, RUNDEA_PUBLIC_CONTROL_PLANE_URL: "https://api.buxopus.com" }),
    /RUNDEA_PUBLIC_CONTROL_PLANE_URL must match/,
  );
});

test("OAuth resource is pinned to the canonical live /mcp endpoint", () => {
  assert.throws(
    () => resolveLiveEnvironment({ ...production, RUNDEA_MCP_OAUTH_RESOURCE: "https://other.example/mcp" }),
    /RUNDEA_MCP_OAUTH_RESOURCE must be https:\/\/rundea\.buxopus\.com\/mcp/,
  );
});

test("origin inputs reject paths, credentials, query and fragments", () => {
  for (const publicOrigin of [
    "https://rundea.buxopus.com/app",
    "https://user:pass@rundea.buxopus.com",
    "https://rundea.buxopus.com/?x=1",
    "https://rundea.buxopus.com/#x",
  ]) {
    assert.throws(() => resolveLiveEnvironment({ ...production, RUNDEA_PUBLIC_ORIGIN: publicOrigin }));
  }
});

test("public web mode is explicit and cannot masquerade as development protection", () => {
  assert.throws(
    () => resolveLiveEnvironment({ RUNDEA_PUBLIC_WEB_MODE: "external-auth" }),
    /only valid for staging or production/,
  );
  assert.throws(
    () => resolveLiveEnvironment({ ...production, RUNDEA_PUBLIC_WEB_MODE: "open" }),
    /disabled or external-auth/,
  );
});
