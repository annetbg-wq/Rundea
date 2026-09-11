export type OperationRiskClass = "READ_ONLY" | "SAFE_WRITE" | "SENSITIVE_WRITE" | "DESTRUCTIVE";

export type OperationDefinition<Name extends string = string> = Readonly<{
  name: Name;
  riskClass: OperationRiskClass;
  resource: "deployment" | "node" | "service" | "source";
  mutation: boolean;
  verification: "none" | "runtime-health" | "deployment-ready";
  approval: "none" | "session-policy" | "explicit-or-policy";
}>;

export const operationRegistry = {
  "source.github.discover": {
    name: "source.github.discover",
    riskClass: "READ_ONLY",
    resource: "source",
    mutation: false,
    verification: "none",
    approval: "none",
  },
  "deployment.metrics.read": {
    name: "deployment.metrics.read",
    riskClass: "READ_ONLY",
    resource: "deployment",
    mutation: false,
    verification: "none",
    approval: "none",
  },
  "node.qualifications.read": {
    name: "node.qualifications.read",
    riskClass: "READ_ONLY",
    resource: "node",
    mutation: false,
    verification: "none",
    approval: "none",
  },
  "service.variables.read": {
    name: "service.variables.read",
    riskClass: "READ_ONLY",
    resource: "service",
    mutation: false,
    verification: "none",
    approval: "none",
  },
  "service.variables.upsert": {
    name: "service.variables.upsert",
    riskClass: "SAFE_WRITE",
    resource: "service",
    mutation: true,
    verification: "none",
    approval: "session-policy",
  },
  "service.variable.delete": {
    name: "service.variable.delete",
    riskClass: "SENSITIVE_WRITE",
    resource: "service",
    mutation: true,
    verification: "none",
    approval: "explicit-or-policy",
  },
  "deployment.restart": {
    name: "deployment.restart",
    riskClass: "SAFE_WRITE",
    resource: "deployment",
    mutation: true,
    verification: "runtime-health",
    approval: "session-policy",
  },
  "deployment.rollback": {
    name: "deployment.rollback",
    riskClass: "SENSITIVE_WRITE",
    resource: "deployment",
    mutation: true,
    verification: "deployment-ready",
    approval: "explicit-or-policy",
  },
} as const satisfies Record<string, OperationDefinition>;

export type OperationName = keyof typeof operationRegistry;

export function getOperationDefinition<Name extends OperationName>(name: Name): (typeof operationRegistry)[Name] {
  return operationRegistry[name];
}
