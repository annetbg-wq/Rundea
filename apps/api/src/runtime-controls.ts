import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { AgentEvent } from "@rundea/contracts";
import { registerCanonicalAutodeployRoutes } from "./canonical-autodeploy";
import { registerGitHubAutodeployRoutes } from "./github-autodeploy";
import { registerGitHubProjectRoutes } from "./github-project-routes";
import type { NodeCommandSocket } from "./node-qualification";
import {
  executeRestartOperation,
  executeRollbackOperation,
  RuntimeOperationError,
  validRuntimeResourceId,
} from "./runtime-operations";
import { registerServiceScopedRoutes } from "./service-scoped-routes";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type DispatchQueued = (nodeId: string) => Promise<void>;

function sendOperationError(reply: FastifyReply, error: unknown) {
  if (error instanceof RuntimeOperationError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  throw error;
}

export function registerRuntimeControlRoutes(
  app: FastifyInstance,
  pool: Pool,
  sockets: Map<string, NodeCommandSocket>,
  requireControl: ControlPreHandler,
  dispatchQueued: DispatchQueued,
): void {
  // This function is the existing entrypoint-owned registration seam that has
  // both the authenticated node socket map and deployment dispatcher. Keep the
  // canonical routes here until the Control Plane route registry is split into
  // its own module; do not duplicate registration in index.ts.
  registerServiceScopedRoutes(app, pool, sockets, requireControl, dispatchQueued);
  registerGitHubProjectRoutes(app, pool, requireControl);
  registerCanonicalAutodeployRoutes(app, pool, requireControl);
  registerGitHubAutodeployRoutes(app, pool, requireControl, dispatchQueued, process.env.RUNDEA_GITHUB_WEBHOOK_SECRET);

  app.get("/v0/runtime-actions", { preHandler: requireControl }, async () => {
    const result = await pool.query(
      `SELECT id,deployment_id,node_id,kind,status,error,created_at,completed_at
         FROM runtime_actions ORDER BY created_at DESC LIMIT 100`,
    );
    return { actions: result.rows };
  });

  app.post<{ Params: { id: string } }>(
    "/v0/deployments/:id/restart",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const result = await executeRestartOperation(
          {
            pool,
            sockets,
            dispatchQueued,
            reportError: (error, message) => request.log.error(error, message),
          },
          request.params.id,
        );
        return reply.code(202).send(result);
      } catch (error) {
        return sendOperationError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v0/deployments/:id/rollback",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const result = await executeRollbackOperation(
          {
            pool,
            sockets,
            dispatchQueued,
            reportError: (error, message) => request.log.error(error, message),
          },
          request.params.id,
        );
        return reply.code(202).send(result);
      } catch (error) {
        return sendOperationError(reply, error);
      }
    },
  );
}

export async function recordRuntimeAction(
  pool: Pool,
  nodeId: string,
  event: Extract<AgentEvent, { type: "runtimeAction" }>,
): Promise<void> {
  if (!validRuntimeResourceId(event.actionId) || !validRuntimeResourceId(event.deploymentId) || event.kind !== "RESTART") {
    throw new Error("invalid runtime action event");
  }
  if (event.error && event.error.length > 500) throw new Error("runtime action error is too long");
  const updated = await pool.query(
    `UPDATE runtime_actions
        SET status=$5,error=$6,completed_at=now()
      WHERE id=$1 AND deployment_id=$2 AND node_id=$3 AND kind=$4 AND status='RUNNING'`,
    [event.actionId,event.deploymentId,nodeId,event.kind,event.ok ? "SUCCEEDED" : "FAILED",event.error ?? null],
  );
  if (updated.rowCount !== 1) throw new Error("stale or unauthorized runtime action result");
}

export async function failRunningRuntimeActionsForNode(pool: Pool, nodeId: string): Promise<void> {
  await pool.query(
    `UPDATE runtime_actions
        SET status='FAILED',error='agent disconnected during runtime action',completed_at=now()
      WHERE node_id=$1 AND status='RUNNING'`,
    [nodeId],
  );
}
