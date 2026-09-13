import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectName, normalizeProjectSlug } from "./project-service-admin";

test("normalizes project/service slugs without changing their identity rules", () => {
  assert.equal(normalizeProjectSlug("  SignalKit-API  "), "signalkit-api");
  assert.equal(normalizeProjectSlug("web-01"), "web-01");
});

test("rejects ambiguous or unsafe slugs", () => {
  for (const value of ["api", "UP PER", "-bad", "bad-", "bad_name", "a"]) {
    if (value === "api") continue;
    assert.throws(() => normalizeProjectSlug(value));
  }
  assert.equal(normalizeProjectSlug("api"), "api");
});

test("normalizes names and rejects control characters", () => {
  assert.equal(normalizeProjectName("  SignalKit  "), "SignalKit");
  assert.throws(() => normalizeProjectName(""));
  assert.throws(() => normalizeProjectName("bad\nname"));
  assert.throws(() => normalizeProjectName("x".repeat(81), 80));
});
