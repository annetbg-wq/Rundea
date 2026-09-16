import type { Pool, PoolClient } from "pg";
import { decryptValue, encryptValue, type EncryptedValue } from "@rundea/crypto";

export type ServiceVariableInput = {
  key: string;
  value: string;
  secret?: boolean;
};

export type ServiceVariableView = {
  key: string;
  secret: boolean;
  value?: string;
};

export type ServiceVariableMutationView = {
  key: string;
  secret: boolean;
};

const serviceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const variableKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxVariables = 256;
const maxValueBytes = 64 * 1024;
export const internalVolumeMetadataKey = "RUNDEA_INTERNAL_VOLUME_MOUNTS";

function requireServiceName(value: string): string {
  if (!serviceNamePattern.test(value)) throw new Error("invalid service name");
  return value;
}

function requireVariableKey(value: string): string {
  if (!variableKey.test(value)) throw new Error("invalid environment variable name");
  return value;
}

export function validateVariables(inputs: ServiceVariableInput[]): void {
  if (inputs.length > maxVariables) throw new Error(`at most ${maxVariables} variables are allowed per write`);
  const seen = new Set<string>();
  for (const item of inputs) {
    if (!variableKey.test(item.key)) throw new Error(`invalid environment variable name: ${item.key}`);
    if (item.key === "HOST" || item.key === "PORT" || item.key.startsWith("RUNDEA_")) {
      throw new Error(`${item.key} is reserved by Rundea`);
    }
    if (seen.has(item.key)) throw new Error(`duplicate environment variable: ${item.key}`);
    seen.add(item.key);
    if (Buffer.byteLength(item.value, "utf8") > maxValueBytes) throw new Error(`${item.key} exceeds ${maxValueBytes} bytes`);
    if (item.value.includes("\u0000")) throw new Error(`${item.key} contains a NUL byte`);
    if (item.value.includes("\n") || item.value.includes("\r")) throw new Error(`${item.key} cannot contain newlines in v0`);
  }
}

async function persistServiceVariables(pool: Pool, masterKey: Buffer, serviceName: string, inputs: ServiceVariableInput[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of inputs) {
      const encrypted = encryptValue(item.value, masterKey);
      await client.query(
        `INSERT INTO service_variables(service_name,key,encrypted_version,iv,ciphertext,auth_tag,is_secret,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT(service_name,key) DO UPDATE SET
           encrypted_version=EXCLUDED.encrypted_version,
           iv=EXCLUDED.iv,
           ciphertext=EXCLUDED.ciphertext,
           auth_tag=EXCLUDED.auth_tag,
           is_secret=EXCLUDED.is_secret,
           updated_at=now()`,
        [serviceName, item.key, encrypted.version, encrypted.iv, encrypted.ciphertext, encrypted.tag, item.secret ?? true],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function encryptedFromRow(row: Record<string, unknown>): EncryptedValue {
  return {
    version: Number(row.encrypted_version) as 1,
    iv: String(row.iv),
    ciphertext: String(row.ciphertext),
    tag: String(row.auth_tag),
  };
}

async function readServiceVariableViews(pool: Pool, masterKey: Buffer, serviceName: string): Promise<ServiceVariableView[]> {
  const result = await pool.query(
    `SELECT key,encrypted_version,iv,ciphertext,auth_tag,is_secret
       FROM service_variables WHERE service_name=$1 ORDER BY key ASC`,
    [serviceName],
  );
  return result.rows.map((row) => ({
    key: row.key,
    secret: row.is_secret,
    ...(row.is_secret ? {} : { value: decryptValue(encryptedFromRow(row), masterKey) }),
  }));
}

export async function executeServiceVariablesReadOperation(
  pool: Pool,
  masterKey: Buffer,
  serviceName: string,
): Promise<{ variables: ServiceVariableView[] }> {
  const normalizedServiceName = requireServiceName(serviceName);
  return { variables: await readServiceVariableViews(pool, masterKey, normalizedServiceName) };
}

export async function executeServiceVariablesUpsertOperation(
  pool: Pool,
  masterKey: Buffer,
  serviceName: string,
  inputs: ServiceVariableInput[],
): Promise<{ updated: ServiceVariableMutationView[] }> {
  const normalizedServiceName = requireServiceName(serviceName);
  validateVariables(inputs);
  await persistServiceVariables(pool, masterKey, normalizedServiceName, inputs);
  return {
    updated: inputs.map((item) => ({ key: item.key, secret: item.secret ?? true })),
  };
}

export async function executeServiceVariableDeleteOperation(
  pool: Pool,
  serviceName: string,
  key: string,
): Promise<{ deleted: boolean; key: string }> {
  const normalizedServiceName = requireServiceName(serviceName);
  const normalizedKey = requireVariableKey(key);
  const result = await pool.query("DELETE FROM service_variables WHERE service_name=$1 AND key=$2", [normalizedServiceName, normalizedKey]);
  return { deleted: (result.rowCount ?? 0) > 0, key: normalizedKey };
}

export async function upsertServiceVariables(pool: Pool, masterKey: Buffer, serviceName: string, inputs: ServiceVariableInput[]): Promise<void> {
  await executeServiceVariablesUpsertOperation(pool, masterKey, serviceName, inputs);
}

export async function listServiceVariables(pool: Pool, masterKey: Buffer, serviceName: string): Promise<ServiceVariableView[]> {
  return (await executeServiceVariablesReadOperation(pool, masterKey, serviceName)).variables;
}

export async function loadServiceEnvironment(pool: Pool, masterKey: Buffer, serviceName: string): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT key,encrypted_version,iv,ciphertext,auth_tag FROM service_variables WHERE service_name=$1 ORDER BY key ASC`,
    [serviceName],
  );
  return Object.fromEntries(result.rows.map((row) => [row.key, decryptValue(encryptedFromRow(row), masterKey)]));
}

export async function captureDeploymentEnvironment(client: PoolClient, deploymentId: string, serviceName: string): Promise<void> {
  await client.query(
    `INSERT INTO deployment_variables(deployment_id,key,encrypted_version,iv,ciphertext,auth_tag,is_secret)
     SELECT $1,key,encrypted_version,iv,ciphertext,auth_tag,is_secret
       FROM service_variables
      WHERE service_name=$2
     ON CONFLICT(deployment_id,key) DO NOTHING`,
    [deploymentId, serviceName],
  );
  await client.query("UPDATE deployments SET environment_snapshot_at=now() WHERE id=$1", [deploymentId]);
}

export async function copyDeploymentEnvironment(client: PoolClient, sourceDeploymentId: string, destinationDeploymentId: string): Promise<void> {
  const source = await client.query("SELECT environment_snapshot_at FROM deployments WHERE id=$1 FOR SHARE", [sourceDeploymentId]);
  if (source.rowCount !== 1 || !source.rows[0].environment_snapshot_at) throw new Error("rollback target has no immutable environment snapshot");
  await client.query(
    `INSERT INTO deployment_variables(deployment_id,key,encrypted_version,iv,ciphertext,auth_tag,is_secret)
     SELECT $2,key,encrypted_version,iv,ciphertext,auth_tag,is_secret
       FROM deployment_variables
      WHERE deployment_id=$1`,
    [sourceDeploymentId, destinationDeploymentId],
  );
  await client.query("UPDATE deployments SET environment_snapshot_at=now() WHERE id=$1", [destinationDeploymentId]);
}

async function attachDeploymentVolumeMetadata(
  pool: Pool,
  deploymentId: string,
  environment: Record<string, string>,
): Promise<Record<string, string>> {
  const mounts = await pool.query(
    `SELECT m.volume_id,v.name,m.docker_volume_name,m.mount_path
       FROM deployment_volume_mounts m
       JOIN service_volumes v ON v.id=m.volume_id
      WHERE m.deployment_id=$1
      ORDER BY m.mount_path,m.volume_id`,
    [deploymentId],
  );
  if (!mounts.rowCount) return environment;
  return {
    ...environment,
    [internalVolumeMetadataKey]: JSON.stringify(
      mounts.rows.map((row) => ({
        volumeId: String(row.volume_id),
        name: String(row.name),
        dockerVolumeName: String(row.docker_volume_name),
        mountPath: String(row.mount_path),
      })),
    ),
  };
}

export async function loadDeploymentEnvironment(
  pool: Pool,
  masterKey: Buffer,
  deploymentId: string,
  serviceName: string,
): Promise<Record<string, string>> {
  const snapshot = await pool.query("SELECT environment_snapshot_at FROM deployments WHERE id=$1", [deploymentId]);
  let environment: Record<string, string>;
  if (snapshot.rowCount === 1 && snapshot.rows[0].environment_snapshot_at) {
    const result = await pool.query(
      `SELECT key,encrypted_version,iv,ciphertext,auth_tag
         FROM deployment_variables WHERE deployment_id=$1 ORDER BY key ASC`,
      [deploymentId],
    );
    environment = Object.fromEntries(result.rows.map((row) => [row.key, decryptValue(encryptedFromRow(row), masterKey)]));
  } else {
    environment = await loadServiceEnvironment(pool, masterKey, serviceName);
  }
  return attachDeploymentVolumeMetadata(pool, deploymentId, environment);
}

export async function deleteServiceVariable(pool: Pool, serviceName: string, key: string): Promise<boolean> {
  return (await executeServiceVariableDeleteOperation(pool, serviceName, key)).deleted;
}