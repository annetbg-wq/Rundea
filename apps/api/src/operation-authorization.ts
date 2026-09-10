import { randomUUID } from "node:crypto";
import type { OperationActor } from "./operation-actor";
import type { OperationName, OperationRiskClass } from "./operation-registry";
import {
  evaluateOperationPolicy,
  type ApprovalEvidence,
  type OperationClient,
  type OperationPolicyDecision,
} from "./operation-policy";

export type ApprovalReference = string;
export type ApprovalResolver = (approvalRef: ApprovalReference) => Promise<ApprovalEvidence | null>;

export type OperationAuthorizationRequest = Readonly<{
  operationName: OperationName;
  client: OperationClient;
  resourceId: string;
  actor?: OperationActor;
  resourceAccessGranted?: boolean;
  approvalRef?: ApprovalReference;
  contextualRiskClass?: OperationRiskClass;
}>;

export type OperationAuthorization = Readonly<{
  correlationId: string;
  approvalRef: string | null;
  decision: OperationPolicyDecision;
}>;

const approvalRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function deniedWithoutEvidence(
  request: OperationAuthorizationRequest,
  correlationId: string,
  reason: string,
): OperationAuthorization {
  const decision = evaluateOperationPolicy({
    operationName: request.operationName,
    client: request.client,
    resourceId: request.resourceId,
    contextualRiskClass: request.contextualRiskClass,
    approval: { kind: "NONE" },
  });
  return {
    correlationId,
    approvalRef: null,
    decision: decision.allowed ? { ...decision, allowed: false, reason } : { ...decision, reason },
  };
}

export async function authorizeOperation(
  request: OperationAuthorizationRequest,
  resolveApproval: ApprovalResolver,
  now = new Date(),
): Promise<OperationAuthorization> {
  const correlationId = randomUUID();

  if (!request.resourceId || request.resourceId.length > 256 || /[\r\n\u0000]/.test(request.resourceId)) {
    return deniedWithoutEvidence(request, correlationId, "invalid operation resource scope");
  }
  if (request.resourceAccessGranted === false) {
    return deniedWithoutEvidence(request, correlationId, "authenticated actor is not authorized for operation resource");
  }

  const probe = evaluateOperationPolicy({
    operationName: request.operationName,
    client: request.client,
    resourceId: request.resourceId,
    contextualRiskClass: request.contextualRiskClass,
    approval: { kind: "NONE" },
    now,
  });
  if (probe.allowed) {
    return { correlationId, approvalRef: null, decision: probe };
  }

  if (!request.approvalRef || !approvalRefPattern.test(request.approvalRef)) {
    return { correlationId, approvalRef: null, decision: probe };
  }

  let evidence: ApprovalEvidence | null;
  try {
    evidence = await resolveApproval(request.approvalRef);
  } catch {
    return {
      correlationId,
      approvalRef: request.approvalRef,
      decision: { ...probe, reason: "approval service is unavailable" },
    };
  }
  if (!evidence) {
    return {
      correlationId,
      approvalRef: request.approvalRef,
      decision: { ...probe, reason: "approval reference is unknown or unavailable" },
    };
  }

  const decision = evaluateOperationPolicy({
    operationName: request.operationName,
    client: request.client,
    resourceId: request.resourceId,
    contextualRiskClass: request.contextualRiskClass,
    approval: evidence,
    now,
  });
  return { correlationId, approvalRef: request.approvalRef, decision };
}
