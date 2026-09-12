import assert from "node:assert/strict";
import test from "node:test";
import { DigitalOceanProviderAdapter } from "./digitalocean-provider";
import { ProviderAdapterError } from "./provider-adapter";

const token = "dop_v1_test_token_that_is_long_enough_for_rundea";

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

test("DigitalOcean adapter discovers account, Droplets, VPCs and firewalls without returning the credential", async () => {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    assert.equal(authorization(init), `Bearer ${token}`);
    if (url === "https://api.digitalocean.com/v2/account") {
      return Response.json({ account: { uuid: "account-uuid", email: "must-not-be-returned@example.test" } });
    }
    if (url.includes("/droplets?")) {
      return Response.json({
        droplets: [
          {
            id: 101,
            name: "app-1",
            status: "active",
            memory: 4096,
            vcpus: 2,
            disk: 80,
            region: { slug: "fra1" },
            size_slug: "s-2vcpu-4gb",
            vpc_uuid: "vpc-uuid",
            image: { slug: "ubuntu-24-04-x64", name: "Ubuntu 24.04" },
            networks: {
              v4: [
                { ip_address: "203.0.113.20", type: "public" },
                { ip_address: "10.10.0.5", type: "private" },
              ],
              v6: [{ ip_address: "2001:db8::20", type: "public" }],
            },
          },
        ],
      });
    }
    if (url.includes("/vpcs?")) return Response.json({ vpcs: [{ id: "vpc-uuid", name: "private", ip_range: "10.10.0.0/16" }] });
    if (url.includes("/firewalls?")) return Response.json({ firewalls: [{ id: "firewall-uuid", name: "web" }] });
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await new DigitalOceanProviderAdapter(fetchImpl).discover(token);

  assert.equal(result.providerId, "digitalocean");
  assert.deepEqual(result.accountContext, {
    providerAccountId: "account-uuid",
    providerAccountName: null,
    providerProjectId: null,
    providerProjectName: null,
  });
  assert.deepEqual(result.compute, [
    {
      providerResourceId: "101",
      name: "app-1",
      status: "active",
      publicIPv4: "203.0.113.20",
      publicIPv6: "2001:db8::20",
      privateAddresses: ["10.10.0.5"],
      location: "fra1",
      networkZone: "vpc-uuid",
      serverType: "s-2vcpu-4gb",
      vcpu: 2,
      memoryGb: 4,
      diskGb: 80,
      image: "ubuntu-24-04-x64",
      labels: {},
    },
  ]);
  assert.deepEqual(result.networks, [{ providerResourceId: "vpc-uuid", name: "private", ipRange: "10.10.0.0/16" }]);
  assert.deepEqual(result.firewalls, [{ providerResourceId: "firewall-uuid", name: "web" }]);
  assert.equal(requested.length, 4);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});

test("DigitalOcean pagination is bounded and does not follow provider-controlled next URLs", async () => {
  const dropletPages: number[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === "/v2/account") return Response.json({ account: { uuid: "account-uuid" } });
    if (url.pathname === "/v2/droplets") {
      const page = Number(url.searchParams.get("page"));
      dropletPages.push(page);
      const count = page === 1 ? 200 : 1;
      return Response.json({
        droplets: Array.from({ length: count }, (_, index) => ({ id: page * 1000 + index + 1, status: "active" })),
        links: { pages: { next: "https://attacker.invalid/steal-token" } },
      });
    }
    if (url.pathname === "/v2/vpcs") return Response.json({ vpcs: [] });
    if (url.pathname === "/v2/firewalls") return Response.json({ firewalls: [] });
    throw new Error("unexpected URL");
  };

  const result = await new DigitalOceanProviderAdapter(fetchImpl).discover(token);
  assert.deepEqual(dropletPages, [1, 2]);
  assert.equal(result.compute.length, 201);
});

test("DigitalOcean adapter maps insufficient read scope without exposing response content", async () => {
  const fetchImpl = async (): Promise<Response> => new Response("secret diagnostic body", { status: 403 });
  await assert.rejects(
    () => new DigitalOceanProviderAdapter(fetchImpl).discover(token),
    (error: unknown) =>
      error instanceof ProviderAdapterError &&
      error.reason === "INSUFFICIENT_PERMISSION" &&
      !error.message.includes("secret diagnostic body"),
  );
});
