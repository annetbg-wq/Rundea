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

export const nodeQualificationProfiles = ["sendina-egress-v1"] as const;
export type NodeQualificationProfile = (typeof nodeQualificationProfiles)[number];

export type DeployCommand = {
  type: "deploy";
  deploymentId: string;
  serviceName: string;
  source: {
    repository: string;
    ref: string;
    dockerfile?: string;
  };
  runtime: {
    containerName: string;
    containerPort: number;
    hostPort: number;
    environment: Record<string, string>;
    healthcheck: {
      path: string;
      timeoutSeconds: number;
    };
  };
};

export type QualifyNodeCommand = {
  type: "qualify";
  qualificationId: string;
  profile: NodeQualificationProfile;
};

export type AgentCommand = DeployCommand | QualifyNodeCommand;

export type NodeProbeResult = {
  name: string;
  host: string;
  port: number;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

export type AgentEvent =
  | { type: "heartbeat"; at: string }
  | { type: "status"; deploymentId: string; status: DeploymentStatus; message?: string; containerId?: string }
  | { type: "log"; deploymentId: string; stream: "build" | "runtime" | "system"; message: string; at: string }
  | {
      type: "qualification";
      qualificationId: string;
      profile: NodeQualificationProfile;
      ok: boolean;
      startedAt: string;
      completedAt: string;
      probes: NodeProbeResult[];
    };
