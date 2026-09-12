import type { Pool } from "pg";
import type { GitHubRepositoryInspection } from "./github-app-source";
import { inferGitHubProjectDiscovery, type GitHubProjectDiscovery } from "./github-project-discovery";
import type { OperationActor, OAuthOperationActor } from "./operation-actor";
import { workspaceRoleCanManage, type WorkspaceRole } from "./workspace-projects";

export type ProjectSourceSummary = Readonly<{
  projectId: string;
  provider: "GITHUB";
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  repositoryUrl: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  defaultBranch: string;
  selectedBranch: string;
  revisionSha: string;
  reviewState: "READY_FOR_REVIEW" | "NEEDS_CONFIRMATION";
  discovery: GitHubProjectDiscovery["discovery"];
  discoveredAt: string;
  updatedAt: string;
}>;

export class ProjectSourceAccessError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ProjectSourceAccessError";
  }
}

export interface GitHubRepositoryInspector {
  inspectRepository(repositoryFullName: string, selectedBranch?: string): Promise<GitHubRepositoryInspection>;
}

export interface ProjectSourceRepository {
  projectRole(projectId: string, issuer: string, subject: string): Promise<WorkspaceRole | null>;
  upsertGitHubSource(projectId: string, source: GitHubProjectDiscovery): Promise<ProjectSourceSummary>;
  getProjectSource(projectId: string): Promise<ProjectSourceSummary | null>;
}

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryFullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requireOAuthActor(actor: OperationActor | undefined): OAuthOperationActor {
  if (!actor || actor.authenticationMethod !== "OAUTH") {
    throw new ProjectSourceAccessError(403, "authenticated user identity is required");
  }
  return actor;
}

function requireProjectId(value: string): string {
  if (!projectIdPattern.test(value)) throw new ProjectSourceAccessError(400, "projectId must be a UUID");
  return value;
}

function requireRepositoryFullName(value: string): string {
  const fullName = value.trim();
  if (!repositoryFullNamePattern.test(fullName) || fullName.length > 200) {
    throw new ProjectSourceAccessError(400, "repositoryFullName must identify GitHub owner/repository");
  }
  return fullName;
}

function requireSelectedBranch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const branch = value.trim();
  if (!branch || branch.length > 255 || /[\r\n\u0000]/.test(branch)) {
    throw new ProjectSourceAccessError(400, "selectedBranch is invalid");
  }
  return branch;
}

async function projectRoleForActor(
  repository: ProjectSourceRepository,
  actor: OperationActor | undefined,
  projectId: string,
): Promise<{ principal: OAuthOperationActor; role: WorkspaceRole; projectId: string }> {
  const principal = requireOAuthActor(actor);
  const safeProjectId = requireProjectId(projectId);
  const role = await repository.projectRole(safeProjectId, principal.issuer, principal.subject);
  if (!role) throw new ProjectSourceAccessError(404, "project is unavailable");
  return { principal, role, projectId: safeProjectId };
}

export async function connectGitHubSourceForActor(
  repository: ProjectSourceRepository,
  github: GitHubRepositoryInspector,
  actor: OperationActor | undefined,
  projectId: string,
  input: { repositoryFullName: string; selectedBranch?: string },
): Promise<ProjectSourceSummary> {
  const access = await projectRoleForActor(repository, actor, projectId);
  if (!workspaceRoleCanManage(access.role)) {
    throw new ProjectSourceAccessError(403, "workspace role cannot change project source");
  }

  const repositoryFullName = requireRepositoryFullName(input.repositoryFullName);
  const selectedBranch = requireSelectedBranch(input.selectedBranch);
  let inspection: GitHubRepositoryInspection;
  try {
    inspection = await github.inspectRepository(repositoryFullName, selectedBranch);
  } catch {
    throw new ProjectSourceAccessError(502, "GitHub repository discovery failed");
  }

  const source = inferGitHubProjectDiscovery(inspection);
  return await repository.upsertGitHubSource(access.projectId, source);
}

export async function getProjectSourceForActor(
  repository: ProjectSourceRepository,
  actor: OperationActor | undefined,
  projectId: string,
): Promise<ProjectSourceSummary | null> {
  const access = await projectRoleForActor(repository, actor, projectId);
  return await repository.getProjectSource(access.projectId);
}

function mapProjectSourceRow(row: Record<string, any>): ProjectSourceSummary {
  const installationId = Number(row.provider_installation_id);
  const repositoryId = Number(row.provider_repository_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error("stored GitHub source identity is invalid");
  }
  return {
    projectId: String(row.project_id),
    provider: "GITHUB",
    installationId,
    repositoryId,
    repositoryFullName: String(row.repository_full_name),
    repositoryUrl: String(row.repository_url),
    visibility: row.visibility as ProjectSourceSummary["visibility"],
    defaultBranch: String(row.default_branch),
    selectedBranch: String(row.selected_branch),
    revisionSha: String(row.revision_sha),
    reviewState: row.review_state as ProjectSourceSummary["reviewState"],
    discovery: row.discovery as GitHubProjectDiscovery["discovery"],
    discoveredAt: new Date(row.discovered_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresProjectSourceRepository implements ProjectSourceRepository {
  constructor(private readonly pool: Pool) {}

  async projectRole(projectId: string, issuer: string, subject: string): Promise<WorkspaceRole | null> {
    const result = await this.pool.query(
      `SELECT m.role
         FROM projects p
         JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
        WHERE p.id=$1 AND m.issuer=$2 AND m.subject=$3`,
      [projectId, issuer, subject],
    );
    return result.rowCount === 1 ? (result.rows[0].role as WorkspaceRole) : null;
  }

  async upsertGitHubSource(projectId: string, source: GitHubProjectDiscovery): Promise<ProjectSourceSummary> {
    const result = await this.pool.query(
      `INSERT INTO project_sources(
         project_id,provider,provider_installation_id,provider_repository_id,repository_full_name,repository_url,
         visibility,default_branch,selected_branch,revision_sha,review_state,discovery,discovered_at,updated_at
       ) VALUES($1,'GITHUB',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),now())
       ON CONFLICT(project_id) DO UPDATE SET
         provider='GITHUB',
         provider_installation_id=EXCLUDED.provider_installation_id,
         provider_repository_id=EXCLUDED.provider_repository_id,
         repository_full_name=EXCLUDED.repository_full_name,
         repository_url=EXCLUDED.repository_url,
         visibility=EXCLUDED.visibility,
         default_branch=EXCLUDED.default_branch,
         selected_branch=EXCLUDED.selected_branch,
         revision_sha=EXCLUDED.revision_sha,
         review_state=EXCLUDED.review_state,
         discovery=EXCLUDED.discovery,
         discovered_at=now(),
         updated_at=now()
       RETURNING *`,
      [
        projectId,
        source.installationId,
        source.repositoryId,
        source.repositoryFullName,
        source.repositoryUrl,
        source.visibility,
        source.defaultBranch,
        source.selectedBranch,
        source.revisionSha,
        source.reviewState,
        JSON.stringify(source.discovery),
      ],
    );
    if (result.rowCount !== 1) throw new Error("project source upsert did not return a row");
    return mapProjectSourceRow(result.rows[0]);
  }

  async getProjectSource(projectId: string): Promise<ProjectSourceSummary | null> {
    const result = await this.pool.query("SELECT * FROM project_sources WHERE project_id=$1", [projectId]);
    return result.rowCount === 1 ? mapProjectSourceRow(result.rows[0]) : null;
  }
}
