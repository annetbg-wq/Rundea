import assert from "node:assert/strict";
import test from "node:test";
import { registryHostFromImageRef, resolveRegistryPullConfig } from "./registry-pull-broker";

test("resolveRegistryPullConfig keeps registry pull credentials optional", () => {
  assert.deepEqual(resolveRegistryPullConfig({
    RUNDEA_BUILD_REGISTRY_PREFIX: "ghcr.io/acme/builds",
  } as NodeJS.ProcessEnv), {
    registryHost: "ghcr.io",
    username: null,
    password: null,
  });
});

test("resolveRegistryPullConfig binds credentials to build registry host", () => {
  assert.deepEqual(resolveRegistryPullConfig({
    RUNDEA_BUILD_REGISTRY_PREFIX: "registry.example.com:5443/rundea",
    RUNDEA_REGISTRY_PULL_USERNAME: "pull-only",
    RUNDEA_REGISTRY_PULL_PASSWORD: "secret",
  } as NodeJS.ProcessEnv), {
    registryHost: "registry.example.com:5443",
    username: "pull-only",
    password: "secret",
  });
});

test("resolveRegistryPullConfig rejects incomplete credentials", () => {
  assert.throws(() => resolveRegistryPullConfig({
    RUNDEA_BUILD_REGISTRY_PREFIX: "ghcr.io/acme/builds",
    RUNDEA_REGISTRY_PULL_USERNAME: "pull-only",
  } as NodeJS.ProcessEnv));
});

test("registryHostFromImageRef requires explicit registry host", () => {
  const digest = "sha256:" + "a".repeat(64);
  assert.equal(registryHostFromImageRef("ghcr.io/acme/app@" + digest), "ghcr.io");
  assert.equal(registryHostFromImageRef("localhost:5000/acme/app@" + digest), "localhost:5000");
  assert.throws(() => registryHostFromImageRef("app@" + digest));
});
