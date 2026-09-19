import { isIP } from "node:net";
import type { AgentHelloEvent } from "@rundea/contracts";
import type { RundeaEnvironment } from "./live-environment";

export const requiredAgentCapabilities = [
  "artifactRetention",
  "buildArgs",
  "buildGuardrails",
  "continuousHealth",
  "managedIngress",
  "managedRedis",
  "nodeCapacity",
  "nodeDiskMetrics",
  "persistentVolumes",
  "privateNetworking",
  "resourceGuardrails",
  "runtimeMetrics",
] as const;

const agentVersionPattern = /^\d+\.\d+\.\d+$/;
const immutableBuildShaPattern = /^[0-9a-f]{40}$/;
const capabilityPattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const maxCapabilities = 64;

export type ValidatedAgentIdentity = Readonly<{
  agentVersion: string;
  buildSha: string;
  capabilities: string[];
  publicAddresses: string[];
}>;

export function validateAgentHello(event: AgentHelloEvent, environment: RundeaEnvironment): ValidatedAgentIdentity {
  const agentVersion = event.agentVersion?.trim();
  if (!agentVersionPattern.test(agentVersion)) {
    throw new Error("Agent hello contains an invalid semantic version");
  }

  const buildSha = event.buildSha?.trim().toLowerCase();
  if (environment === "development") {
    if (buildSha !== "development" && !immutableBuildShaPattern.test(buildSha)) {
      throw new Error("Agent hello contains an invalid build SHA");
    }
  } else if (!immutableBuildShaPattern.test(buildSha)) {
    throw new Error(`${environment} Agent must report an immutable 40-character build SHA`);
  }

  if (!Array.isArray(event.capabilities) || event.capabilities.length > maxCapabilities) {
    throw new Error(`Agent hello supports at most ${maxCapabilities} capabilities`);
  }

  const capabilities = event.capabilities.map((value) => value?.trim());
  if (capabilities.some((value) => !capabilityPattern.test(value))) {
    throw new Error("Agent hello contains an invalid capability name");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Agent hello contains duplicate capabilities");
  }

  for (const required of requiredAgentCapabilities) {
    if (!capabilities.includes(required)) {
      throw new Error(`Agent is missing required capability: ${required}`);
    }
  }

  const publicAddresses = event.publicAddresses ?? [];
  if (!Array.isArray(publicAddresses) || publicAddresses.length > 8) {
    throw new Error("Agent hello supports at most 8 public addresses");
  }
  const normalizedAddresses = publicAddresses.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (normalizedAddresses.length !== publicAddresses.length || normalizedAddresses.some((value) => isIP(value) === 0)) {
    throw new Error("Agent hello contains an invalid public address");
  }
  if (new Set(normalizedAddresses).size !== normalizedAddresses.length) {
    throw new Error("Agent hello contains duplicate public addresses");
  }

  return {
    agentVersion,
    buildSha,
    capabilities: [...capabilities].sort(),
    publicAddresses: [...normalizedAddresses].sort(),
  };
}
