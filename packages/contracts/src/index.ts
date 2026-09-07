export const deploymentStatuses = [
  "QUEUED",
  "BUILDING",
  "DEPLOYING",
  "HEALTHCHECK",
  "READY",
  "FAILED",
  "CANCELLED",
  "ROLLED_BACK",
] as const;

export type DeploymentStatus = (typeof deploymentStatuses)[number];

export type DeployCommand = {
  type: "deploy";
  deploymentId: string;
  serviceName: string;
  source: {
    repository: string;
    ref: string;
    dockerfile: string;
  };
  runtime: {
    containerName: string;
    containerPort: number;
    hostPort: number;
    healthcheck: {
      path: string;
      timeoutSeconds: number;
    };
  };
};

export type AgentCommand = DeployCommand;

export type AgentEvent =
  | { type: "heartbeat"; at: string }
  | { type: "status"; deploymentId: string; status: DeploymentStatus; message?: string; containerId?: string }
  | { type: "log"; deploymentId: string; stream: "build" | "runtime" | "system"; message: string; at: string };
