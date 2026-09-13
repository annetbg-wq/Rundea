import assert from "node:assert/strict";
import test from "node:test";
import { HetznerProviderAdapter } from "./hetzner-provider";
import { ProviderAdapterError } from "./provider-adapter";

const token = "hetzner-test-token-that-is-long-enough";

function auth(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

test("Hetzner adapter discovers compute/network/firewall metadata without returning the credential", async () => {
  const seen: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    assert.equal(auth(init), `Bearer ${token}`);
    if (url.includes("/servers?")) {
      return Response.json({
        servers: [
          {
            id: 101,
            name: "app-1",
            status: "running",
            public_net: { ipv4: { ip: "203.0.113.10" }, ipv6: { ip: "2001:db8::/64" } },
            private_net: [{ ip: "10.0.0.5" }],
            datacenter: { location: { name: "nbg1", network_zone: "eu-central" } },
            server_type: { name: "cx23", cores: 2, memory: 4, disk: 40 },
            image: { name: "ubuntu-24.04" },
            labels: { environment: "staging" },
          },
        ],
        meta: { pagination: { next_page: null } },
      });
    }
    if (url.includes("/networks?")) {
      return Response.json({ networks: [{ id: 201, name: "private", ip_range: "10.0.0.0/16" }], meta: { pagination: { next_page: null } } });
    }
    if (url.includes("/firewalls?")) {
      return Response.json({ firewalls: [{ id: 301, name: "web" }], meta: { pagination: { next_page: null } } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const discovery = await new HetznerProviderAdapter(fetchImpl).discover(token);

  assert.equal(discovery.providerId, "hetzner");
  assert.deepEqual(discovery.accountContext, { providerProjectId: null, providerProjectName: null });
  assert.deepEqual(discovery.compute, [
    {
      providerResourceId: "101",
      name: "app-1",
      status: "running",
      publicIPv4: "203.0.113.10",
      publicIPv6: "2001:db8::/64",
      privateAddresses: ["10.0.0.5"],
      location: "nbg1",
      networkZone: "eu-central",
      serverType: "cx23",
      vcpu: 2,
      memoryGb: 4,
      diskGb: 40,
      image: "ubuntu-24.04",
      labels: { environment: "staging" },
    },
  ]);
  assert.deepEqual(discovery.networks, [{ providerResourceId: "201", name: "private", ipRange: "10.0.0.0/16" }]);
  assert.deepEqual(discovery.firewalls, [{ providerResourceId: "301", name: "web" }]);
  assert.equal(seen.length, 3);
  assert.equal(JSON.stringify(discovery).includes(token), false);
});

test("Hetzner adapter paginates with a bounded next-page contract", async () => {
  const pages: number[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/servers")) {
      pages.push(page);
      return Response.json({
        servers: [{ id: page, name: `s-${page}`, status: "running" }],
        meta: { pagination: { next_page: page === 1 ? 2 : null } },
      });
    }
    if (url.pathname.endsWith("/networks")) return Response.json({ networks: [], meta: { pagination: { next_page: null } } });
    if (url.pathname.endsWith("/firewalls")) return Response.json({ firewalls: [], meta: { pagination: { next_page: null } } });
    throw new Error("unexpected URL");
  };

  const discovery = await new HetznerProviderAdapter(fetchImpl).discover(token);
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(discovery.compute.map((server) => server.providerResourceId), ["1", "2"]);
});

test("Hetzner adapter maps authentication failures without leaking provider response bodies", async () => {
  const fetchImpl = async (): Promise<Response> => new Response("token=should-not-be-surfaced", { status: 401 });
  await assert.rejects(
    () => new HetznerProviderAdapter(fetchImpl).discover(token),
    (error: unknown) => error instanceof ProviderAdapterError && error.reason === "AUTH_FAILED" && !error.message.includes("should-not-be-surfaced"),
  );
});
