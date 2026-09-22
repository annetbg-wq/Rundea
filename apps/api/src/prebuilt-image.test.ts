import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeArtifactSourceCommit,
  normalizePrebuiltImageRef,
  supportsPrebuiltImages,
} from "./prebuilt-image";

test("accepts only digest-pinned registry image references", () => {
  const digest = "a".repeat(64);
  assert.equal(
    normalizePrebuiltImageRef(`ghcr.io/acme/momna@sha256:${digest}`),
    `ghcr.io/acme/momna@sha256:${digest}`,
  );
  assert.equal(
    normalizePrebuiltImageRef(`localhost:5000/momna@sha256:${digest}`),
    `localhost:5000/momna@sha256:${digest}`,
  );
  assert.throws(() => normalizePrebuiltImageRef("ghcr.io/acme/momna:latest"), /immutable/);
  assert.throws(() => normalizePrebuiltImageRef(`ghcr.io/acme/momna@sha256:${"A".repeat(64)}`), /immutable/);
  assert.throws(() => normalizePrebuiltImageRef(`momna@sha256:${digest}`), /registry image/);
});

test("requires exact immutable source provenance", () => {
  assert.equal(normalizeArtifactSourceCommit("A".repeat(40)), "a".repeat(40));
  assert.throws(() => normalizeArtifactSourceCommit("main"), /40-character Git SHA/);
});

test("detects selective Agent capability", () => {
  assert.equal(supportsPrebuiltImages(["runtimeMetrics", "prebuiltImages"]), true);
  assert.equal(supportsPrebuiltImages(["runtimeMetrics"]), false);
  assert.equal(supportsPrebuiltImages(null), false);
});
