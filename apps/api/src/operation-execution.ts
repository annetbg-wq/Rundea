import type { OperationName, OperationRiskClass } from "./operation-registry";
import {
  authorizeOperation,
  type ApprovalResolver,
  type OperationAuthorizationRequest,
} from "./operation-authorization";
import type { OperationClient } from "./operation-policy";

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
  result: Result;
}>;

export type OperationExecutionFailure = Readonly<{
  ok: false;
  correlationId: string;
  operationName: OperationName;
  error: Readonly<{
    code: "OPERATION_NOT_AUTHORIZED" | "OPERATION_FAILED";
    message: string;
    requiredApproval?: "NONE" | "SESSION_OR_EXPLICIT" | "EXPLICIT_OR_NARROW_POLICY" | "FRESH_EXPLICIT";
    effectiveRiskClass?: OperationRiskClass;
  }>;
}>;

export type OperationExecutionResult<Result> = OperationExecutionSuccess<Result> | OperationExecutionFailure;

export type OperationExecutor<Result> = (context: AuthorizedExecutionContext) => Promise<Result>;

export async function executeAuthorizedOperation<Result>(
  request: OperationAuthorizationRequest,
  resolveApproval: ApprovalResolver,
  executor: OperationExecutor<Result>,
  now = new Date(),
): Promise<OperationExecutionResult<Result>> {
  const authorization = await authorizeOperation(request, resolveApproval, now);
  if (!authorization.decision.allowed) {
    return {
      ok: false,
      correlationId: authorization.correlationId,
      operationName: request.operationName,
      error: {
        code: "OPERATION_NOT_AUTHORIZED",
        message: authorization.decision.reason,
        requiredApproval: authorization.decision.requiredApproval,
        effectiveRiskClass: authorization.decision.effectiveRiskClass,
      },
    };
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
    return {
      ok: true,
      correlationId: authorization.correlationId,
      operationName: request.operationName,
      result,
    };
  } catch {
    return {
      ok: false,
      correlationId: authorization.correlationId,
      operationName: request.operationName,
      error: {
        code: "OPERATION_FAILED",
        message: "operation execution failed",
        effectiveRiskClass: authorization.decision.effectiveRiskClass,
      },
    };
  }
}
