import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuilderConfig } from "./config";

test("builder config has bounded defaults", () => {
  const config = resolveBuilderConfig({
    RUNDEA_CONTROL_PLANE_URL: "https://rundea.example.com",
    RUNDEA_BUILDER_TOKEN: "secret",
    RUNDEA_BUILDER_ID: "worker-1",
  } as NodeJS.ProcessEnv);
  assert.equal(config.timeoutMs, 900000);
  assert.equal(config.memoryBytes, 4294967296);
  assert.equal(config.cpuQuota, 200000);
  assert.equal(config.cpuPeriod, 100000);
});

test("registry credentials are paired", () => {
  assert.throws(() => resolveBuilderConfig({
    RUNDEA_CONTROL_PLANE_URL: "https://rundea.example.com",
    RUNDEA_BUILDER_TOKEN: "secret",
    RUNDEA_REGISTRY_USERNAME: "user",
  } as NodeJS.ProcessEnv), /configured together/);
});
