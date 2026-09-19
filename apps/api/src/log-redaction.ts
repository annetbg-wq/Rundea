import type { Pool } from "pg";
import { decryptManagedRedisCredential, decryptValue, type EncryptedValue } from "@rundea/crypto";

function encryptedFromRow(row: Record<string, unknown>): EncryptedValue {
  return {
    version: Number(row.encrypted_version) as 1,
    iv: String(row.iv),
    ciphertext: String(row.ciphertext),
    tag: String(row.auth_tag),
  };
}

export function redactLogMessage(message: string, secrets: string[]): string {
  let redacted = message;
  const uniqueSecrets = [...new Set(secrets.filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  for (const secret of uniqueSecrets) redacted = redacted.split(secret).join("[REDACTED]");

  redacted = redacted
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/([?&](?:access_token|api[_-]?key|apikey|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, "$1[REDACTED]$2");

  return redacted;
}

export async function loadDeploymentLogSecrets(pool: Pool, masterKey: Buffer, deploymentId: string): Promise<string[]> {
  const variables = await pool.query(
    `SELECT encrypted_version,iv,ciphertext,auth_tag
       FROM deployment_variables
      WHERE deployment_id=$1 AND is_secret=true`,
    [deploymentId],
  );
  const secrets = variables.rows.map((row) => decryptValue(encryptedFromRow(row), masterKey));

  const redis = await pool.query(
    `SELECT a.encrypted_version,a.iv,a.ciphertext,a.auth_tag
       FROM deployments d
       JOIN services s ON s.id=d.service_id
       JOIN project_redis_addons a ON a.project_id=s.project_id
      WHERE d.id=$1`,
    [deploymentId],
  );
  if (redis.rowCount === 1) {
    secrets.push(decryptManagedRedisCredential(encryptedFromRow(redis.rows[0]), masterKey));
  }

  return secrets;
}
