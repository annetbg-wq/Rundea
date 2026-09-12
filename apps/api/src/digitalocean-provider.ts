import {
  ProviderAdapterError,
  type ProviderAdapter,
  type ProviderComputeResource,
  type ProviderDiscovery,
  type ProviderFirewallResource,
  type ProviderNetworkResource,
} from "./provider-adapter";

const apiBase = "https://api.digitalocean.com/v2";
const maxPages = 20;
const perPage = 200;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requireCredential(value: string): string {
  const token = value.trim();
  if (token.length < 20 || token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new ProviderAdapterError("AUTH_FAILED", "DigitalOcean API token is invalid");
  }
  return token;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\r\n\u0000]/.test(value) ? value : null;
}

function safeId(value: unknown): string {
  if ((typeof value === "number" && Number.isSafeInteger(value) && value > 0) || (typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\r\n\u0000]/.test(value))) {
    return String(value);
  }
  throw new ProviderAdapterError("INVALID_RESPONSE", "DigitalOcean resource identity is invalid");
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeDroplet(droplet: any): ProviderComputeResource {
  const v4 = Array.isArray(droplet?.networks?.v4) ? droplet.networks.v4 : [];
  const v6 = Array.isArray(droplet?.networks?.v6) ? droplet.networks.v6 : [];
  const publicIPv4 = v4.map((item: any) => item?.type === "public" ? safeString(item?.ip_address) : null).find(Boolean) ?? null;
  const publicIPv6 = v6.map((item: any) => item?.type === "public" ? safeString(item?.ip_address) : null).find(Boolean) ?? null;
  const privateAddresses = [
    ...v4.flatMap((item: any) => item?.type === "private" && safeString(item?.ip_address) ? [String(item.ip_address)] : []),
    ...v6.flatMap((item: any) => item?.type === "private" && safeString(item?.ip_address) ? [String(item.ip_address)] : []),
  ];
  const memoryMb = safeNumber(droplet?.memory);
  const id = safeId(droplet?.id);
  return Object.freeze({
    providerResourceId: id,
    name: safeString(droplet?.name) ?? `droplet-${id}`,
    status: safeString(droplet?.status) ?? "unknown",
    publicIPv4,
    publicIPv6,
    privateAddresses: Object.freeze(privateAddresses),
    location: safeString(droplet?.region?.slug),
    networkZone: safeString(droplet?.vpc_uuid),
    serverType: safeString(droplet?.size_slug),
    vcpu: safeNumber(droplet?.vcpus),
    memoryGb: memoryMb === null ? null : memoryMb / 1024,
    diskGb: safeNumber(droplet?.disk),
    image: safeString(droplet?.image?.slug) ?? safeString(droplet?.image?.name),
    labels: Object.freeze({}),
  });
}

function normalizeVpc(vpc: any): ProviderNetworkResource {
  const id = safeId(vpc?.id ?? vpc?.uuid);
  return Object.freeze({
    providerResourceId: id,
    name: safeString(vpc?.name) ?? `vpc-${id}`,
    ipRange: safeString(vpc?.ip_range),
  });
}

function normalizeFirewall(firewall: any): ProviderFirewallResource {
  const id = safeId(firewall?.id);
  return Object.freeze({
    providerResourceId: id,
    name: safeString(firewall?.name) ?? `firewall-${id}`,
  });
}

export class DigitalOceanProviderAdapter implements ProviderAdapter {
  readonly providerId = "digitalocean" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async request(path: string, token: string): Promise<any> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${apiBase}/${path}`, {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "Rundea-Control-Plane",
        },
      });
    } catch {
      throw new ProviderAdapterError("PROVIDER_UNAVAILABLE", "DigitalOcean API is unavailable");
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("AUTH_FAILED", "DigitalOcean rejected the API token");
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("INSUFFICIENT_PERMISSION", "DigitalOcean API token has insufficient permission");
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("PROVIDER_UNAVAILABLE", "DigitalOcean API is temporarily unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAdapterError("INVALID_RESPONSE", "DigitalOcean API request failed");
    }
    try {
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
      return body;
    } catch {
      throw new ProviderAdapterError("INVALID_RESPONSE", "DigitalOcean API returned invalid JSON");
    }
  }

  private async all(path: "droplets" | "vpcs" | "firewalls", token: string): Promise<any[]> {
    const values: any[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const body = await this.request(`${path}?per_page=${perPage}&page=${page}`, token);
      const pageValues = body[path];
      if (!Array.isArray(pageValues)) throw new ProviderAdapterError("INVALID_RESPONSE", `DigitalOcean ${path} response is invalid`);
      values.push(...pageValues);
      if (pageValues.length < perPage) return values;
    }
    throw new ProviderAdapterError("INVALID_RESPONSE", `DigitalOcean ${path} pagination exceeded the safe limit`);
  }

  async discover(credential: string): Promise<ProviderDiscovery> {
    const token = requireCredential(credential);
    const [accountBody, droplets, vpcs, firewalls] = await Promise.all([
      this.request("account", token),
      this.all("droplets", token),
      this.all("vpcs", token),
      this.all("firewalls", token),
    ]);
    const account = accountBody?.account;
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw new ProviderAdapterError("INVALID_RESPONSE", "DigitalOcean account response is invalid");
    }
    const accountId = safeString(account.uuid);
    if (!accountId) throw new ProviderAdapterError("INVALID_RESPONSE", "DigitalOcean account identity is invalid");

    return Object.freeze({
      providerId: this.providerId,
      accountContext: Object.freeze({
        providerAccountId: accountId,
        providerAccountName: null,
        providerProjectId: null,
        providerProjectName: null,
      }),
      compute: Object.freeze(droplets.map(normalizeDroplet)),
      networks: Object.freeze(vpcs.map(normalizeVpc)),
      firewalls: Object.freeze(firewalls.map(normalizeFirewall)),
    });
  }
}
