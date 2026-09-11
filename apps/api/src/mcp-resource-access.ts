import type { Pool } from "pg";
import type { OAuthOperationActor, OperationActor } from "./operation-actor";

export type McpResourceKind = "DEPLOYMENT" | "NODE";
export type McpResourcePermission = "DIAGNOSTICS_READ";

export type McpResourceAccessRequest = Readonly<{
  actor: OperationActor | undefined;
  resourceKind: McpResourceKind;
  resourceId: string;
  permission: McpResourcePermission;
}>;

export type McpResourceAccessResolver = (request: McpResourceAccessRequest) => Promise<boolean>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isOAuthActor(actor: OperationActor | undefined): actor is OAuthOperationActor {
  return actor?.authenticationMethod === "OAUTH";
}

export function createPostgresMcpResourceAccessResolver(pool: Pool): McpResourceAccessResolver {
  return async (request) => {
    if (!isOAuthActor(request.actor)) return true;
    if (!uuidPattern.test(request.resourceId)) return false;

    const result = await pool.query(
      `SELECT 1
         FROM mcp_resource_grants
        WHERE issuer=$1
          AND subject=$2
          AND resource_kind=$3
          AND resource_id=$4
          AND permission=$5
        LIMIT 1`,
      [
        request.actor.issuer,
        request.actor.subject,
        request.resourceKind,
        request.resourceId,
        request.permission,
      ],
    );
    return result.rowCount === 1;
  };
}
