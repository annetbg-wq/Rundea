import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { encryptValue } from "@rundea/crypto";
import {
  executeServiceVariableDeleteOperation,
  executeServiceVariablesReadOperation,
  executeServiceVariablesUpsertOperation,
} from "./service-variables";

const masterKey = Buffer.alloc(32, 7);

function encryptedRow(key: string, value: string, secret: boolean) {
  const encrypted = encryptValue(value, masterKey);
  return {
    key,
    encrypted_version: encrypted.version,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    auth_tag: encrypted.tag,
    is_secret: secret,
  };
}

test("service variable read rejects invalid service name before database access", async () => {
  let queries = 0;
  const pool = {
    query: async () => {
      queries += 1;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;

  await assert.rejects(
    executeServiceVariablesReadOperation(pool, masterKey, "bad service name"),
    /invalid service name/,
  );
  assert.equal(queries, 0);
});

test("service variable read never exposes plaintext for secret values", async () => {
  const pool = {
    query: async () => ({
      rowCount: 2,
      rows: [
        encryptedRow("API_TOKEN", "super-secret-value", true),
        encryptedRow("PUBLIC_ORIGIN", "https://example.test", false),
      ],
    }),
  } as unknown as Pool;

  const result = await executeServiceVariablesReadOperation(pool, masterKey, "backend");
  assert.deepEqual(result.variables, [
    { key: "API_TOKEN", secret: true },
    { key: "PUBLIC_ORIGIN", secret: false, value: "https://example.test" },
  ]);
  assert.equal(JSON.stringify(result).includes("super-secret-value"), false);
});

test("service variable upsert returns metadata only and never plaintext", async () => {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      return { rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;

  const result = await executeServiceVariablesUpsertOperation(pool, masterKey, "backend", [
    { key: "API_TOKEN", value: "plaintext-secret", secret: true },
    { key: "PUBLIC_ORIGIN", value: "https://example.test", secret: false },
  ]);

  assert.deepEqual(result, {
    updated: [
      { key: "API_TOKEN", secret: true },
      { key: "PUBLIC_ORIGIN", secret: false },
    ],
  });
  assert.equal(JSON.stringify(result).includes("plaintext-secret"), false);
  const persistedParams = queries.flatMap((entry) => entry.params ?? []);
  assert.equal(persistedParams.includes("plaintext-secret"), false);
  assert.equal(persistedParams.includes("https://example.test"), false);
});

test("service variable upsert rejects reserved Rundea keys before opening a transaction", async () => {
  let connects = 0;
  const pool = {
    connect: async () => {
      connects += 1;
      throw new Error("unexpected connect");
    },
  } as unknown as Pool;

  await assert.rejects(
    executeServiceVariablesUpsertOperation(pool, masterKey, "backend", [
      { key: "RUNDEA_CONTROL_TOKEN", value: "forbidden", secret: true },
    ]),
    /reserved by Rundea/,
  );
  assert.equal(connects, 0);
});

test("service variable delete validates scope and returns only key metadata", async () => {
  let queries = 0;
  const pool = {
    query: async (text: string, params?: unknown[]) => {
      queries += 1;
      assert.match(text, /^DELETE FROM service_variables/);
      assert.deepEqual(params, ["backend", "OLD_TOKEN"]);
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;

  const result = await executeServiceVariableDeleteOperation(pool, "backend", "OLD_TOKEN");
  assert.deepEqual(result, { deleted: true, key: "OLD_TOKEN" });
  assert.equal(queries, 1);

  await assert.rejects(
    executeServiceVariableDeleteOperation(pool, "backend", "bad-key"),
    /invalid environment variable name/,
  );
  assert.equal(queries, 1);
});
