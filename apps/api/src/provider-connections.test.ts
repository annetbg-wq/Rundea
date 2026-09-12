import assert from "node:assert/strict";
import test from "node:test";
import { decryptProviderCredential } from "@rundea/crypto";
import { staticTokenOperationActor, type OAuthOperationActor } from "./operation-actor";
import { ProviderAdapterError, type ProviderAdapter, type ProviderDiscovery } from "./provider-adapter";
import {
  authenticateProviderForActor,
  getProviderConnectionForActor,
  ProviderConnectionAccessError,
  refreshProviderForActor,
  selectProviderForActor,
  StaticProviderAdapterResolver,
  type ProjectProviderRepository,
  type ProviderConnectionState,
} from "./provider-connections";
import type { ProviderId } from "./provider-registry";
import type { WorkspaceRole } from "./workspace-projects";

const projectId = "22222222-2222-4222-8222-222222222222";
const masterKey = Buffer.alloc(32, 9);
const token = "hetzner-secret-token-that-is-long-enough";
const alice: OAuthOperationActor = {
  authenticationMethod: "OAUTH",
  issuer: "https://auth.rundea.test",
  subject: "alice",
  scopes: ["openid"],
};
const bob: OAuthOperationActor = { ...alice, subject: "bob" };

function discovery(): ProviderDiscovery {
  return {
    providerId: "hetzner",
    accountContext: { providerProjectId: null, providerProjectName: null },
    compute: [
      {
        providerResourceId: "101",
        name: "rundea-node",
        status: "running",
        publicIPv4: "203.0.113.10",
        publicIPv6: null,
        privateAddresses: [],
        location: "nbg1",
        networkZone: "eu-central",
        serverType: "cx23",
        vcpu: 2,
        memoryGb: 4,
        diskGb: 40,
        image: "ubuntu-24.04",
        labels: {},
      },
    ],
    networks: [],
    firewalls: [],
  };
}

class MemoryRepository implements ProjectProviderRepository {
  roles = new Map<string, WorkspaceRole>();
  connection: any = null;

  private key(actor: OAuthOperationActor) {
    return `${actor.issuer}\u0000${actor.subject}`;
  }

  grant(actor: OAuthOperationActor, role: WorkspaceRole) {
    this.roles.set(this.key(actor), role);
  }

  async projectRole(_projectId: string, issuer: string, subject: string) {
    return this.roles.get(`${issuer}\u0000${subject}`) ?? null;
  }

  async selectProvider(input: { id: string; projectId: string; providerId: ProviderId; state: ProviderConnectionState; guidanceStepId: string | null }) {
    const now = new Date(0).toISOString();
    this.connection = {
      id: this.connection?.id ?? input.id,
      projectId: input.projectId,
      providerId: input.providerId,
      state: input.state,
      credentialKind: null,
      encryptedCredential: null,
      accountContext: {},
      discovery: {},
      selectedComputeId: null,
      guidanceStepId: input.guidanceStepId,
      lastErrorCode: null,
      lastVerifiedAt: null,
      createdAt: this.connection?.createdAt ?? now,
      updatedAt: now,
    };
    return this.connection;
  }

  async setState(_projectId: string, _providerId: ProviderId, state: ProviderConnectionState, lastErrorCode: string | null = null) {
    if (!this.connection) throw new Error("missing connection");
    this.connection = { ...this.connection, state, lastErrorCode };
    return this.connection;
  }

  async saveReady(input: { projectId: string; providerId: ProviderId; encryptedCredential: any; discovery: ProviderDiscovery }) {
    if (!this.connection) throw new Error("missing connection");
    this.connection = {
      ...this.connection,
      state: "READY",
      credentialKind: "API_TOKEN",
      encryptedCredential: input.encryptedCredential,
      accountContext: input.discovery.accountContext,
      discovery: {
        compute: input.discovery.compute,
        networks: input.discovery.networks,
        firewalls: input.discovery.firewalls,
      },
      lastErrorCode: null,
      lastVerifiedAt: new Date(0).toISOString(),
    };
    return this.connection;
  }

  async getConnection(_projectId: string, providerId: ProviderId) {
    return this.connection?.providerId === providerId ? this.connection : null;
  }
}

class FakeHetznerAdapter implements ProviderAdapter {
  readonly providerId = "hetzner" as const;
  calls = 0;
  fail: ProviderAdapterError | null = null;

  async discover(value: string) {
    this.calls += 1;
    assert.equal(value, token);
    if (this.fail) throw this.fail;
    return discovery();
  }
}

async function assertAccessError(promise: Promise<unknown>, statusCode: number) {
  await assert.rejects(promise, (error: unknown) => error instanceof ProviderConnectionAccessError && error.statusCode === statusCode);
}

test("owner selects Hetzner and receives exact guided authentication step", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");

  const result = await selectProviderForActor(repository, alice, projectId, "hetzner");
  assert.equal(result.state, "AUTH_REQUIRED");
  assert.equal(result.guidanceStepId, "hetzner-api-token");
  assert.equal("encryptedCredential" in result, false);
});

test("available API-token providers derive AUTH_REQUIRED from the registry instead of provider-specific code", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");

  const result = await selectProviderForActor(repository, alice, projectId, "digitalocean");
  assert.equal(result.state, "AUTH_REQUIRED");
  assert.equal(result.guidanceStepId, "digitalocean-api-token");
});

test("viewer is rejected before provider selection or discovery", async () => {
  const repository = new MemoryRepository();
  repository.grant(bob, "VIEWER");
  const adapter = new FakeHetznerAdapter();
  const resolver = new StaticProviderAdapterResolver([adapter]);

  await assertAccessError(selectProviderForActor(repository, bob, projectId, "hetzner"), 403);
  await assertAccessError(
    authenticateProviderForActor(repository, resolver, masterKey, bob, projectId, "hetzner", token),
    403,
  );
  assert.equal(adapter.calls, 0);
});

test("successful provider authentication stores an encrypted token but never returns it", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "ADMIN");
  const adapter = new FakeHetznerAdapter();
  const resolver = new StaticProviderAdapterResolver([adapter]);
  await selectProviderForActor(repository, alice, projectId, "hetzner");

  const result = await authenticateProviderForActor(repository, resolver, masterKey, alice, projectId, "hetzner", token);

  assert.equal(result.state, "READY");
  assert.equal(adapter.calls, 1);
  assert.equal(result.discovery.compute?.[0]?.name, "rundea-node");
  assert.equal("encryptedCredential" in result, false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(repository.connection.encryptedCredential).includes(token), false);
  assert.equal(decryptProviderCredential(repository.connection.encryptedCredential, masterKey), token);
});

test("authentication failure becomes explicit connection state and does not persist the credential", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");
  const adapter = new FakeHetznerAdapter();
  adapter.fail = new ProviderAdapterError("AUTH_FAILED", "provider-specific secret response must stay internal");
  const resolver = new StaticProviderAdapterResolver([adapter]);
  await selectProviderForActor(repository, alice, projectId, "hetzner");

  await assertAccessError(
    authenticateProviderForActor(repository, resolver, masterKey, alice, projectId, "hetzner", token),
    400,
  );
  assert.equal(repository.connection.state, "AUTH_FAILED");
  assert.equal(repository.connection.lastErrorCode, "AUTH_FAILED");
  assert.equal(repository.connection.encryptedCredential, null);
});

test("refresh decrypts the stored credential internally and updates discovery without exposing it", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");
  const adapter = new FakeHetznerAdapter();
  const resolver = new StaticProviderAdapterResolver([adapter]);
  await selectProviderForActor(repository, alice, projectId, "hetzner");
  await authenticateProviderForActor(repository, resolver, masterKey, alice, projectId, "hetzner", token);

  const refreshed = await refreshProviderForActor(repository, resolver, masterKey, alice, projectId, "hetzner");
  assert.equal(adapter.calls, 2);
  assert.equal(refreshed.state, "READY");
  assert.equal(JSON.stringify(refreshed).includes(token), false);
});

test("static administrative identity and non-members cannot use project provider credentials", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");
  await selectProviderForActor(repository, alice, projectId, "hetzner");

  await assertAccessError(getProviderConnectionForActor(repository, staticTokenOperationActor, projectId, "hetzner"), 403);
  await assertAccessError(getProviderConnectionForActor(repository, bob, projectId, "hetzner"), 404);
});

test("preset providers without an implemented adapter remain guided instead of pretending to be connected", async () => {
  const repository = new MemoryRepository();
  repository.grant(alice, "OWNER");
  const result = await selectProviderForActor(repository, alice, projectId, "aws");
  assert.equal(result.state, "NEEDS_USER_STEP");
});
