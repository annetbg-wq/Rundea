import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRegistryPrefix, resolveBuildEngineConfig } from "./build-engine";

test("normalizes build registry prefix", () => {
  assert.equal(normalizeRegistryPrefix("GHCR.IO/Acme/Rundea/"), "ghcr.io/acme/rundea");
  assert.equal(normalizeRegistryPrefix(undefined), null);
  assert.throws(() => normalizeRegistryPrefix("https://ghcr.io/acme"), /without scheme/);
  assert.throws(() => normalizeRegistryPrefix("ghcr.io"), /host and repository path/);
  assert.throws(() => normalizeRegistryPrefix("ghcr.io/acme@sha256:abc"), /without scheme/);
});

test("build engine config keeps only token hash", () => {
  const config = resolveBuildEngineConfig({
    RUNDEA_BUILDER_TOKEN: "builder-super-secret",
    RUNDEA_BUILD_REGISTRY_PREFIX: "registry.example.com/rundea",
  } as NodeJS.ProcessEnv);
  assert.match(config.builderTokenHash ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(config.builderTokenHash, "builder-super-secret");
  assert.equal(config.registryPrefix, "registry.example.com/rundea");
});
