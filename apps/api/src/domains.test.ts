import assert from "node:assert/strict";
import test from "node:test";
import {
  domainRetryDelaySeconds,
  domainVerificationStageForError,
  normalizeDomainHostname,
  validateDomainHostname,
} from "./domains";

test("normalizes domain hostnames before persistence", () => {
  assert.equal(normalizeDomainHostname(" API.Example.COM. "), "api.example.com");
  assert.equal(validateDomainHostname("Api.Example.com"), "api.example.com");
});

test("rejects unsafe or non-hostname domain inputs", () => {
  for (const value of ["", "localhost", "*.example.com", "https://example.com", "example.com/path", "-bad.example.com", "bad_.example.com"]) {
    assert.throws(() => validateDomainHostname(value), value);
  }
});


test("classifies transient domain verification failures into operator-visible stages", () => {
  assert.equal(domainVerificationStageForError("lookup api.example.com: no such host"), "DNS_RESOLVING");
  assert.equal(domainVerificationStageForError("TLS handshake failed: x509 certificate not ready"), "TLS_ISSUING");
  assert.equal(domainVerificationStageForError("public HTTPS returned 502 Bad Gateway"), "HTTPS_VERIFYING");
});

test("domain verification retries use bounded exponential backoff", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(domainRetryDelaySeconds),
    [5, 10, 20, 40, 80, null],
  );
  assert.equal(domainRetryDelaySeconds(0), null);
  assert.equal(domainRetryDelaySeconds(7), null);
});
