import type { ProviderId } from "./provider-registry";

export type ProviderDiscoveryFailure =
  | "AUTH_FAILED"
  | "INSUFFICIENT_PERMISSION"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_RESPONSE";

export class ProviderAdapterError extends Error {
  constructor(
    public readonly reason: ProviderDiscoveryFailure,
    message: string,
  ) {
    super(message);
    this.name = "ProviderAdapterError";
  }
}

export type ProviderComputeResource = Readonly<{
  providerResourceId: string;
  name: string;
  status: string;
  publicIPv4: string | null;
  publicIPv6: string | null;
  privateAddresses: readonly string[];
  location: string | null;
  networkZone: string | null;
  serverType: string | null;
  vcpu: number | null;
  memoryGb: number | null;
  diskGb: number | null;
  image: string | null;
  labels: Readonly<Record<string, string>>;
}>;

export type ProviderNetworkResource = Readonly<{
  providerResourceId: string;
  name: string;
  ipRange: string | null;
}>;

export type ProviderFirewallResource = Readonly<{
  providerResourceId: string;
  name: string;
}>;

export type ProviderDiscovery = Readonly<{
  providerId: ProviderId;
  accountContext: Readonly<{
    providerProjectId: string | null;
    providerProjectName: string | null;
  }>;
  compute: readonly ProviderComputeResource[];
  networks: readonly ProviderNetworkResource[];
  firewalls: readonly ProviderFirewallResource[];
}>;

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  discover(credential: string): Promise<ProviderDiscovery>;
}
