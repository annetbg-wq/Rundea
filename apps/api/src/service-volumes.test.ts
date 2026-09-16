import assert from "node:assert/strict";
import test from "node:test";
import { dockerVolumeName, validateMountPath, validateVolumeName } from "./service-volumes";

test("normalizes persistent volume identity without exposing Docker naming choice", () => {
  assert.equal(validateVolumeName("  Cache-01  "), "cache-01");
  assert.equal(
    dockerVolumeName("22222222-2222-4222-8222-222222222222"),
    "rundea-vol-22222222222242228222222222222222",
  );
});

test("normalizes safe absolute mount paths", () => {
  assert.equal(validateMountPath(" /var/lib/app/data/ "), "/var/lib/app/data");
});

test("rejects root, traversal, commas and control characters in mount paths", () => {
  for (const value of ["/", "relative", "/data/../secret", "/data,other", "/data\nother", "/data\0other"]) {
    assert.throws(() => validateMountPath(value));
  }
});