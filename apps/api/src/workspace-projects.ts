import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OperationActor, OAuthOperationActor } from "./operation-actor";

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export type WorkspaceSummary = Readonly<{
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
}>;

export type ProjectSummary = Readonly<{
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
}>;

export class WorkspaceAccessError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export class WorkspaceConflictError extends Error {
  constructor() {
    super("workspace/project identifier already exists");
    this.name = "WorkspaceConflictError";
  }
}

const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

function requireName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 120 || /[\r\n\u0000]/.test(name)) {
    throw new WorkspaceAccessError(400, "name must contain 1-120 safe characters");
  }
  return name;
}

function requireSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slugPattern.test(slug)) {
    throw new WorkspaceAccessError(400, "slug must contain 3-64 lowercase letters, numbers or hyphens");
  }
  return slug;
}

function requireOAuthActor(actor: OperationActor | undefined): OAuthOperationActor {
  if (!actor || actor.authenticationMethod !== "OAUTH") {
    throw new WorkspaceAccessError(403, "authenticated user identity is required");
  }
  return actor;
}

export function workspaceRoleCanManage(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export interface WorkspaceProjectRepository {
  createWorkspaceWithOwner(input: {
    id: string;
    slug: string;
    name: string;
    issuer: string;
    subject: string;
  }): Promise<void>;
  listWorkspaces(issuer: string, subject: string): Promise<WorkspaceSummary[]>;
  membershipRole(workspaceId: string, issuer: string, subject: string): Promise<WorkspaceRole | null>;
  createProject(input: { id: string; workspaceId: string; slug: string; name: string }): Promise<void>;
  listProjects(workspaceId: string): Promise<ProjectSummary[]>;
}

export async function createWorkspaceForActor(
  repository: WorkspaceProjectRepository,
  actor: OperationActor | undefined,
  input: { slug: string; name: string },
): Promise<WorkspaceSummary> {
  const principal = requireOAuthActor(actor);
  const id = randomUUID();
  const slug = requireSlug(input.slug);
  const name = requireName(input.name);
  try {
    await repository.createWorkspaceWithOwner({ id, slug, name, issuer: principal.issuer, subject: principal.subject });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) throw new WorkspaceAccessError(409, "workspace slug is already in use");
    throw error;
  }
  return { id, slug, name, role: "OWNER" };
}

export async function listWorkspacesForActor(
  repository: WorkspaceProjectRepository,
  actor: OperationActor | undefined,
): Promise<WorkspaceSummary[]> {
  const principal = requireOAuthActor(actor);
  return repository.listWorkspaces(principal.issuer, principal.subject);
}

export async function createProjectForActor(
  repository: WorkspaceProjectRepository,
  actor: OperationActor | undefined,
  workspaceId: string,
  input: { slug: string; name: string },
): Promise<ProjectSummary> {
  const principal = requireOAuthActor(actor);
  const role = await repository.membershipRole(workspaceId, principal.issuer, principal.subject);
  if (!role) throw new WorkspaceAccessError(404, "workspace is unavailable");
  if (!workspaceRoleCanManage(role)) throw new WorkspaceAccessError(403, "workspace role cannot create projects");

  const id = randomUUID();
  const slug = requireSlug(input.slug);
  const name = requireName(input.name);
  try {
    await repository.createProject({ id, workspaceId, slug, name });
  } catch (error) {
    if (error instanceof WorkspaceConflictError) throw new WorkspaceAccessError(409, "project slug is already in use in this workspace");
    throw error;
  }
  return { id, workspaceId, slug, name };
}

export async function listProjectsForActor(
  repository: WorkspaceProjectRepository,
  actor: OperationActor | undefined,
  workspaceId: string,
): Promise<ProjectSummary[]> {
  const principal = requireOAuthActor(actor);
  const role = await repository.membershipRole(workspaceId, principal.issuer, principal.subject);
  if (!role) throw new WorkspaceAccessError(404, "workspace is unavailable");
  return repository.listProjects(workspaceId);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

export class PostgresWorkspaceProjectRepository implements WorkspaceProjectRepository {
  constructor(private readonly pool: Pool) {}

  async createWorkspaceWithOwner(input: {
    id: string;
    slug: string;
    name: string;
    issuer: string;
    subject: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,$3)", [input.id, input.slug, input.name]);
      await client.query(
        "INSERT INTO workspace_memberships(workspace_id,issuer,subject,role) VALUES($1,$2,$3,'OWNER')",
        [input.id, input.issuer, input.subject],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new WorkspaceConflictError();
      throw error;
    } finally {
      client.release();
    }
  }

  async listWorkspaces(issuer: string, subject: string): Promise<WorkspaceSummary[]> {
    const result = await this.pool.query(
      `SELECT w.id,w.slug,w.name,m.role
         FROM workspace_memberships m
         JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.issuer=$1 AND m.subject=$2
        ORDER BY w.created_at ASC,w.id ASC`,
      [issuer, subject],
    );
    return result.rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, role: row.role as WorkspaceRole }));
  }

  async membershipRole(workspaceId: string, issuer: string, subject: string): Promise<WorkspaceRole | null> {
    const result = await this.pool.query(
      "SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3",
      [workspaceId, issuer, subject],
    );
    return result.rowCount === 1 ? (result.rows[0].role as WorkspaceRole) : null;
  }

  async createProject(input: { id: string; workspaceId: string; slug: string; name: string }): Promise<void> {
    try {
      await this.pool.query("INSERT INTO projects(id,workspace_id,slug,name) VALUES($1,$2,$3,$4)", [
        input.id,
        input.workspaceId,
        input.slug,
        input.name,
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new WorkspaceConflictError();
      throw error;
    }
  }

  async listProjects(workspaceId: string): Promise<ProjectSummary[]> {
    const result = await this.pool.query(
      "SELECT id,workspace_id,slug,name FROM projects WHERE workspace_id=$1 ORDER BY created_at ASC,id ASC",
      [workspaceId],
    );
    return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, slug: row.slug, name: row.name }));
  }
}
