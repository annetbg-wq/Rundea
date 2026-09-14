import type { Pool, PoolClient } from "pg";

export const runtimeArtifactRetentionLimit = 4;

type Queryable = Pool | PoolClient;

export async function retainedRollbackTargetIds(
  db: Queryable,
  serviceName: string,
  nodeId: string,
): Promise<string[]> {
  const result = await db.query(
    `SELECT id
       FROM deployments
      WHERE service_name=$1
        AND node_id=$2
        AND status IN ('READY','ROLLED_BACK')
      ORDER BY created_at DESC,id DESC
      LIMIT $3`,
    [serviceName, nodeId, runtimeArtifactRetentionLimit],
  );
  return result.rows.map((row) => String(row.id));
}

export async function rollbackTargetIsRetained(
  db: Queryable,
  serviceName: string,
  nodeId: string,
  targetDeploymentId: string,
): Promise<boolean> {
  const ids = await retainedRollbackTargetIds(db, serviceName, nodeId);
  return ids.includes(targetDeploymentId);
}
