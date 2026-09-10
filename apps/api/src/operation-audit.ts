import type { Pool } from "pg";
import type { OperationName, OperationRiskClass } from "./operation-registry";
import type { OperationClient } from "./operation-policy";

export type OperationAuditStart = Readonly<{
  correlationId: string;
  operationName: OperationName;
  client: OperationClient;
  resourceId: string;
  effectiveRiskClass: OperationRiskClass;
  approvalRef: string | null;
}>;

export type OperationAuditOutcome = "SUCCEEDED" | "FAILED";

export interface OperationAuditRecorder {
  recordDenied(entry: OperationAuditStart, errorCode: "OPERATION_NOT_AUTHORIZED"): Promise<void>;
  beginAuthorized(entry: OperationAuditStart): Promise<void>;
  complete(correlationId: string, outcome: OperationAuditOutcome, errorCode?: "OPERATION_FAILED"): Promise<void>;
}

export class PostgresOperationAuditRecorder implements OperationAuditRecorder {
  constructor(private readonly pool: Pool) {}

  async recordDenied(entry: OperationAuditStart, errorCode: "OPERATION_NOT_AUTHORIZED"): Promise<void> {
    await this.pool.query(
      `INSERT INTO operation_audit(
         correlation_id,operation_name,client,resource_id,effective_risk_class,approval_ref,state,error_code,completed_at
       ) VALUES($1,$2,$3,$4,$5,$6,'DENIED',$7,now())`,
      [
        entry.correlationId,
        entry.operationName,
        entry.client,
        entry.resourceId,
        entry.effectiveRiskClass,
        entry.approvalRef,
        errorCode,
      ],
    );
  }

  async beginAuthorized(entry: OperationAuditStart): Promise<void> {
    await this.pool.query(
      `INSERT INTO operation_audit(
         correlation_id,operation_name,client,resource_id,effective_risk_class,approval_ref,state
       ) VALUES($1,$2,$3,$4,$5,$6,'AUTHORIZED')`,
      [
        entry.correlationId,
        entry.operationName,
        entry.client,
        entry.resourceId,
        entry.effectiveRiskClass,
        entry.approvalRef,
      ],
    );
  }

  async complete(correlationId: string, outcome: OperationAuditOutcome, errorCode?: "OPERATION_FAILED"): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operation_audit
          SET state=$2,error_code=$3,completed_at=now()
        WHERE correlation_id=$1 AND state='AUTHORIZED'`,
      [correlationId, outcome, errorCode ?? null],
    );
    if (result.rowCount !== 1) throw new Error("operation audit completion lost authorized record");
  }
}
