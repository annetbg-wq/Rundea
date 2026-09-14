import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  confirmDiscoveredServices,
  DiscoveryConfirmationError,
  getConfirmedServiceSource,
  type DiscoverySelection,
} from "./discovery-confirmation";
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

function requireServiceId(value: string): string {
  const serviceId = value.trim().toLowerCase();
  if (!uuidPattern.test(serviceId)) throw new Error("serviceId must be a UUID");
  return serviceId;
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

function sendConfirmationError(reply: FastifyReply, error: unknown) {
  if (error instanceof DiscoveryConfirmationError) return reply.code(error.statusCode).send({ error: error.message });
  return reply.code(400).send({ error: error instanceof Error ? error.message : "discovery confirmation failed" });
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

  app.post<{ Params: { projectId: string }; Body: { services?: DiscoverySelection[] } }>(
    "/v0/projects/:projectId/source/github/confirm",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireProjectId(request.params.projectId);
        await requireActiveProject(pool, projectId);
        const services = await confirmDiscoveredServices(pool, projectId, request.body?.services);
        return reply.code(201).send({ projectId, services });
      } catch (error) {
        request.log.error(error, "GitHub discovery confirmation failed");
        return sendConfirmationError(reply, error);
      }
    },
  );

  app.get<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/source-config",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const serviceId = requireServiceId(request.params.serviceId);
        const source = await getConfirmedServiceSource(pool, serviceId);
        return source ? reply.send({ source }) : reply.code(404).send({ error: "confirmed service source is unavailable" });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "service source config could not be read" });
      }
    },
  );
}
