import assert from "node:assert/strict";
import test from "node:test";
import { agentAssetName, createAgentReleaseProviderFromEnv } from "./agent-release";

const liveEnabled = process.env.RUNDEA_LIVE_AGENT_RELEASE === "1";

test("live GitHub App provider downloads and verifies the private Agent release", { skip: !liveEnabled }, async () => {
  const provider = createAgentReleaseProviderFromEnv();
  assert.ok(provider, "live Agent release provider configuration is required");

  const expectedTag = process.env.RUNDEA_AGENT_RELEASE_TAG;
  assert.ok(expectedTag, "RUNDEA_AGENT_RELEASE_TAG is required");

  for (const architecture of ["amd64", "arm64"] as const) {
    const release = await provider.get(architecture);
    assert.equal(release.architecture, architecture);
    assert.equal(release.filename, agentAssetName(architecture));
    assert.equal(release.tag, expectedTag);
    assert.match(release.sha256, /^[0-9a-f]{64}$/);
    assert.ok(release.binary.length > 0, `${architecture} Agent release is empty`);
  }
});
