export type OperationRiskClass = "READ_ONLY" | "SAFE_WRITE" | "SENSITIVE_WRITE" | "DESTRUCTIVE";

export type OperationDefinition<Name extends string = string> = Readonly<{
  name: Name;
  riskClass: OperationRiskClass;
  resource: "deployment";
  mutation: boolean;
  verification: "runtime-health" | "deployment-ready";
  approval: "session-policy" | "explicit-or-policy";
}>;

export const operationRegistry = {
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
