import type { OperationName, OperationRiskClass } from "./operation-registry";
import {
  authorizeOperation,
  type ApprovalResolver,
  type OperationAuthorizationRequest,
} from "./operation-authorization";
import type { OperationClient } from "./operation-policy";
import type { OperationAuditRecorder, OperationAuditStart } from "./operation-audit";

export type AuthorizedExecutionContext = Readonly<{
  correlationId: string;
  operationName: OperationName;
  client: OperationClient;
  resourceId: string;
  effectiveRiskClass: OperationRiskClass;
  approvalRef: string | null;
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
    code: "OPERATION_NOT_AUTHORIZED" | "AUDIT_UNAVAILABLE" | "OPERATION_FAILED";
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
    approvalRef,
  };
}

export async function executeAuthorizedOperation<Result>(
  request: OperationAuthorizationRequest,
  resolveApproval: ApprovalResolver,
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

  const context: AuthorizedExecutionContext = {
    correlationId: authorization.correlationId,
    operationName: request.operationName,
    client: request.client,
    resourceId: request.resourceId,
    effectiveRiskClass: authorization.decision.effectiveRiskClass,
    approvalRef: authorization.approvalRef,
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
