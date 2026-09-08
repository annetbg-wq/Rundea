import type { Pool } from "pg";
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

const variableKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
const maxVariables = 256;
const maxValueBytes = 64 * 1024;

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

export async function upsertServiceVariables(pool: Pool, masterKey: Buffer, serviceName: string, inputs: ServiceVariableInput[]): Promise<void> {
  validateVariables(inputs);
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

export async function listServiceVariables(pool: Pool, masterKey: Buffer, serviceName: string): Promise<ServiceVariableView[]> {
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

export async function loadServiceEnvironment(pool: Pool, masterKey: Buffer, serviceName: string): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT key,encrypted_version,iv,ciphertext,auth_tag FROM service_variables WHERE service_name=$1 ORDER BY key ASC`,
    [serviceName],
  );
  return Object.fromEntries(result.rows.map((row) => [row.key, decryptValue(encryptedFromRow(row), masterKey)]));
}

export async function deleteServiceVariable(pool: Pool, serviceName: string, key: string): Promise<boolean> {
  if (!variableKey.test(key)) throw new Error("invalid environment variable name");
  const result = await pool.query("DELETE FROM service_variables WHERE service_name=$1 AND key=$2", [serviceName, key]);
  return (result.rowCount ?? 0) > 0;
}
