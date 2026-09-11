import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverGitHubSource,
  type GitHubRepositoryReader,
  type GitHubTreeEntry,
} from "./github-source-discovery";

class MemoryReader implements GitHubRepositoryReader {
  readonly blobs = new Map<string, string>();
  entries: GitHubTreeEntry[] = [];
  readCalls: string[] = [];

  async repository(fullName: string) {
    return {
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      visibility: "private" as const,
      defaultBranch: "main",
    };
  }

  async resolveRevision() {
    return {
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    };
  }

  async tree() {
    return this.entries;
  }

  async readTextBlob(_fullName: string, blobSha: string, _maxBytes: number) {
    this.readCalls.push(blobSha);
    return this.blobs.get(blobSha) ?? null;
  }
}

function fixtureReader() {
  const reader = new MemoryReader();
  reader.entries = [
    { path: "Dockerfile", type: "blob", sha: "docker", size: 200 },
    { path: "package.json", type: "blob", sha: "package", size: 300 },
    { path: ".env.example", type: "blob", sha: "env", size: 200 },
    { path: "apps/worker/package.json", type: "blob", sha: "worker-package", size: 200 },
    { path: "apps/worker/Dockerfile", type: "blob", sha: "worker-docker", size: 200 },
    { path: "README.md", type: "blob", sha: "readme", size: 999 },
  ];
  reader.blobs.set(
    "package",
    JSON.stringify({
      workspaces: ["apps/*"],
      scripts: { build: "tsc -b", start: "node dist/server.js" },
    }),
  );
  reader.blobs.set("worker-package", JSON.stringify({ scripts: { start: "node worker.js" } }));
  reader.blobs.set(
    "docker",
    "FROM node:24-alpine\nEXPOSE 4000/tcp\nHEALTHCHECK CMD wget -qO- http://localhost:4000/health || exit 1\n",
  );
  reader.blobs.set("worker-docker", "FROM node:24-alpine\nEXPOSE 4100\n");
  reader.blobs.set(
    "env",
    "# template only\nDATABASE_URL=postgres://secret-that-must-never-be-returned\nexport PORT=4000\nINVALID-NAME=value\n",
  );
  return reader;
}

test("GitHub discovery returns deploy-relevant metadata without env values", async () => {
  const reader = fixtureReader();
  const result = await discoverGitHubSource(reader, "acme/payments");

  assert.equal(result.repository.fullName, "acme/payments");
  assert.equal(result.selectedRef, "main");
  assert.equal(result.commitSha, "a".repeat(40));
  assert.deepEqual(result.dockerfiles, ["Dockerfile", "apps/worker/Dockerfile"]);
  assert.deepEqual(result.runtimeCandidates, [
    { runtime: "docker", confidence: "CONFIRMED", source: "Dockerfile" },
    { runtime: "node", confidence: "HIGH_CONFIDENCE", source: "package.json" },
  ]);
  assert.equal(result.buildCommand.value, "npm run build");
  assert.equal(result.startCommand.value, "npm start");
  assert.deepEqual(result.portCandidates, [4000, 4100]);
  assert.deepEqual(result.healthcheckPathCandidates, ["/health"]);
  assert.equal(result.monorepo.value, true);
  assert.equal(result.monorepo.confidence, "CONFIRMED");
  assert.deepEqual(result.serviceCandidates, [".", "apps/worker"]);
  assert.deepEqual(result.environmentVariableNames, ["DATABASE_URL", "PORT"]);
  assert.equal(JSON.stringify(result).includes("secret-that-must-never-be-returned"), false);
  assert.equal(reader.readCalls.includes("readme"), false);
});

test("explicit deployment ref overrides default branch and remains bounded", async () => {
  const reader = fixtureReader();
  const result = await discoverGitHubSource(reader, "acme/payments", "release/2026-09");
  assert.equal(result.selectedRef, "release/2026-09");
  await assert.rejects(discoverGitHubSource(reader, "acme/payments", "bad\nref"), /source ref is invalid/);
});

test("oversized relevant blobs are not read", async () => {
  const reader = fixtureReader();
  reader.entries = [{ path: ".env.example", type: "blob", sha: "huge-env", size: 100_000 }];
  reader.blobs.set("huge-env", "SECRET=value");
  const result = await discoverGitHubSource(reader, "acme/payments");
  assert.deepEqual(result.environmentVariableNames, []);
  assert.deepEqual(reader.readCalls, []);
});

test("repository tree is bounded before discovery work", async () => {
  const reader = new MemoryReader();
  reader.entries = Array.from({ length: 5001 }, (_, index) => ({
    path: `file-${index}.txt`,
    type: "blob" as const,
    sha: String(index).padStart(40, "0").slice(0, 40),
    size: 1,
  }));
  await assert.rejects(discoverGitHubSource(reader, "acme/huge"), /tree exceeds discovery limit/);
  assert.deepEqual(reader.readCalls, []);
});
