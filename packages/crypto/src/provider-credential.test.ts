import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptProviderCredential,
  decryptValue,
  encryptProviderCredential,
  encryptValue,
} from "./index";

const key = Buffer.alloc(32, 7);

test("provider credentials round-trip without plaintext in the envelope", () => {
  const plaintext = "provider-secret-token";
  const encrypted = encryptProviderCredential(plaintext, key);
  assert.equal(decryptProviderCredential(encrypted, key), plaintext);
  assert.equal(JSON.stringify(encrypted).includes(plaintext), false);
});

test("provider credentials cannot be decrypted in the service-variable encryption domain", () => {
  const providerEncrypted = encryptProviderCredential("provider-secret", key);
  assert.throws(() => decryptValue(providerEncrypted, key));

  const serviceEncrypted = encryptValue("service-secret", key);
  assert.throws(() => decryptProviderCredential(serviceEncrypted, key));
});
