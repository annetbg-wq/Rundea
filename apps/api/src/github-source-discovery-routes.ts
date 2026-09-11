import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { createGitHubAppDiscoveryReaderFromEnv, type GitHubAppDiscoveryReader } from "./github-app-discovery-reader";
import {
  executeGitHubSourceDiscoveryOperation,
  GitHubSourceDiscoveryInputError,
} from "./github-source-operation";
import { PostgresOperationAuditRecorder } from "./operation-audit";

type RequireControl = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerGitHubSourceDiscoveryRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireControl: RequireControl,
  reader: GitHubAppDiscoveryReader = createGitHubAppDiscoveryReaderFromEnv(),
): void {
  const audit = new PostgresOperationAuditRecorder(pool);

  app.post<{ Body: { repositoryFullName?: string; ref?: string } }>(
    "/v0/source/github/discover",
    { preHandler: requireControl },
    async (request, reply) => {
      const repositoryFullName = request.body?.repositoryFullName;
      if (typeof repositoryFullName !== "string") {
        return reply.code(400).send({ error: "repositoryFullName is required" });
      }
      try {
        const result = await executeGitHubSourceDiscoveryOperation(
          { reader, audit },
          { repositoryFullName, ref: request.body?.ref },
        );
        if (!result.ok) {
          const statusCode = result.error.code === "OPERATION_NOT_AUTHORIZED" ? 403 : 502;
          return reply.code(statusCode).send({
            error: result.error.code,
            correlationId: result.correlationId,
          });
        }
        return {
          correlationId: result.correlationId,
          profile: result.result,
        };
      } catch (error) {
        if (error instanceof GitHubSourceDiscoveryInputError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
