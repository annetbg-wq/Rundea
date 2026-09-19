import assert from "node:assert/strict";
import test from "node:test";
import { redactLogMessage } from "./log-redaction";

test("redacts exact submitted secret values before persistence", () => {
  const secret = "super-secret-value-123";
  const message = `connecting with password=${secret}; mirror=${secret}`;
  const redacted = redactLogMessage(message, [secret]);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted, "connecting with password=[REDACTED]; mirror=[REDACTED]");
});

test("redacts common bearer, provider token and query credential shapes", () => {
  const message = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_1234567890abcdefghijklmnop",
    "https://example.test/callback?access_token=abcdefghijklmnopqrstuvwxyz",
    "api_key=abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const redacted = redactLogMessage(message, []);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(redacted.includes("github_pat_1234567890abcdefghijklmnop"), false);
  assert.equal(redacted.includes("access_token=abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("api_key=abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(redacted, /Bearer \[REDACTED\]/);
});

test("redacts credentials embedded in URLs", () => {
  const redacted = redactLogMessage("redis://default:verysecretpassword@redis:6379/0", []);
  assert.equal(redacted, "redis://default:[REDACTED]@redis:6379/0");
});

test("redacts longer overlapping secrets before shorter values", () => {
  const redacted = redactLogMessage("token-abcdef token-abc", ["token-abc", "token-abcdef"]);
  assert.equal(redacted, "[REDACTED] [REDACTED]");
});
