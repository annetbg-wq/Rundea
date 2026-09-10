import type { Pool } from "pg";
import type { OperationActor } from "./operation-actor";
import type { OperationName, OperationRiskClass } from "./operation-registry";
import type { OperationClient } from "./operation-policy";

export type OperationAuditErrorCode = "OPERATION_NOT_AUTHORIZED" | "APPROVAL_UNAVAILABLE" | "OPERATION_FAILED";

export type OperationAuditStart = Readonly<{
  correlationId: string;
  operationName: OperationName;
  client: OperationClient;
  resourceId: string;
  effectiveRiskClass: OperationRiskClass;
  approvalRefHash: string | null;
  actor: OperationActor | null;
}>;

export type OperationAuditOutcome = "SUCCEEDED" | "FAILED";

export interface OperationAuditRecorder {
  recordDenied(entry: OperationAuditStart, errorCode: "OPERATION_NOT_AUTHORIZED"): Promise<void>;
  beginAuthorized(entry: OperationAuditStart): Promise<void>;
  complete(correlationId: string, outcome: OperationAuditOutcome, errorCode?: Exclude<OperationAuditErrorCode, "OPERATION_NOT_AUTHORIZED">): Promise<void>;
}

function actorParams(actor: OperationActor | null): [string | null, string | null, string | null, string[] | null] {
  if (!actor) return [null, null, null, null];
  return [
    actor.authenticationMethod,
    actor.issuer,
    actor.subject,
    [...actor.scopes],
  ];
}

export class PostgresOperationAuditRecorder implements OperationAuditRecorder {
  constructor(private readonly pool: Pool) {}

  async recordDenied(entry: OperationAuditStart, errorCode: "OPERATION_NOT_AUTHORIZED"): Promise<void> {
    const [authnMethod, actorIssuer, actorSubject, actorScopes] = actorParams(entry.actor);
    await this.pool.query(
      `INSERT INTO operation_audit(
         correlation_id,operation_name,client,resource_id,effective_risk_class,approval_ref_hash,
         authn_method,actor_issuer,actor_subject,actor_scopes,state,error_code,completed_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DENIED',$11,now())`,
      [
        entry.correlationId,
        entry.operationName,
        entry.client,
        entry.resourceId,
        entry.effectiveRiskClass,
        entry.approvalRefHash,
        authnMethod,
        actorIssuer,
        actorSubject,
        actorScopes,
        errorCode,
      ],
    );
  }

  async beginAuthorized(entry: OperationAuditStart): Promise<void> {
    const [authnMethod, actorIssuer, actorSubject, actorScopes] = actorParams(entry.actor);
    await this.pool.query(
      `INSERT INTO operation_audit(
         correlation_id,operation_name,client,resource_id,effective_risk_class,approval_ref_hash,
         authn_method,actor_issuer,actor_subject,actor_scopes,state
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AUTHORIZED')`,
      [
        entry.correlationId,
        entry.operationName,
        entry.client,
        entry.resourceId,
        entry.effectiveRiskClass,
        entry.approvalRefHash,
        authnMethod,
        actorIssuer,
        actorSubject,
        actorScopes,
      ],
    );
  }

  async complete(
    correlationId: string,
    outcome: OperationAuditOutcome,
    errorCode?: Exclude<OperationAuditErrorCode, "OPERATION_NOT_AUTHORIZED">,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE operation_audit
          SET state=$2,error_code=$3,completed_at=now()
        WHERE correlation_id=$1 AND state='AUTHORIZED'`,
      [correlationId, outcome, errorCode ?? null],
    );
    if (result.rowCount !== 1) throw new Error("operation audit completion lost authorized record");
  }
}
