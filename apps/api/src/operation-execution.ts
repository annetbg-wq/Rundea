import { hashToken } from "@rundea/crypto";
import type { OperationActor } from "./operation-actor";
import type { OperationName, OperationRiskClass } from "./operation-registry";
import {
  authorizeOperation,
  type ApprovalResolver,
  type OperationAuthorizationRequest,
} from "./operation-authorization";
import type { OperationClient } from "./operation-policy";
import type { OperationAuditRecorder, OperationAuditStart } from "./operation-audit";

export type ApprovalConsumer = (approvalRef: string, now?: Date) => Promise<boolean>;

export type AuthorizedExecutionContext = Readonly<{
  correlationId: string;
  operationName: OperationName;
  client: OperationClient;
  resourceId: string;
  effectiveRiskClass: OperationRiskClass;
  actor: OperationActor | null;
}>;

export type OperationExecutionSuccess<Result> = Readonly<{
  ok: true;
  correlationId: string;
  operationName: OperationName;
  auditFinalized: boolean;
  result: Result;
}>;

export type OperationExecutionFailure = Readonly<{
  ok: false;
  correlationId: string;
  operationName: OperationName;
  auditFinalized: boolean;
  error: Readonly<{
    code: "OPERATION_NOT_AUTHORIZED" | "AUDIT_UNAVAILABLE" | "APPROVAL_UNAVAILABLE" | "OPERATION_FAILED";
    message: string;
    requiredApproval?: "NONE" | "SESSION_OR_EXPLICIT" | "EXPLICIT_OR_NARROW_POLICY" | "FRESH_EXPLICIT";
    effectiveRiskClass?: OperationRiskClass;
  }>;
}>;

export type OperationExecutionResult<Result> = OperationExecutionSuccess<Result> | OperationExecutionFailure;

export type OperationExecutor<Result> = (context: AuthorizedExecutionContext) => Promise<Result>;

function auditStart(
  request: OperationAuthorizationRequest,
  correlationId: string,
  effectiveRiskClass: OperationRiskClass,
  approvalRef: string | null,
): OperationAuditStart {
  return {
    correlationId,
    operationName: request.operationName,
    client: request.client,
    resourceId: request.resourceId,
    effectiveRiskClass,
    approvalRefHash: approvalRef ? hashToken(approvalRef) : null,
    actor: request.actor ?? null,
  };
}

async function finalizeApprovalFailure(
  audit: OperationAuditRecorder,
  correlationId: string,
  auditStarted: boolean,
): Promise<boolean> {
  if (!auditStarted) return false;
  try {
    await audit.complete(correlationId, "FAILED", "APPROVAL_UNAVAILABLE");
    return true;
  } catch {
    return false;
  }
}

export async function executeAuthorizedOperation<Result>(
  request: OperationAuthorizationRequest,
  resolveApproval: ApprovalResolver,
  consumeApproval: ApprovalConsumer,
  audit: OperationAuditRecorder,
  executor: OperationExecutor<Result>,
  now = new Date(),
): Promise<OperationExecutionResult<Result>> {
  const authorization = await authorizeOperation(request, resolveApproval, now);
  const entry = auditStart(
    request,
    authorization.correlationId,
    authorization.decision.effectiveRiskClass,
    authorization.approvalRef,
  );

  if (!authorization.decision.allowed) {
    let auditFinalized = true;
    try {
      await audit.recordDenied(entry, "OPERATION_NOT_AUTHORIZED");
    } catch {
      auditFinalized = false;
    }
    return {
      ok: false,
      correlationId: authorization.correlationId,
      operationName: request.operationName,
      auditFinalized,
      error: {
        code: "OPERATION_NOT_AUTHORIZED",
        message: authorization.decision.reason,
        requiredApproval: authorization.decision.requiredApproval,
        effectiveRiskClass: authorization.decision.effectiveRiskClass,
      },
    };
  }

  let auditStarted = false;
  try {
    await audit.beginAuthorized(entry);
    auditStarted = true;
  } catch {
    if (authorization.decision.effectiveRiskClass !== "READ_ONLY") {
      return {
        ok: false,
        correlationId: authorization.correlationId,
        operationName: request.operationName,
        auditFinalized: false,
        error: {
          code: "AUDIT_UNAVAILABLE",
          message: "operation audit is unavailable",
          effectiveRiskClass: authorization.decision.effectiveRiskClass,
        },
      };
    }
  }

  if (authorization.decision.effectiveRiskClass !== "READ_ONLY") {
    const approvalRef = authorization.approvalRef;
    let consumed = false;
    if (approvalRef) {
      try {
        consumed = await consumeApproval(approvalRef, now);
      } catch {
        consumed = false;
      }
    }
    if (!consumed) {
      const auditFinalized = await finalizeApprovalFailure(audit, authorization.correlationId, auditStarted);
      return {
        ok: false,
        correlationId: authorization.correlationId,
        operationName: request.operationName,
        auditFinalized,
        error: {
          code: "APPROVAL_UNAVAILABLE",
          message: "operation approval is unavailable",
          requiredApproval: authorization.decision.requiredApproval,
          effectiveRiskClass: authorization.decision.effectiveRiskClass,
        },
      };
    }
  }

  const context: AuthorizedExecutionContext = {
    correlationId: authorization.correlationId,
    operationName: request.operationName,
    client: request.client,
    resourceId: request.resourceId,
    effectiveRiskClass: authorization.decision.effectiveRiskClass,
    actor: request.actor ?? null,
  };

  try {
    const result = await executor(context);
    let auditFinalized = auditStarted;
    if (auditStarted) {
      try {
        await audit.complete(authorization.correlationId, "SUCCEEDED");
      } catch {
        auditFinalized = false;
      }
    }
    return {
      ok: true,
      correlationId: authorization.correlationId,
      operationName: request.operationName,
      auditFinalized,
      result,
    };
  } catch {
    let auditFinalized = auditStarted;
    if (auditStarted) {
      try {
        await audit.complete(authorization.correlationId, "FAILED", "OPERATION_FAILED");
      } catch {
        auditFinalized = false;
      }
    }
    return {
      ok: false,
      correlationId: authorization.correlationId,
      operationName: request.operationName,
      auditFinalized,
      error: {
        code: "OPERATION_FAILED",
        message: "operation execution failed",
        effectiveRiskClass: authorization.decision.effectiveRiskClass,
      },
    };
  }
}
