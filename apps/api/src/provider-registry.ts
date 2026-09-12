export type ProviderId =
  | "hetzner"
  | "aws"
  | "gcp"
  | "azure"
  | "digitalocean"
  | "ovhcloud"
  | "vultr"
  | "akamai-linode"
  | "scaleway"
  | "generic-vps";

export type ProviderConnectionMethod =
  | "API_TOKEN"
  | "OAUTH"
  | "SERVICE_PRINCIPAL"
  | "AGENT_BOOTSTRAP"
  | "SSH_GUIDED";

export type ProviderCapability =
  | "ACCOUNT_DISCOVERY"
  | "COMPUTE_DISCOVERY"
  | "NETWORK_DISCOVERY"
  | "FIREWALL_DISCOVERY"
  | "COST_METADATA"
  | "AGENT_INSTALL"
  | "GENERIC_LINUX";

export type ProviderGuidanceStep = Readonly<{
  id: string;
  title: string;
  path: readonly string[];
  instructions: string;
  requiredPermissions: readonly string[];
  verification: string;
  lastVerifiedAt: string;
}>;

export type ProviderDefinition = Readonly<{
  id: ProviderId;
  name: string;
  connectionMethods: readonly ProviderConnectionMethod[];
  capabilities: readonly ProviderCapability[];
  adapterStatus: "AVAILABLE" | "GUIDED_ONLY" | "GENERIC";
  guidance: readonly ProviderGuidanceStep[];
}>;

const catalog: readonly ProviderDefinition[] = Object.freeze([
  {
    id: "hetzner",
    name: "Hetzner Cloud",
    connectionMethods: ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "AVAILABLE",
    guidance: [
      {
        id: "hetzner-api-token",
        title: "Create a Hetzner Cloud API token",
        path: ["Project", "Security", "API Tokens", "Generate API Token"],
        instructions: "Create a token for the selected Hetzner project and paste it only into Rundea's protected credential field.",
        requiredPermissions: ["Read & Write"],
        verification: "Rundea verifies the token by reading the project server inventory before storing the encrypted credential.",
        lastVerifiedAt: "2026-09-12",
      },
    ],
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    connectionMethods: ["SERVICE_PRINCIPAL", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "gcp",
    name: "Google Cloud Platform",
    connectionMethods: ["OAUTH", "SERVICE_PRINCIPAL", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    connectionMethods: ["OAUTH", "SERVICE_PRINCIPAL", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    connectionMethods: ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "ovhcloud",
    name: "OVHcloud",
    connectionMethods: ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "vultr",
    name: "Vultr",
    connectionMethods: ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "akamai-linode",
    name: "Akamai / Linode",
    connectionMethods: ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "scaleway",
    name: "Scaleway",
    connectionMethods: ["API_TOKEN", "AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["ACCOUNT_DISCOVERY", "COMPUTE_DISCOVERY", "NETWORK_DISCOVERY", "FIREWALL_DISCOVERY", "COST_METADATA", "AGENT_INSTALL"],
    adapterStatus: "GUIDED_ONLY",
    guidance: [],
  },
  {
    id: "generic-vps",
    name: "Other server / Generic VPS",
    connectionMethods: ["AGENT_BOOTSTRAP", "SSH_GUIDED"],
    capabilities: ["AGENT_INSTALL", "GENERIC_LINUX"],
    adapterStatus: "GENERIC",
    guidance: [],
  },
]);

const byId = new Map(catalog.map((provider) => [provider.id, provider] as const));

export function providerCatalog(): readonly ProviderDefinition[] {
  return catalog;
}

export function providerDefinition(id: string): ProviderDefinition | null {
  return byId.get(id as ProviderId) ?? null;
}
