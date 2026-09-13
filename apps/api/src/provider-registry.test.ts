import assert from "node:assert/strict";
import test from "node:test";
import { providerCatalog, providerDefinition } from "./provider-registry";

test("initial provider catalog stays registry-driven and excludes Oracle Cloud", () => {
  const catalog = providerCatalog();
  assert.deepEqual(
    catalog.map((provider) => provider.id),
    ["hetzner", "aws", "gcp", "azure", "digitalocean", "ovhcloud", "vultr", "akamai-linode", "scaleway", "generic-vps"],
  );
  assert.equal(catalog.some((provider) => provider.id.includes("oracle")), false);
  assert.equal(providerDefinition("oracle"), null);
  assert.equal(providerDefinition("hetzner")?.adapterStatus, "AVAILABLE");
  assert.equal(providerDefinition("generic-vps")?.adapterStatus, "GENERIC");
});

test("Hetzner guidance contains the exact console path and permission Rundea should ask for", () => {
  const hetzner = providerDefinition("hetzner");
  assert.ok(hetzner);
  assert.deepEqual(hetzner.connectionMethods, ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"]);
  assert.equal(hetzner.guidance.length, 1);
  assert.deepEqual(hetzner.guidance[0]?.path, ["Project", "Security", "API Tokens", "Generate API Token"]);
  assert.deepEqual(hetzner.guidance[0]?.requiredPermissions, ["Read & Write"]);
  assert.match(hetzner.guidance[0]?.verification ?? "", /server inventory/i);
});
