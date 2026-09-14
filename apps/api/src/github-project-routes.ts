import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { GitHubProjectConnector } from "./github-project-connector";
import { PostgresProjectSourceRepository } from "./project-sources";
import { internalLegacyProjectId, internalLegacyWorkspaceId } from "./service-scope";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function requireProjectId(value: string): string {
  const projectId = value.trim().toLowerCase();
  if (!uuidPattern.test(projectId)) throw new Error("projectId must be a UUID");
  return projectId;
}

async function requireActiveProject(pool: Pool, projectId: string): Promise<void> {
  const result = await pool.query(
    `SELECT 1
       FROM projects p
      WHERE p.id=$1 AND p.status='ACTIVE' AND p.id<>$2 AND p.workspace_id<>$3`,
    [projectId, internalLegacyProjectId, internalLegacyWorkspaceId],
  );
  if (result.rowCount !== 1) throw new Error("active project is unavailable");
}

function requireRepositoryFullName(value: string | undefined): string {
  const fullName = value?.trim() ?? "";
  if (!repositoryPattern.test(fullName) || fullName.length > 200) throw new Error("repositoryFullName must be owner/repository");
  return fullName;
}

function optionalBranch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const branch = value.trim();
  if (!branch || branch.length > 255 || /[\r\n\u0000]/.test(branch)) throw new Error("selectedBranch is invalid");
  return branch;
}

export function registerGitHubProjectRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireControl: ControlPreHandler,
): void {
  const repository = new PostgresProjectSourceRepository(pool);
  let connector: GitHubProjectConnector | null = null;
  const getConnector = () => {
    connector ??= new GitHubProjectConnector();
    return connector;
  };

  app.get<{ Params: { projectId: string } }>(
    "/v0/projects/:projectId/github/repositories",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireProjectId(request.params.projectId);
        await requireActiveProject(pool, projectId);
        return { repositories: await getConnector().listRepositories() };
      } catch (error) {
        const message = error instanceof Error ? error.message : "GitHub repositories could not be listed";
        return reply.code(message.includes("not configured") ? 503 : 400).send({ error: message });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/v0/projects/:projectId/source",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireProjectId(request.params.projectId);
        await requireActiveProject(pool, projectId);
        return { source: await repository.getProjectSource(projectId) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "project source could not be read" });
      }
    },
  );

  app.put<{ Params: { projectId: string }; Body: { repositoryFullName?: string; selectedBranch?: string } }>(
    "/v0/projects/:projectId/source/github",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireProjectId(request.params.projectId);
        await requireActiveProject(pool, projectId);
        const repositoryFullName = requireRepositoryFullName(request.body?.repositoryFullName);
        const selectedBranch = optionalBranch(request.body?.selectedBranch);
        const discovery = await getConnector().inspect(repositoryFullName, selectedBranch);
        const source = await repository.upsertGitHubSource(projectId, discovery);
        return reply.send({ source });
      } catch (error) {
        request.log.error(error, "GitHub project source discovery failed");
        const message = error instanceof Error ? error.message : "GitHub repository discovery failed";
        return reply.code(message.includes("not configured") ? 503 : message.includes("unavailable") ? 404 : 400).send({ error: message });
      }
    },
  );
}
