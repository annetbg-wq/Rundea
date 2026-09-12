import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubRepositoryInspection } from "./github-app-source";
import { inferGitHubProjectDiscovery } from "./github-project-discovery";

function inspection(overrides: Partial<GitHubRepositoryInspection> = {}): GitHubRepositoryInspection {
  return {
    installationId: 123,
    repositoryId: 456,
    repositoryFullName: "example/app",
    repositoryUrl: "https://github.com/example/app",
    visibility: "PRIVATE",
    defaultBranch: "main",
    selectedBranch: "main",
    revisionSha: "a".repeat(40),
    rootEntries: [],
    files: {},
    ...overrides,
  };
}

test("discovery infers a reviewable Node Docker app without exposing example secret values", () => {
  const result = inferGitHubProjectDiscovery(
    inspection({
      rootEntries: [".env.example", "Dockerfile", "package-lock.json", "package.json"],
      files: {
        "package.json": JSON.stringify({ scripts: { build: "vite build --mode production", start: "node dist/server.js" } }),
        Dockerfile: "FROM node:24\nARG BUILD_ID\nENV PORT=3000\nEXPOSE 3000\nCMD [\"npm\",\"start\"]\n",
        ".env.example": "DATABASE_URL=postgres://user:super-secret@example/db\nAPI_TOKEN=top-secret\n",
      },
    }),
  );

  assert.equal(result.reviewState, "READY_FOR_REVIEW");
  assert.deepEqual(result.discovery.runtimes.value, ["nodejs"]);
  assert.equal(result.discovery.runtimes.confidence, "HIGH_CONFIDENCE");
  assert.deepEqual(result.discovery.dockerfile, { value: "Dockerfile", confidence: "CONFIRMED", evidence: ["Dockerfile"] });
  assert.equal(result.discovery.buildCommand.value, "npm run build");
  assert.equal(result.discovery.startCommand.value, "npm start");
  assert.deepEqual(result.discovery.containerPorts.value, [3000]);
  assert.deepEqual(result.discovery.environmentVariableNames.value, ["API_TOKEN", "BUILD_ID", "DATABASE_URL", "PORT"]);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("top-secret"), false);
  assert.equal(serialized.includes("postgres://"), false);
  assert.equal(serialized.includes("vite build --mode production"), false);
  assert.equal(serialized.includes("node dist/server.js"), false);
});

test("multiple runtimes and workspace patterns require confirmation instead of guessing", () => {
  const result = inferGitHubProjectDiscovery(
    inspection({
      rootEntries: ["go.mod", "package.json", "pnpm-workspace.yaml"],
      files: {
        "go.mod": "module example.test/service\n\ngo 1.25\n",
        "package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
        "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      },
    }),
  );

  assert.equal(result.reviewState, "NEEDS_CONFIRMATION");
  assert.deepEqual(result.discovery.runtimes.value, ["go", "nodejs"]);
  assert.equal(result.discovery.runtimes.confidence, "NEEDS_CONFIRMATION");
  assert.equal(result.discovery.monorepo.value, true);
  assert.equal(result.discovery.monorepo.confidence, "CONFIRMED");
  assert.deepEqual(result.discovery.serviceCandidates.value, ["apps/*", "packages/*"]);
  assert.equal(result.discovery.serviceCandidates.confidence, "NEEDS_CONFIRMATION");
});

test("unknown repository shape stays explicit instead of fabricating a deployment plan", () => {
  const result = inferGitHubProjectDiscovery(inspection({ rootEntries: ["README.md"], files: {} }));

  assert.equal(result.reviewState, "NEEDS_CONFIRMATION");
  assert.deepEqual(result.discovery.runtimes.value, []);
  assert.equal(result.discovery.runtimes.confidence, "MISSING");
  assert.equal(result.discovery.dockerfile.value, null);
  assert.equal(result.discovery.buildCommand.value, null);
  assert.equal(result.discovery.startCommand.value, null);
  assert.deepEqual(result.discovery.containerPorts.value, []);
});
