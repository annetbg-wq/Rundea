import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { hashToken } from "@rundea/crypto";
import { registerNodeBootstrapRoutes } from "./node-bootstrap";

const nodeId = "11111111-1111-4111-8111-111111111111";
const bootstrapToken = "bootstrap-token-that-is-long-enough-for-testing";
const permanentToken = "a".repeat(64);

class FakePool {
  tokenHash = hashToken(bootstrapToken);
  status = "ONLINE";

  async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith("SELECT token_hash FROM nodes WHERE id=$1 FOR UPDATE")) {
      return { rowCount: values[0] === nodeId ? 1 : 0, rows: values[0] === nodeId ? [{ token_hash: this.tokenHash }] : [] };
    }
    if (sql.startsWith("SELECT token_hash FROM nodes WHERE id=$1")) {
      return { rowCount: values[0] === nodeId ? 1 : 0, rows: values[0] === nodeId ? [{ token_hash: this.tokenHash }] : [] };
    }
    if (sql.startsWith("UPDATE nodes SET token_hash=$2 WHERE id=$1")) {
      assert.equal(values[0], nodeId);
      this.tokenHash = String(values[1]);
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith("SELECT status FROM nodes WHERE id=$1")) {
      return { rowCount: values[0] === nodeId ? 1 : 0, rows: values[0] === nodeId ? [{ status: this.status }] : [] };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: null, rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }
}

test("bootstrap exchange consumes the one-time credential and accepts only the permanent credential afterwards", async () => {
  const app = Fastify();
  const pool = new FakePool();
  registerNodeBootstrapRoutes(app, pool as never, async () => undefined);

  const exchanged = await app.inject({
    method: "POST",
    url: `/v0/nodes/${nodeId}/bootstrap/exchange`,
    headers: { authorization: `Bearer ${bootstrapToken}` },
    payload: { agentToken: permanentToken },
  });
  assert.equal(exchanged.statusCode, 204);

  const replay = await app.inject({
    method: "POST",
    url: `/v0/nodes/${nodeId}/bootstrap/exchange`,
    headers: { authorization: `Bearer ${bootstrapToken}` },
    payload: { agentToken: "b".repeat(64) },
  });
  assert.equal(replay.statusCode, 401);

  const oldCredential = await app.inject({
    method: "GET",
    url: `/v0/nodes/${nodeId}/self/status`,
    headers: { authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(oldCredential.statusCode, 401);

  const currentCredential = await app.inject({
    method: "GET",
    url: `/v0/nodes/${nodeId}/self/status`,
    headers: { authorization: `Bearer ${permanentToken}` },
  });
  assert.equal(currentCredential.statusCode, 200);
  assert.equal(currentCredential.body, "ONLINE");

  await app.close();
});

test("agent release routes reject unsupported architecture before touching a bundle", async () => {
  const app = Fastify();
  const pool = new FakePool();
  registerNodeBootstrapRoutes(app, pool as never, async () => undefined);
  const response = await app.inject({
    method: "GET",
    url: "/v0/agent/releases/windows-x64",
    headers: {
      authorization: `Bearer ${bootstrapToken}`,
      "x-rundea-node-id": nodeId,
    },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});
