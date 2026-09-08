import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDomainHostname, validateDomainHostname } from "./domains";

test("normalizes domain hostnames before persistence", () => {
  assert.equal(normalizeDomainHostname(" API.Example.COM. "), "api.example.com");
  assert.equal(validateDomainHostname("Api.Example.com"), "api.example.com");
});

test("rejects unsafe or non-hostname domain inputs", () => {
  for (const value of ["", "localhost", "*.example.com", "https://example.com", "example.com/path", "-bad.example.com", "bad_.example.com"]) {
    assert.throws(() => validateDomainHostname(value), value);
  }
});
