import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubRepositoryInspection } from "./github-app-source";
import { staticTokenOperationActor, type OAuthOperationActor } from "./operation-actor";
import {
  connectGitHubSourceForActor,
  getProjectSourceForActor,
  ProjectSourceAccessError,
  type GitHubRepositoryInspector,
  type ProjectSourceRepository,
  type ProjectSourceSummary,
} from "./project-sources";
import type { GitHubProjectDiscovery } from "./github-project-discovery";
import type { WorkspaceRole } from "./workspace-projects";

const projectId = "11111111-1111-4111-8111-111111111111";
const alice: OAuthOperationActor = {
  authenticationMethod: "OAUTH",
  issuer: "https://auth.rundea.test",
  subject: "alice",
  scopes: ["openid"],
};
const bob: OAuthOperationActor = { ...alice, subject: "bob" };

function inspection(): GitHubRepositoryInspection {
  return {
    installationId: 100,
    repositoryId: 200,
    repositoryFullName: "example/app",
    repositoryUrl: "https://github.com/example/app",
    visibility: "PRIVATE",
    defaultBranch: "main",
    selectedBranch: "main",
    revisionSha: "b".repeat(40),
    rootEntries: ["Dockerfile", "package.json"],
    files: {
      Dockerfile: "FROM node:24\nEXPOSE 3000\n",
      "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    },
  };
}

class MemoryRepository implements ProjectSourceRepository {
  roles = new Map<string, WorkspaceRole>();
  source: ProjectSourceSummary | null = null;

  private key(actor: OAuthOperationActor) {
    return `${actor.issuer}\u0000${actor.subject}`;
  }

  grant(actor: OAuthOperationActor, role: WorkspaceRole) {
    this.roles.set(this.key(actor), role);
  }

  async projectRole(_projectId: string, issuer: string, subject: string) {
    return this.roles.get(`${issuer}\u0000${subject}`) ?? null;
  }

  async upsertGitHubSource(targetProjectId: string, source: GitHubProjectDiscovery) {
    const now = new Date(0).toISOString();
    this.source = {
      projectId: targetProjectId,
      provider: "GITHUB",
      installationId: source.installationId,
      repositoryId: source.repositoryId,
      repositoryFullName: source.repositoryFullName,
      repositoryUrl: source.repositoryUrl,
      visibility: source.visibility,
      defaultBranch: source.defaultBranch,
      selectedBranch: source.selectedBranch,
      revisionSha: source.revisionSha,
      reviewState: source.reviewState,
      discovery: source.discovery,
      discoveredAt: now,
      updatedAt: now,
    };
    return this.source;
  }

  async getProjectSource(_projectId: string) {
    return this.source;
  }
}

class FakeInspector implements GitHubRepositoryInspector {
  calls = 0;
  constructor(private readonly value: GitHubRepositoryInspection = inspection()) {}

  async inspectRepository(repositoryFullName: string, selectedBranch?: string) {
    this.calls += 1;
    assert.equal(repositoryFullName, "example/app");
    assert.equal(selectedBranch, undefined);
    return this.value;
  }
}

async function assertAccessError(promise: Promise<unknown>, statusCode: number) {
  await assert.rejects(promise, (error: unknown) => error instanceof ProjectSourceAccessError && error.statusCode === statusCode);
}

test("workspace owner can connect GitHub source and persist only inferred project metadata", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");
  const github = new FakeInspector();

  const source = await connectGitHubSourceForActor(repository, github, alice, projectId, { repositoryFullName: "example/app" });

  assert.equal(github.calls, 1);
  assert.equal(source.projectId, projectId);
  assert.equal(source.repositoryFullName, "example/app");
  assert.equal(source.revisionSha, "b".repeat(40));
  assert.deepEqual(source.discovery.runtimes.value, ["nodejs"]);
  assert.deepEqual(source.discovery.containerPorts.value, [3000]);
  assert.equal(JSON.stringify(source).includes("node server.js"), false);
});

test("viewer is rejected before any GitHub API discovery occurs", async () => {
  const repository = new MemoryRepository();
  repository.grant(bob, "VIEWER");
  const github = new FakeInspector();

  await assertAccessError(
    connectGitHubSourceForActor(repository, github, bob, projectId, { repositoryFullName: "example/app" }),
    403,
  );
  assert.equal(github.calls, 0);
});

test("static administrative identity cannot connect or read an end-user project source", async () => {
  const repository = new MemoryRepository();
  const github = new FakeInspector();

  await assertAccessError(
    connectGitHubSourceForActor(repository, github, staticTokenOperationActor, projectId, { repositoryFullName: "example/app" }),
    403,
  );
  await assertAccessError(getProjectSourceForActor(repository, staticTokenOperationActor, projectId), 403);
  assert.equal(github.calls, 0);
});

test("non-member receives 404 and member can read an already connected source", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");
  repository.grant(bob, "MEMBER");
  const github = new FakeInspector();
  await connectGitHubSourceForActor(repository, github, alice, projectId, { repositoryFullName: "example/app" });

  const charlie: OAuthOperationActor = { ...alice, subject: "charlie" };
  await assertAccessError(getProjectSourceForActor(repository, charlie, projectId), 404);
  assert.equal((await getProjectSourceForActor(repository, bob, projectId))?.repositoryFullName, "example/app");
});

test("GitHub discovery failure is fail-closed and does not persist a source", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "ADMIN");
  const github: GitHubRepositoryInspector = {
    async inspectRepository() {
      throw new Error("provider unavailable");
    },
  };

  await assertAccessError(
    connectGitHubSourceForActor(repository, github, alice, projectId, { repositoryFullName: "example/app" }),
    502,
  );
  assert.equal(repository.source, null);
});
