import {
  ProviderAdapterError,
  type ProviderAdapter,
  type ProviderComputeResource,
  type ProviderDiscovery,
  type ProviderFirewallResource,
  type ProviderNetworkResource,
} from "./provider-adapter";

const apiBase = "https://api.hetzner.cloud/v1";
const maxPages = 20;
const perPage = 50;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type PaginatedBody = {
  meta?: { pagination?: { next_page?: unknown } };
  [key: string]: unknown;
};

function requireCredential(value: string): string {
  const token = value.trim();
  if (token.length < 20 || token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new ProviderAdapterError("AUTH_FAILED", "Hetzner API token is invalid");
  }
  return token;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\r\n\u0000]/.test(value) ? value : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeId(value: unknown): string {
  if ((typeof value === "number" && Number.isSafeInteger(value) && value > 0) || (typeof value === "string" && /^[1-9][0-9]*$/.test(value))) {
    return String(value);
  }
  throw new ProviderAdapterError("INVALID_RESPONSE", "Hetzner resource identity is invalid");
}

function safeLabels(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const labels: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    if (typeof raw !== "string" || raw.length > 1024 || /[\r\n\u0000]/.test(raw)) continue;
    labels[key] = raw;
  }
  return Object.freeze(labels);
}

function normalizeServer(server: any): ProviderComputeResource {
  const privateAddresses = Array.isArray(server?.private_net)
    ? server.private_net.flatMap((entry: any) => {
        const ip = safeString(entry?.ip);
        return ip ? [ip] : [];
      })
    : [];
  return Object.freeze({
    providerResourceId: safeId(server?.id),
    name: safeString(server?.name) ?? `server-${safeId(server?.id)}`,
    status: safeString(server?.status) ?? "unknown",
    publicIPv4: safeString(server?.public_net?.ipv4?.ip),
    publicIPv6: safeString(server?.public_net?.ipv6?.ip),
    privateAddresses: Object.freeze(privateAddresses),
    location: safeString(server?.datacenter?.location?.name),
    networkZone: safeString(server?.datacenter?.location?.network_zone),
    serverType: safeString(server?.server_type?.name),
    vcpu: safeNumber(server?.server_type?.cores),
    memoryGb: safeNumber(server?.server_type?.memory),
    diskGb: safeNumber(server?.server_type?.disk),
    image: safeString(server?.image?.name) ?? safeString(server?.image?.description),
    labels: safeLabels(server?.labels),
  });
}

function normalizeNetwork(network: any): ProviderNetworkResource {
  return Object.freeze({
    providerResourceId: safeId(network?.id),
    name: safeString(network?.name) ?? `network-${safeId(network?.id)}`,
    ipRange: safeString(network?.ip_range),
  });
}

function normalizeFirewall(firewall: any): ProviderFirewallResource {
  return Object.freeze({
    providerResourceId: safeId(firewall?.id),
    name: safeString(firewall?.name) ?? `firewall-${safeId(firewall?.id)}`,
  });
}

export class HetznerProviderAdapter implements ProviderAdapter {
  readonly providerId = "hetzner" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async page(path: string, token: string, page: number): Promise<PaginatedBody> {
    const url = `${apiBase}/${path}?per_page=${perPage}&page=${page}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "Rundea-Control-Plane",
        },
      });
    } catch {
      throw new ProviderAdapterError("PROVIDER_UNAVAILABLE", "Hetzner API is unavailable");
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("AUTH_FAILED", "Hetzner rejected the API token");
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("INSUFFICIENT_PERMISSION", "Hetzner API token has insufficient permission");
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("PROVIDER_UNAVAILABLE", "Hetzner API is temporarily unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("INVALID_RESPONSE", "Hetzner API request failed");
    }
    try {
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
      return body as PaginatedBody;
    } catch {
      throw new ProviderAdapterError("INVALID_RESPONSE", "Hetzner API returned invalid JSON");
    }
  }

  private async all(path: "servers" | "networks" | "firewalls", token: string): Promise<any[]> {
    const values: any[] = [];
    let page = 1;
    for (let attempt = 0; attempt < maxPages; attempt += 1) {
      const body = await this.page(path, token, page);
      const pageValues = body[path];
      if (!Array.isArray(pageValues)) throw new ProviderAdapterError("INVALID_RESPONSE", `Hetzner ${path} response is invalid`);
      values.push(...pageValues);
      const rawNextPage = body.meta?.pagination?.next_page;
      if (rawNextPage === null || rawNextPage === undefined) return values;
      const nextPage = Number(rawNextPage);
      if (!Number.isSafeInteger(nextPage) || nextPage <= page) {
        throw new ProviderAdapterError("INVALID_RESPONSE", `Hetzner ${path} pagination is invalid`);
      }
      page = nextPage;
    }
    throw new ProviderAdapterError("INVALID_RESPONSE", `Hetzner ${path} pagination exceeded the safe limit`);
  }

  async discover(credential: string): Promise<ProviderDiscovery> {
    const token = requireCredential(credential);
    const [servers, networks, firewalls] = await Promise.all([
      this.all("servers", token),
      this.all("networks", token),
      this.all("firewalls", token),
    ]);
    return Object.freeze({
      providerId: this.providerId,
      accountContext: Object.freeze({ providerProjectId: null, providerProjectName: null }),
      compute: Object.freeze(servers.map(normalizeServer)),
      networks: Object.freeze(networks.map(normalizeNetwork)),
      firewalls: Object.freeze(firewalls.map(normalizeFirewall)),
    });
  }
}
