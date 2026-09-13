import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { agentAssetName, BundledAgentReleaseProvider } from "./agent-release";

test("bundled Agent provider derives immutable release metadata from image contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rundea-agent-bundle-"));
  try {
    const binary = Buffer.from("test-agent-binary");
    await writeFile(join(directory, "VERSION"), "0.1.2\n");
    await writeFile(join(directory, agentAssetName("amd64")), binary);

    const provider = new BundledAgentReleaseProvider(directory);
    const release = await provider.get("amd64");

    assert.equal(release.tag, "agent-v0.1.2");
    assert.equal(release.filename, "rundea-agent-linux-amd64");
    assert.equal(release.sha256, createHash("sha256").update(binary).digest("hex"));
    assert.deepEqual(release.binary, binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
