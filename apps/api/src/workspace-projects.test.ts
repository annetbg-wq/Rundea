import assert from "node:assert/strict";
import test from "node:test";
import { staticTokenOperationActor, type OAuthOperationActor } from "./operation-actor";
import {
  createProjectForActor,
  createWorkspaceForActor,
  listProjectsForActor,
  listWorkspacesForActor,
  WorkspaceAccessError,
  WorkspaceConflictError,
  type ProjectSummary,
  type WorkspaceProjectRepository,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "./workspace-projects";

const alice: OAuthOperationActor = {
  authenticationMethod: "OAUTH",
  issuer: "https://auth.rundea.test",
  subject: "alice",
  scopes: ["openid"],
};
const bob: OAuthOperationActor = { ...alice, subject: "bob" };

class MemoryRepository implements WorkspaceProjectRepository {
  workspaces: WorkspaceSummary[] = [];
  memberships = new Map<string, WorkspaceRole>();
  projects: ProjectSummary[] = [];

  private membershipKey(workspaceId: string, issuer: string, subject: string) {
    return `${workspaceId}\u0000${issuer}\u0000${subject}`;
  }

  async createWorkspaceWithOwner(input: { id: string; slug: string; name: string; issuer: string; subject: string }) {
    if (this.workspaces.some((workspace) => workspace.slug === input.slug)) throw new WorkspaceConflictError();
    this.workspaces.push({ id: input.id, slug: input.slug, name: input.name, role: "OWNER" });
    this.memberships.set(this.membershipKey(input.id, input.issuer, input.subject), "OWNER");
  }

  async listWorkspaces(issuer: string, subject: string) {
    return this.workspaces.flatMap((workspace) => {
      const role = this.memberships.get(this.membershipKey(workspace.id, issuer, subject));
      return role ? [{ ...workspace, role }] : [];
    });
  }

  async membershipRole(workspaceId: string, issuer: string, subject: string) {
    return this.memberships.get(this.membershipKey(workspaceId, issuer, subject)) ?? null;
  }

  async createProject(input: { id: string; workspaceId: string; slug: string; name: string }) {
    if (this.projects.some((project) => project.workspaceId === input.workspaceId && project.slug === input.slug)) {
      throw new WorkspaceConflictError();
    }
    this.projects.push(input);
  }

  async listProjects(workspaceId: string) {
    return this.projects.filter((project) => project.workspaceId === workspaceId);
  }

  grant(workspaceId: string, actor: OAuthOperationActor, role: WorkspaceRole) {
    this.memberships.set(this.membershipKey(workspaceId, actor.issuer, actor.subject), role);
  }
}

async function assertAccessError(promise: Promise<unknown>, statusCode: number) {
  await assert.rejects(promise, (error: unknown) => error instanceof WorkspaceAccessError && error.statusCode === statusCode);
}

test("workspace creation binds ownership to the authenticated OAuth actor", async () => {
  const repository = new MemoryRepository();
  const workspace = await createWorkspaceForActor(repository, alice, { slug: "alice-team", name: "Alice Team" });
  assert.equal(workspace.role, "OWNER");
  assert.equal(await repository.membershipRole(workspace.id, alice.issuer, alice.subject), "OWNER");
  assert.deepEqual(await listWorkspacesForActor(repository, alice), [workspace]);
  assert.deepEqual(await listWorkspacesForActor(repository, bob), []);
});

test("static administrative MCP identity cannot masquerade as a workspace user", async () => {
  const repository = new MemoryRepository();
  await assertAccessError(
    createWorkspaceForActor(repository, staticTokenOperationActor, { slug: "admin-space", name: "Admin Space" }),
    403,
  );
});

test("only owner or admin can create projects", async () => {
  const repository = new MemoryRepository();
  const workspace = await createWorkspaceForActor(repository, alice, { slug: "team-one", name: "Team One" });

  repository.grant(workspace.id, bob, "VIEWER");
  await assertAccessError(
    createProjectForActor(repository, bob, workspace.id, { slug: "viewer-app", name: "Viewer App" }),
    403,
  );

  repository.grant(workspace.id, bob, "ADMIN");
  const project = await createProjectForActor(repository, bob, workspace.id, { slug: "backend-api", name: "Backend API" });
  assert.equal(project.workspaceId, workspace.id);
  assert.deepEqual(await listProjectsForActor(repository, alice, workspace.id), [project]);
});

test("unknown workspace membership fails without exposing workspace contents", async () => {
  const repository = new MemoryRepository();
  const workspace = await createWorkspaceForActor(repository, alice, { slug: "private-team", name: "Private Team" });
  await assertAccessError(listProjectsForActor(repository, bob, workspace.id), 404);
});

test("workspace and project slugs are bounded and conflicts are deterministic", async () => {
  const repository = new MemoryRepository();
  const workspace = await createWorkspaceForActor(repository, alice, { slug: "valid-team", name: "Valid Team" });

  await assertAccessError(createWorkspaceForActor(repository, alice, { slug: "UP", name: "Bad" }), 400);
  await assertAccessError(createWorkspaceForActor(repository, alice, { slug: "valid-team", name: "Again" }), 409);

  await createProjectForActor(repository, alice, workspace.id, { slug: "api-one", name: "API One" });
  await assertAccessError(
    createProjectForActor(repository, alice, workspace.id, { slug: "api-one", name: "API Duplicate" }),
    409,
  );
});
