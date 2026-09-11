import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { createPostgresMcpResourceAccessResolver } from "./mcp-resource-access";
import type { OAuthOperationActor } from "./operation-actor";

const actor: OAuthOperationActor = {
  authenticationMethod: "OAUTH",
  issuer: "https://auth.rundea.test",
  subject: "user-123",
  scopes: ["rundea:mcp:diagnostics:read"],
};
const resourceId = "123e4567-e89b-42d3-a456-426614174000";

test("OAuth resource access requires an exact persisted grant", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rowCount: 1, rows: [{ present: 1 }] };
    },
  } as unknown as Pool;

  const canAccess = createPostgresMcpResourceAccessResolver(pool);
  assert.equal(await canAccess({ actor, resourceKind: "DEPLOYMENT", resourceId, permission: "DIAGNOSTICS_READ" }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.text ?? "", /mcp_resource_grants/);
  assert.deepEqual(calls[0]?.params, [actor.issuer, actor.subject, "DEPLOYMENT", resourceId, "DIAGNOSTICS_READ"]);
});

test("missing OAuth resource grant denies access without probing the resource table", async () => {
  const calls: string[] = [];
  const pool = {
    query: async (text: string) => {
      calls.push(text);
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;

  const canAccess = createPostgresMcpResourceAccessResolver(pool);
  assert.equal(await canAccess({ actor, resourceKind: "NODE", resourceId, permission: "DIAGNOSTICS_READ" }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.includes("FROM nodes"), false);
  assert.equal(calls[0]?.includes("FROM deployments"), false);
});

test("static MCP credential keeps the administrative path without a grant lookup", async () => {
  let queries = 0;
  const pool = {
    query: async () => {
      queries += 1;
      throw new Error("unexpected lookup");
    },
  } as unknown as Pool;

  const canAccess = createPostgresMcpResourceAccessResolver(pool);
  assert.equal(await canAccess({
    actor: { authenticationMethod: "STATIC_TOKEN", issuer: null, subject: null, scopes: [] },
    resourceKind: "NODE",
    resourceId,
    permission: "DIAGNOSTICS_READ",
  }), true);
  assert.equal(queries, 0);
});

test("malformed OAuth resource ids fail closed before a database lookup", async () => {
  let queries = 0;
  const pool = {
    query: async () => {
      queries += 1;
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  const canAccess = createPostgresMcpResourceAccessResolver(pool);
  assert.equal(await canAccess({ actor, resourceKind: "DEPLOYMENT", resourceId: "not-a-uuid", permission: "DIAGNOSTICS_READ" }), false);
  assert.equal(queries, 0);
});
