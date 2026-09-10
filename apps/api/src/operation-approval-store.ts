import type { Pool } from "pg";
import { createOpaqueToken, hashToken } from "@rundea/crypto";
import type { OperationName } from "./operation-registry";
import type { ApprovalEvidence, ExplicitApproval, SessionPolicyApproval } from "./operation-policy";

const maxScopeItems = 64;
const maxResourceIdLength = 256;

export type IssuedApproval = Readonly<{
  approvalRef: string;
  evidence: ApprovalEvidence;
}>;

export type HumanSessionPolicyInput = Readonly<{
  operationNames: readonly OperationName[];
  resourceIds: readonly string[];
  expiresAt: Date;
  allowSensitive?: boolean;
  maxUses?: number;
}>;

export type HumanExplicitApprovalInput = Readonly<{
  operationName: OperationName;
  resourceId: string;
  expiresAt: Date;
}>;

type ApprovalRow = {
  kind: "SESSION_POLICY" | "EXPLICIT";
  operation_name: OperationName | null;
  resource_id: string | null;
  operation_names: OperationName[] | null;
  resource_ids: string[] | null;
  allow_sensitive: boolean;
  issued_at: Date;
  expires_at: Date;
};

function validateDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${name} is invalid`);
  return value;
}

function validateExpiry(now: Date, expiresAt: Date): void {
  validateDate(now, "approval issue time");
  validateDate(expiresAt, "approval expiry");
  if (expiresAt.getTime() <= now.getTime()) throw new Error("approval expiry must be in the future");
}

function validateResourceId(value: string): string {
  if (!value || value.length > maxResourceIdLength || /[\r\n\u0000]/.test(value)) throw new Error("invalid approval resource scope");
  return value;
}

function uniqueScope<T extends string>(values: readonly T[], name: string, validate?: (value: T) => T): T[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxScopeItems) throw new Error(`${name} must contain 1-${maxScopeItems} items`);
  const normalized = values.map((value) => validate ? validate(value) : value);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} contains duplicate items`);
  return normalized;
}

function validateMaxUses(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error("approval maxUses must be an integer between 1 and 1000");
  return value;
}

function newApprovalRef(): string {
  return `approval:${createOpaqueToken()}`;
}

function rowToEvidence(row: ApprovalRow): ApprovalEvidence | null {
  const issuedAt = new Date(row.issued_at).toISOString();
  const expiresAt = new Date(row.expires_at).toISOString();
  if (row.kind === "EXPLICIT") {
    if (!row.operation_name || !row.resource_id) return null;
    const evidence: ExplicitApproval = {
      kind: "EXPLICIT",
      approvalId: "server-resolved",
      approvedBy: "HUMAN",
      operationName: row.operation_name,
      resourceId: row.resource_id,
      issuedAt,
      expiresAt,
    };
    return evidence;
  }
  if (!row.operation_names?.length || !row.resource_ids?.length) return null;
  const evidence: SessionPolicyApproval = {
    kind: "SESSION_POLICY",
    policyId: "server-resolved",
    approvedBy: "HUMAN",
    expiresAt,
    operationNames: row.operation_names,
    resourceIds: row.resource_ids,
    ...(row.allow_sensitive ? { allowSensitive: true } : {}),
  };
  return evidence;
}

export class PostgresOperationApprovalStore {
  constructor(private readonly pool: Pool) {}

  async issueHumanSessionPolicy(input: HumanSessionPolicyInput, now = new Date()): Promise<IssuedApproval> {
    validateExpiry(now, input.expiresAt);
    const operationNames = uniqueScope(input.operationNames, "operationNames");
    const resourceIds = uniqueScope(input.resourceIds, "resourceIds", validateResourceId);
    const maxUses = validateMaxUses(input.maxUses);
    const approvalRef = newApprovalRef();
    await this.pool.query(
      `INSERT INTO operation_approvals(
         ref_hash,kind,approved_by,operation_names,resource_ids,allow_sensitive,issued_at,expires_at,max_uses
       ) VALUES($1,'SESSION_POLICY','HUMAN',$2,$3,$4,$5,$6,$7)`,
      [hashToken(approvalRef), operationNames, resourceIds, input.allowSensitive === true, now, input.expiresAt, maxUses],
    );
    return {
      approvalRef,
      evidence: {
        kind: "SESSION_POLICY",
        policyId: "server-issued",
        approvedBy: "HUMAN",
        expiresAt: input.expiresAt.toISOString(),
        operationNames,
        resourceIds,
        ...(input.allowSensitive === true ? { allowSensitive: true } : {}),
      },
    };
  }

  async issueHumanExplicitApproval(input: HumanExplicitApprovalInput, now = new Date()): Promise<IssuedApproval> {
    validateExpiry(now, input.expiresAt);
    const resourceId = validateResourceId(input.resourceId);
    const approvalRef = newApprovalRef();
    await this.pool.query(
      `INSERT INTO operation_approvals(
         ref_hash,kind,approved_by,operation_name,resource_id,issued_at,expires_at,max_uses
       ) VALUES($1,'EXPLICIT','HUMAN',$2,$3,$4,$5,1)`,
      [hashToken(approvalRef), input.operationName, resourceId, now, input.expiresAt],
    );
    return {
      approvalRef,
      evidence: {
        kind: "EXPLICIT",
        approvalId: "server-issued",
        approvedBy: "HUMAN",
        operationName: input.operationName,
        resourceId,
        issuedAt: now.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
      },
    };
  }

  async resolve(approvalRef: string, now = new Date()): Promise<ApprovalEvidence | null> {
    validateDate(now, "approval resolve time");
    const result = await this.pool.query<ApprovalRow>(
      `SELECT kind,operation_name,resource_id,operation_names,resource_ids,allow_sensitive,issued_at,expires_at
         FROM operation_approvals
        WHERE ref_hash=$1
          AND approved_by='HUMAN'
          AND revoked_at IS NULL
          AND expires_at>$2
          AND (max_uses IS NULL OR use_count<max_uses)`,
      [hashToken(approvalRef), now],
    );
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row) return null;
    return rowToEvidence(row);
  }

  async consume(approvalRef: string, now = new Date()): Promise<boolean> {
    validateDate(now, "approval consumption time");
    const result = await this.pool.query(
      `UPDATE operation_approvals
          SET use_count=use_count+1,last_used_at=$2
        WHERE ref_hash=$1
          AND approved_by='HUMAN'
          AND revoked_at IS NULL
          AND expires_at>$2
          AND (max_uses IS NULL OR use_count<max_uses)`,
      [hashToken(approvalRef), now],
    );
    return result.rowCount === 1;
  }

  async revoke(approvalRef: string, now = new Date()): Promise<boolean> {
    validateDate(now, "approval revocation time");
    const result = await this.pool.query(
      "UPDATE operation_approvals SET revoked_at=$2 WHERE ref_hash=$1 AND revoked_at IS NULL",
      [hashToken(approvalRef), now],
    );
    return result.rowCount === 1;
  }
}
