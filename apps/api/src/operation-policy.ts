import { getOperationDefinition, type OperationName, type OperationRiskClass } from "./operation-registry";

export type OperationClient = "WEB" | "API" | "MCP" | "RUNDEA_AI" | "CLI";
export type ApprovalActor = "HUMAN" | "MODEL" | "AUTOMATION";

export type SessionPolicyApproval = Readonly<{
  kind: "SESSION_POLICY";
  policyId: string;
  approvedBy: ApprovalActor;
  expiresAt: string;
  operationNames: readonly OperationName[];
  resourceIds: readonly string[];
  allowSensitive?: boolean;
}>;

export type ExplicitApproval = Readonly<{
  kind: "EXPLICIT";
  approvalId: string;
  approvedBy: ApprovalActor;
  operationName: OperationName;
  resourceId: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type ApprovalEvidence = Readonly<{ kind: "NONE" }> | SessionPolicyApproval | ExplicitApproval;

export type OperationPolicyInput = Readonly<{
  operationName: OperationName;
  client: OperationClient;
  resourceId: string;
  approval?: ApprovalEvidence;
  contextualRiskClass?: OperationRiskClass;
  now?: Date;
}>;

export type OperationPolicyDecision = Readonly<{
  allowed: boolean;
  operationName: OperationName;
  client: OperationClient;
  baseRiskClass: OperationRiskClass;
  effectiveRiskClass: OperationRiskClass;
  requiredApproval: "NONE" | "SESSION_OR_EXPLICIT" | "EXPLICIT_OR_NARROW_POLICY" | "FRESH_EXPLICIT";
  reason: string;
}>;

const riskRank: Record<OperationRiskClass, number> = {
  READ_ONLY: 0,
  SAFE_WRITE: 1,
  SENSITIVE_WRITE: 2,
  DESTRUCTIVE: 3,
};
const destructiveApprovalFreshnessMs = 5 * 60 * 1000;

function effectiveRisk(base: OperationRiskClass, contextual?: OperationRiskClass): OperationRiskClass {
  if (!contextual || riskRank[contextual] <= riskRank[base]) return base;
  return contextual;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function approvalIsHuman(approval: ApprovalEvidence): boolean {
  return approval.kind !== "NONE" && approval.approvedBy === "HUMAN";
}

function sessionPolicyMatches(
  approval: ApprovalEvidence,
  operationName: OperationName,
  resourceId: string,
  nowMs: number,
): approval is SessionPolicyApproval {
  if (approval.kind !== "SESSION_POLICY" || !approvalIsHuman(approval)) return false;
  const expiresAt = timestamp(approval.expiresAt);
  if (expiresAt === null || expiresAt <= nowMs) return false;
  return approval.operationNames.includes(operationName) && approval.resourceIds.includes(resourceId);
}

function explicitApprovalMatches(
  approval: ApprovalEvidence,
  operationName: OperationName,
  resourceId: string,
  nowMs: number,
): approval is ExplicitApproval {
  if (approval.kind !== "EXPLICIT" || !approvalIsHuman(approval)) return false;
  const issuedAt = timestamp(approval.issuedAt);
  const expiresAt = timestamp(approval.expiresAt);
  if (issuedAt === null || expiresAt === null || issuedAt > nowMs || expiresAt <= nowMs) return false;
  return approval.operationName === operationName && approval.resourceId === resourceId;
}

function decision(
  input: OperationPolicyInput,
  baseRiskClass: OperationRiskClass,
  effectiveRiskClass: OperationRiskClass,
  allowed: boolean,
  requiredApproval: OperationPolicyDecision["requiredApproval"],
  reason: string,
): OperationPolicyDecision {
  return {
    allowed,
    operationName: input.operationName,
    client: input.client,
    baseRiskClass,
    effectiveRiskClass,
    requiredApproval,
    reason,
  };
}

export function evaluateOperationPolicy(input: OperationPolicyInput): OperationPolicyDecision {
  const definition = getOperationDefinition(input.operationName);
  const baseRiskClass = definition.riskClass;
  const effectiveRiskClass = effectiveRisk(baseRiskClass, input.contextualRiskClass);
  const approval = input.approval ?? { kind: "NONE" as const };
  const nowMs = (input.now ?? new Date()).getTime();

  if (!Number.isFinite(nowMs)) {
    return decision(input, baseRiskClass, effectiveRiskClass, false, "FRESH_EXPLICIT", "policy clock is invalid");
  }

  if (effectiveRiskClass === "READ_ONLY") {
    return decision(input, baseRiskClass, effectiveRiskClass, true, "NONE", "read-only operation");
  }

  const explicit = explicitApprovalMatches(approval, input.operationName, input.resourceId, nowMs);
  const session = sessionPolicyMatches(approval, input.operationName, input.resourceId, nowMs);

  if (effectiveRiskClass === "SAFE_WRITE") {
    if (explicit || session) {
      return decision(input, baseRiskClass, effectiveRiskClass, true, "SESSION_OR_EXPLICIT", explicit ? "explicit human approval" : "matching human session policy");
    }
    return decision(input, baseRiskClass, effectiveRiskClass, false, "SESSION_OR_EXPLICIT", "safe write requires matching human approval or session policy");
  }

  if (effectiveRiskClass === "SENSITIVE_WRITE") {
    if (explicit) {
      return decision(input, baseRiskClass, effectiveRiskClass, true, "EXPLICIT_OR_NARROW_POLICY", "explicit human approval");
    }
    if (session && approval.kind === "SESSION_POLICY" && approval.allowSensitive === true) {
      return decision(input, baseRiskClass, effectiveRiskClass, true, "EXPLICIT_OR_NARROW_POLICY", "matching narrow human session policy permits sensitive writes");
    }
    return decision(input, baseRiskClass, effectiveRiskClass, false, "EXPLICIT_OR_NARROW_POLICY", "sensitive write requires explicit approval or a narrow sensitive-write policy");
  }

  if (!explicit || approval.kind !== "EXPLICIT") {
    return decision(input, baseRiskClass, effectiveRiskClass, false, "FRESH_EXPLICIT", "destructive operation requires fresh explicit human approval");
  }
  const issuedAt = timestamp(approval.issuedAt);
  if (issuedAt === null || nowMs - issuedAt > destructiveApprovalFreshnessMs) {
    return decision(input, baseRiskClass, effectiveRiskClass, false, "FRESH_EXPLICIT", "destructive approval is stale");
  }
  return decision(input, baseRiskClass, effectiveRiskClass, true, "FRESH_EXPLICIT", "fresh explicit human approval");
}
