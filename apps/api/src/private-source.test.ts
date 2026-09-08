import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { createGitHubAppJwt } from "./private-source";

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("createGitHubAppJwt creates a short-lived RS256 GitHub App token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const nowMs = Date.UTC(2026, 8, 8, 12, 0, 0);
  const jwt = createGitHubAppJwt("123456", privatePem, nowMs);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(decodeJson(parts[0]!), { alg: "RS256", typ: "JWT" });
  const payload = decodeJson(parts[1]!);
  assert.equal(payload.iss, "123456");
  assert.equal(payload.iat, Math.floor(nowMs / 1000) - 60);
  assert.equal(payload.exp, Math.floor(nowMs / 1000) + 540);
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, "base64url")),
    true,
  );
});

test("createGitHubAppJwt accepts escaped-newline PEM environment values", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const escapedPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  const jwt = createGitHubAppJwt("9", escapedPem, 1_800_000_000_000);
  const [header, payload, signature] = jwt.split(".");
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url")), true);
});

test("createGitHubAppJwt rejects invalid app ids", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => createGitHubAppJwt("not-an-id", privatePem), /positive integer/);
});
