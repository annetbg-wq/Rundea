import type { DeploymentStatus } from "@rundea/contracts";

const allowed: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  QUEUED: ["BUILDING", "CANCELLED", "FAILED"],
  BUILDING: ["DEPLOYING", "CANCELLED", "FAILED"],
  DEPLOYING: ["HEALTHCHECK", "CANCELLED", "FAILED"],
  HEALTHCHECK: ["READY", "CANCELLED", "FAILED"],
  READY: ["ROLLED_BACK"],
  FAILED: [],
  CANCELLED: [],
  ROLLED_BACK: [],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return allowed[from]?.includes(to) ?? false;
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid deployment transition: ${from} -> ${to}`);
  }
}
