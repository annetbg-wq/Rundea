import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgentCommand } from "@rundea/contracts";
import type { NodeCommandSocket } from "./node-qualification";
import { rollbackTargetIsRetained } from "./runtime-retention";
import { copyDeploymentEnvironment } from "./service-variables";

export class RuntimeOperationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeOperationError";
  }
}

type Queryable = Pool | PoolClient;
type DispatchQueued = (nodeId: string) => Promise<void>;
type ReportError = (error: unknown, message: string) => void;

export type RuntimeOperationDependencies = {
  pool: Pool;
  sockets: Map<string, NodeCommandSocket>;
  dispatchQueued: DispatchQueued;
  reportError?: ReportError;
};

export type RestartOperationResult = {
  id: string;
  deploymentId: string;
  kind: "RESTART";
  status: "RUNNING";
};

export type RollbackOperationResult = {
  id: string;
  status: "QUEUED";
  operation: "ROLLBACK";
  rollbackTargetId: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rollbackTargetStatuses = new Set(["READY", "ROLLED_BACK"]);

export function validRuntimeResourceId(value: string): boolean {
  return uuidPattern.test(value);
}

function safeServiceName(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "service";
}

async function latestReadyForService(db: Queryable, serviceName: string, serviceId?: string | null) {
  const result = serviceId
    ? await db.query(
        `SELECT id,service_id,service_name,node_id,host_port,container_port,healthcheck_path,environment_snapshot_at,image_id,
                source_commit_sha,artifact_image_ref,artifact_source_commit_sha
           FROM deployments
          WHERE service_id=$1 AND status='READY'
          ORDER BY created_at DESC,id DESC LIMIT 1`,
        [serviceId],
      )
    : await db.query(
        `SELECT id,service_id,service_name,node_id,host_port,container_port,healthcheck_path,environment_snapshot_at,image_id,
                source_commit_sha,artifact_image_ref,artifact_source_commit_sha
           FROM deployments
          WHERE service_id IS NULL AND service_name=$1 AND status='READY'
          ORDER BY created_at DESC,id DESC LIMIT 1`,
        [serviceName],
      );
  return result.rows[0] as Record<string, any> | undefined;
}

async function nodeHasRuntimeAction(db: Queryable, nodeId: string): Promise<boolean> {
  const result = await db.query("SELECT id FROM runtime_actions WHERE node_id=$1 AND status='RUNNING' LIMIT 1", [nodeId]);
  return (result.rowCount ?? 0) > 0;
}

async function nodeHasActiveDeployment(db: Queryable, nodeId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM deployments
      WHERE node_id=$1 AND status IN ('QUEUED','BUILDING','DEPLOYING','HEALTHCHECK') LIMIT 1`,
    [nodeId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function rollbackAndThrow(client: PoolClient, statusCode: number, message: string): Promise<never> {
  await client.query("ROLLBACK");
  throw new RuntimeOperationError(statusCode, message);
}

export async function executeRestartOperation(
  dependencies: RuntimeOperationDependencies,
  deploymentId: string,
): Promise<RestartOperationResult> {
  const { pool, sockets, reportError } = dependencies;
  if (!validRuntimeResourceId(deploymentId)) throw new RuntimeOperationError(400, "invalid deployment id");

  const initial = await pool.query("SELECT node_id FROM deployments WHERE id=$1", [deploymentId]);
  if (initial.rowCount !== 1) throw new RuntimeOperationError(404, "deployment not found");
  const nodeId = initial.rows[0].node_id as string;
  const socket = sockets.get(nodeId);
  if (!socket) throw new RuntimeOperationError(409, "node is not connected");

  const actionId = randomUUID();
  let row: Record<string, any>;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM nodes WHERE id=$1 FOR UPDATE", [nodeId]);
    const target = await client.query(
      `SELECT id,service_id,service_name,node_id,host_port,healthcheck_path,status
         FROM deployments WHERE id=$1 FOR UPDATE`,
      [deploymentId],
    );
    if (target.rowCount !== 1) return rollbackAndThrow(client, 404, "deployment not found");
    row = target.rows[0];
    if (row.status !== "READY") return rollbackAndThrow(client, 409, "only a READY deployment can be restarted");

    const current = await latestReadyForService(client, row.service_name, row.service_id ?? null);
    if (!current || current.id !== row.id) {
      return rollbackAndThrow(client, 409, "only the current READY revision can be restarted");
    }
    if (await nodeHasActiveDeployment(client, nodeId)) {
      return rollbackAndThrow(client, 409, "node has an active deployment operation");
    }
    if (await nodeHasRuntimeAction(client, nodeId)) {
      return rollbackAndThrow(client, 409, "node already has a running runtime action");
    }

    await client.query(
      "INSERT INTO runtime_actions(id,deployment_id,node_id,kind,status) VALUES($1,$2,$3,'RESTART','RUNNING')",
      [actionId, row.id, nodeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    if (error instanceof RuntimeOperationError) throw error;
    await client.query("ROLLBACK").catch(() => undefined);
    reportError?.(error, "restart action could not be created");
    throw new RuntimeOperationError(409, "restart action could not be created");
  } finally {
    client.release();
  }

  const command: AgentCommand = {
    type: "restart",
    actionId,
    deploymentId: row!.id,
    serviceName: row!.service_name,
    runtime: {
      containerName: `rundea-${safeServiceName(row!.service_name)}`,
      hostPort: row!.host_port,
      healthcheck: { path: row!.healthcheck_path || "/health", timeoutSeconds: 60 },
    },
  };
  try {
    socket.send(JSON.stringify(command));
  } catch (error) {
    await pool.query(
      "UPDATE runtime_actions SET status='FAILED',error='restart command could not be sent',completed_at=now() WHERE id=$1 AND status='RUNNING'",
      [actionId],
    );
    reportError?.(error, "restart command could not be sent");
    throw new RuntimeOperationError(502, "restart command could not be sent");
  }

  return { id: actionId, deploymentId: row!.id, kind: "RESTART", status: "RUNNING" };
}

export async function executeRollbackOperation(
  dependencies: RuntimeOperationDependencies,
  targetDeploymentId: string,
): Promise<RollbackOperationResult> {
  const { pool, dispatchQueued, reportError } = dependencies;
  if (!validRuntimeResourceId(targetDeploymentId)) throw new RuntimeOperationError(400, "invalid deployment id");

  const id = randomUUID();
  let target: Record<string, any>;
  let destinationNodeId = "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targetResult = await client.query(
      `SELECT id,service_id,service_name,node_id,source_repository,source_ref,source_delivery,dockerfile,build_args,
              container_port,host_port,healthcheck_path,status,environment_snapshot_at,source_commit_sha,image_id,
              artifact_image_ref,artifact_source_commit_sha
         FROM deployments WHERE id=$1 FOR UPDATE`,
      [targetDeploymentId],
    );
    if (targetResult.rowCount !== 1) return rollbackAndThrow(client, 404, "rollback target not found");
    target = targetResult.rows[0];
    if (!rollbackTargetStatuses.has(target.status)) {
      return rollbackAndThrow(client, 409, "rollback target must be a revision that previously reached READY");
    }
    if (!target.environment_snapshot_at || !target.image_id || !target.source_commit_sha) {
      return rollbackAndThrow(client, 409, "deployment predates immutable rollback snapshots or has no artifact identity");
    }

    const current = await latestReadyForService(client, target.service_name, target.service_id ?? null);
    if (!current) return rollbackAndThrow(client, 409, "service has no current READY deployment");
    if (current.id === target.id) return rollbackAndThrow(client, 409, "target deployment is already the current revision");

    destinationNodeId = String(current.node_id);
    const node = await client.query(
      "SELECT id,status,lifecycle_status FROM nodes WHERE id=$1 FOR UPDATE",
      [destinationNodeId],
    );
    if (node.rowCount !== 1 || node.rows[0].lifecycle_status !== "ACTIVE" || node.rows[0].status !== "ONLINE") {
      return rollbackAndThrow(client, 409, "current service node is not ONLINE and ACTIVE");
    }

    const sameNode = String(target.node_id) === destinationNodeId;
    const registryBacked = Boolean(target.artifact_image_ref && target.artifact_source_commit_sha);
    if (!sameNode && !registryBacked) {
      return rollbackAndThrow(client, 409, "cross-node rollback requires an immutable registry artifact");
    }
    if (sameNode && !registryBacked) {
      if (!(await rollbackTargetIsRetained(client, target.service_name, destinationNodeId, target.id))) {
        return rollbackAndThrow(client, 409, "rollback target is outside the retained artifact window and has no registry artifact");
      }
    }
    if (registryBacked && String(target.artifact_source_commit_sha).toLowerCase() !== String(target.source_commit_sha).toLowerCase()) {
      return rollbackAndThrow(client, 409, "rollback registry artifact provenance does not match the target source commit");
    }
    if (await nodeHasActiveDeployment(client, destinationNodeId)) {
      return rollbackAndThrow(client, 409, "destination node already has an active deployment operation");
    }
    if (await nodeHasRuntimeAction(client, destinationNodeId)) {
      return rollbackAndThrow(client, 409, "destination node already has a running runtime action");
    }

    await client.query(
      `INSERT INTO deployments(
         id,service_id,service_name,node_id,source_repository,source_ref,source_delivery,dockerfile,build_args,
         container_port,host_port,healthcheck_path,status,operation,rollback_target_id,source_commit_sha,image_id,
         artifact_image_ref,artifact_source_commit_sha
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'QUEUED','ROLLBACK',$13,$14,$15,$16,$17
       )`,
      [
        id,
        target.service_id,
        target.service_name,
        destinationNodeId,
        target.source_repository,
        target.source_ref,
        target.source_delivery ?? "DIRECT",
        target.dockerfile,
        target.build_args ?? {},
        target.container_port,
        current.host_port,
        target.healthcheck_path,
        target.id,
        target.source_commit_sha,
        target.image_id,
        target.artifact_image_ref ?? null,
        target.artifact_source_commit_sha ?? null,
      ],
    );
    await copyDeploymentEnvironment(client, target.id, id);
    await client.query("COMMIT");
  } catch (error) {
    if (error instanceof RuntimeOperationError) throw error;
    await client.query("ROLLBACK").catch(() => undefined);
    reportError?.(error, "rollback deployment could not be created");
    throw new RuntimeOperationError(
      409,
      error instanceof Error ? error.message : "rollback deployment could not be created",
    );
  } finally {
    client.release();
  }

  await dispatchQueued(destinationNodeId);
  return { id, status: "QUEUED", operation: "ROLLBACK", rollbackTargetId: target!.id };
}

