import assert from "node:assert/strict";
import test from "node:test";
import { decryptValue, encryptValue, parseMasterKey } from "./index";

const encodedKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");

test("service values round-trip through AES-256-GCM", () => {
  const key = parseMasterKey(encodedKey);
  const encrypted = encryptValue("smtp-password\nwith-second-line", key);
  assert.notEqual(encrypted.ciphertext, "smtp-password\nwith-second-line");
  assert.equal(decryptValue(encrypted, key), "smtp-password\nwith-second-line");
});

test("tampered ciphertext is rejected", () => {
  const key = parseMasterKey(encodedKey);
  const encrypted = encryptValue("secret", key);
  encrypted.ciphertext = Buffer.from("tampered", "utf8").toString("base64");
  assert.throws(() => decryptValue(encrypted, key));
});

test("master key must decode to 32 bytes", () => {
  assert.throws(() => parseMasterKey(Buffer.from("too-short").toString("base64")));
});
