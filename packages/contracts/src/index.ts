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
export const runtimeHealthStatuses = ["HEALTHY", "DEGRADED", "DOWN"] as const;
export type RuntimeHealthStatus = (typeof runtimeHealthStatuses)[number];

export const nodeQualificationProfiles = ["sendina-egress-v1"] as const;
export type NodeQualificationProfile = (typeof nodeQualificationProfiles)[number];

export type RuntimeSpec = {
  containerName: string;
  containerPort: number;
  hostPort: number;
  environment: Record<string, string>;
  healthcheck: {
    path: string;
    timeoutSeconds: number;
  };
};

export type BuildSpec = {
  args: Record<string, string>;
};

export type DirectGitSourceSpec = {
  mode?: "git";
  repository: string;
  ref: string;
  dockerfile?: string;
};

export type BrokeredSourceSpec = {
  mode: "bundle";
  ref: string;
  ticket: string;
  dockerfile?: string;
};

export type DeployCommand = {
  type: "deploy";
  deploymentId: string;
  serviceName: string;
  source: DirectGitSourceSpec | BrokeredSourceSpec;
  build?: BuildSpec;
  runtime: RuntimeSpec;
};

export type RollbackCommand = {
  type: "rollback";
  deploymentId: string;
  targetDeploymentId: string;
  expectedImageId: string;
  serviceName: string;
  runtime: RuntimeSpec;
};

export type RestartCommand = {
  type: "restart";
  actionId: string;
  deploymentId: string;
  serviceName: string;
  runtime: {
    containerName: string;
    hostPort: number;
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

export type IngressRoute = {
  hostname: string;
  hostPort: number;
};

export type ReconcileIngressCommand = {
  type: "reconcileIngress";
  reconciliationId: string;
  routes: IngressRoute[];
};

export type AgentCommand = DeployCommand | RollbackCommand | RestartCommand | QualifyNodeCommand | ReconcileIngressCommand;

export type NodeProbeResult = {
  name: string;
  host: string;
  port: number;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

export type AgentHelloEvent = {
  type: "hello";
  agentVersion: string;
  buildSha: string;
  capabilities: string[];
};

export type AgentEvent =
  | AgentHelloEvent
  | { type: "heartbeat"; at: string }
  | { type: "status"; deploymentId: string; status: DeploymentStatus; message?: string; containerId?: string }
  | { type: "artifact"; deploymentId: string; sourceCommitSha: string; imageId: string; healthcheckPath: string }
  | { type: "log"; deploymentId: string; stream: "build" | "runtime" | "system"; message: string; at: string }
  | { type: "runtimeRecovered"; deploymentId: string; containerId: string; at: string }
  | {
      type: "metric";
      deploymentId: string;
      cpuPercent: number;
      memoryUsageBytes: number;
      memoryLimitBytes: number;
      networkRxBytes: number;
      networkTxBytes: number;
      runtimeHealth?: RuntimeHealthStatus;
      restartDelta?: number;
      uptimeSeconds?: number;
      healthError?: string;
      at: string;
    }
  | {
      type: "qualification";
      qualificationId: string;
      profile: NodeQualificationProfile;
      ok: boolean;
      startedAt: string;
      completedAt: string;
      probes: NodeProbeResult[];
    }
  | {
      type: "ingress";
      reconciliationId: string;
      applied: boolean;
      ok: boolean;
      routes: Array<{ hostname: string; ok: boolean; error?: string }>;
      error?: string;
      completedAt: string;
    }
  | {
      type: "runtimeAction";
      actionId: string;
      deploymentId: string;
      kind: "RESTART";
      ok: boolean;
      error?: string;
      completedAt: string;
    }
  | {
      type: "managedRedis";
      addonId: string;
      projectId: string;
      ok: boolean;
      error?: string;
      completedAt: string;
    };
