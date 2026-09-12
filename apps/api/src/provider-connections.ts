import { randomUUID } from "node:crypto";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  type EncryptedValue,
} from "@rundea/crypto";
import type { Pool } from "pg";
import {
  ProviderAdapterError,
  type ProviderAdapter,
  type ProviderDiscovery,
} from "./provider-adapter";
import { providerDefinition, type ProviderId } from "./provider-registry";
import type { OperationActor, OAuthOperationActor } from "./operation-actor";
import { workspaceRoleCanManage, type WorkspaceRole } from "./workspace-projects";

export type ProviderConnectionState =
  | "PROVIDER_SELECTED"
  | "AUTH_REQUIRED"
  | "DISCOVERING"
  | "NEEDS_USER_STEP"
  | "VERIFYING_USER_STEP"
  | "DISCOVERING_CONTINUED"
  | "READY"
  | "AUTH_FAILED"
  | "INSUFFICIENT_PERMISSION"
  | "UNSUPPORTED_CONFIGURATION"
  | "PROVIDER_UNAVAILABLE"
  | "VERIFICATION_FAILED";

export type ProviderConnectionSummary = Readonly<{
  id: string;
  projectId: string;
  providerId: ProviderId;
  state: ProviderConnectionState;
  accountContext: ProviderDiscovery["accountContext"] | Readonly<Record<string, never>>;
  discovery: Omit<ProviderDiscovery, "providerId" | "accountContext"> | Readonly<Record<string, never>>;
  selectedComputeId: string | null;
  guidanceStepId: string | null;
  lastErrorCode: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type StoredProviderConnection = ProviderConnectionSummary & Readonly<{
  credentialKind: "API_TOKEN" | null;
  encryptedCredential: EncryptedValue | null;
}>;

export class ProviderConnectionAccessError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ProviderConnectionAccessError";
  }
}

export interface ProviderAdapterResolver {
  get(providerId: ProviderId): ProviderAdapter | null;
}

export interface ProjectProviderRepository {
  projectRole(projectId: string, issuer: string, subject: string): Promise<WorkspaceRole | null>;
  selectProvider(input: {
    id: string;
    projectId: string;
    providerId: ProviderId;
    state: ProviderConnectionState;
    guidanceStepId: string | null;
  }): Promise<StoredProviderConnection>;
  setState(projectId: string, providerId: ProviderId, state: ProviderConnectionState, lastErrorCode?: string | null): Promise<StoredProviderConnection>;
  saveReady(input: {
    projectId: string;
    providerId: ProviderId;
    encryptedCredential: EncryptedValue;
    discovery: ProviderDiscovery;
  }): Promise<StoredProviderConnection>;
  getConnection(projectId: string, providerId: ProviderId): Promise<StoredProviderConnection | null>;
}

const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireOAuthActor(actor: OperationActor | undefined): OAuthOperationActor {
  if (!actor || actor.authenticationMethod !== "OAUTH") {
    throw new ProviderConnectionAccessError(403, "authenticated user identity is required");
  }
  return actor;
}

function requireProjectId(value: string): string {
  if (!projectIdPattern.test(value)) throw new ProviderConnectionAccessError(400, "projectId must be a UUID");
  return value;
}

function requireProvider(value: string): ProviderId {
  const provider = providerDefinition(value);
  if (!provider) throw new ProviderConnectionAccessError(400, "unsupported provider");
  return provider.id;
}

async function accessForActor(
  repository: ProjectProviderRepository,
  actor: OperationActor | undefined,
  projectId: string,
): Promise<{ principal: OAuthOperationActor; projectId: string; role: WorkspaceRole }> {
  const principal = requireOAuthActor(actor);
  const safeProjectId = requireProjectId(projectId);
  const role = await repository.projectRole(safeProjectId, principal.issuer, principal.subject);
  if (!role) throw new ProviderConnectionAccessError(404, "project is unavailable");
  return { principal, projectId: safeProjectId, role };
}

function requireManager(role: WorkspaceRole): void {
  if (!workspaceRoleCanManage(role)) throw new ProviderConnectionAccessError(403, "workspace role cannot change provider connection");
}

function publicSummary(connection: StoredProviderConnection): ProviderConnectionSummary {
  const {
    credentialKind: _credentialKind,
    encryptedCredential: _encryptedCredential,
    ...summary
  } = connection;
  return summary;
}

function initialState(providerId: ProviderId): { state: ProviderConnectionState; guidanceStepId: string | null } {
  const provider = providerDefinition(providerId)!;
  if (provider.adapterStatus === "AVAILABLE" && provider.connectionMethods.includes("API_TOKEN")) {
    return { state: "AUTH_REQUIRED", guidanceStepId: provider.guidance[0]?.id ?? null };
  }
  return {
    state: "NEEDS_USER_STEP",
    guidanceStepId: provider.guidance[0]?.id ?? null,
  };
}

export async function selectProviderForActor(
  repository: ProjectProviderRepository,
  actor: OperationActor | undefined,
  projectId: string,
  providerId: string,
): Promise<ProviderConnectionSummary> {
  const access = await accessForActor(repository, actor, projectId);
  requireManager(access.role);
  const provider = requireProvider(providerId);
  const initial = initialState(provider);
  const connection = await repository.selectProvider({
    id: randomUUID(),
    projectId: access.projectId,
    providerId: provider,
    state: initial.state,
    guidanceStepId: initial.guidanceStepId,
  });
  return publicSummary(connection);
}

function providerFailureState(error: ProviderAdapterError): ProviderConnectionState {
  switch (error.reason) {
    case "AUTH_FAILED":
      return "AUTH_FAILED";
    case "INSUFFICIENT_PERMISSION":
      return "INSUFFICIENT_PERMISSION";
    case "PROVIDER_UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "INVALID_RESPONSE":
      return "VERIFICATION_FAILED";
  }
}

async function discoverProvider(
  repository: ProjectProviderRepository,
  adapters: ProviderAdapterResolver,
  projectId: string,
  providerId: ProviderId,
  credential: string,
): Promise<ProviderDiscovery> {
  const adapter = adapters.get(providerId);
  if (!adapter) throw new ProviderConnectionAccessError(409, "provider adapter is not available yet");
  await repository.setState(projectId, providerId, "DISCOVERING", null);
  try {
    return await adapter.discover(credential);
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      const state = providerFailureState(error);
      await repository.setState(projectId, providerId, state, error.reason);
      throw new ProviderConnectionAccessError(
        error.reason === "AUTH_FAILED" || error.reason === "INSUFFICIENT_PERMISSION" ? 400 : 502,
        "provider discovery failed",
      );
    }
    await repository.setState(projectId, providerId, "PROVIDER_UNAVAILABLE", "PROVIDER_UNAVAILABLE");
    throw new ProviderConnectionAccessError(502, "provider discovery failed");
  }
}

export async function authenticateProviderForActor(
  repository: ProjectProviderRepository,
  adapters: ProviderAdapterResolver,
  masterKey: Buffer,
  actor: OperationActor | undefined,
  projectId: string,
  providerId: string,
  credential: string,
): Promise<ProviderConnectionSummary> {
  const access = await accessForActor(repository, actor, projectId);
  requireManager(access.role);
  const provider = requireProvider(providerId);
  const definition = providerDefinition(provider)!;
  if (definition.adapterStatus !== "AVAILABLE") {
    throw new ProviderConnectionAccessError(409, "provider adapter is not available yet");
  }
  const existing = await repository.getConnection(access.projectId, provider);
  if (!existing) throw new ProviderConnectionAccessError(409, "provider must be selected before authentication");

  const discovery = await discoverProvider(repository, adapters, access.projectId, provider, credential);
  if (discovery.providerId !== provider) {
    await repository.setState(access.projectId, provider, "VERIFICATION_FAILED", "PROVIDER_ID_MISMATCH");
    throw new ProviderConnectionAccessError(502, "provider discovery returned the wrong provider identity");
  }
  const encryptedCredential = encryptProviderCredential(credential, masterKey);
  const ready = await repository.saveReady({
    projectId: access.projectId,
    providerId: provider,
    encryptedCredential,
    discovery,
  });
  return publicSummary(ready);
}

export async function refreshProviderForActor(
  repository: ProjectProviderRepository,
  adapters: ProviderAdapterResolver,
  masterKey: Buffer,
  actor: OperationActor | undefined,
  projectId: string,
  providerId: string,
): Promise<ProviderConnectionSummary> {
  const access = await accessForActor(repository, actor, projectId);
  requireManager(access.role);
  const provider = requireProvider(providerId);
  const existing = await repository.getConnection(access.projectId, provider);
  if (!existing) throw new ProviderConnectionAccessError(404, "provider connection is unavailable");
  if (existing.credentialKind !== "API_TOKEN" || !existing.encryptedCredential) {
    throw new ProviderConnectionAccessError(409, "provider connection has no reusable credential");
  }

  let credential: string;
  try {
    credential = decryptProviderCredential(existing.encryptedCredential, masterKey);
  } catch {
    await repository.setState(access.projectId, provider, "VERIFICATION_FAILED", "CREDENTIAL_DECRYPT_FAILED");
    throw new ProviderConnectionAccessError(502, "provider credential cannot be verified");
  }
  const discovery = await discoverProvider(repository, adapters, access.projectId, provider, credential);
  const ready = await repository.saveReady({
    projectId: access.projectId,
    providerId: provider,
    encryptedCredential: existing.encryptedCredential,
    discovery,
  });
  return publicSummary(ready);
}

export async function getProviderConnectionForActor(
  repository: ProjectProviderRepository,
  actor: OperationActor | undefined,
  projectId: string,
  providerId: string,
): Promise<ProviderConnectionSummary | null> {
  const access = await accessForActor(repository, actor, projectId);
  const provider = requireProvider(providerId);
  const connection = await repository.getConnection(access.projectId, provider);
  return connection ? publicSummary(connection) : null;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function mapRow(row: Record<string, any>): StoredProviderConnection {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    providerId: String(row.provider_id) as ProviderId,
    state: String(row.state) as ProviderConnectionState,
    credentialKind: row.credential_kind === "API_TOKEN" ? "API_TOKEN" : null,
    encryptedCredential: row.credential_encrypted ? (asObject(row.credential_encrypted) as EncryptedValue) : null,
    accountContext: asObject(row.account_context) as ProviderConnectionSummary["accountContext"],
    discovery: asObject(row.discovery) as ProviderConnectionSummary["discovery"],
    selectedComputeId: row.selected_compute_id ? String(row.selected_compute_id) : null,
    guidanceStepId: row.guidance_step_id ? String(row.guidance_step_id) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresProjectProviderRepository implements ProjectProviderRepository {
  constructor(private readonly pool: Pool) {}

  async projectRole(projectId: string, issuer: string, subject: string): Promise<WorkspaceRole | null> {
    const result = await this.pool.query(
      `SELECT m.role
         FROM projects p
         JOIN workspace_memberships m ON m.workspace_id=p.workspace_id
        WHERE p.id=$1 AND m.issuer=$2 AND m.subject=$3`,
      [projectId, issuer, subject],
    );
    return result.rowCount === 1 ? (result.rows[0].role as WorkspaceRole) : null;
  }

  async selectProvider(input: {
    id: string;
    projectId: string;
    providerId: ProviderId;
    state: ProviderConnectionState;
    guidanceStepId: string | null;
  }): Promise<StoredProviderConnection> {
    const result = await this.pool.query(
      `INSERT INTO project_provider_connections(
         id,project_id,provider_id,state,guidance_step_id,credential_kind,credential_encrypted,
         account_context,discovery,selected_compute_id,last_error_code,last_verified_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,NULL,NULL,'{}'::jsonb,'{}'::jsonb,NULL,NULL,NULL,now())
       ON CONFLICT(project_id,provider_id) DO UPDATE SET
         state=EXCLUDED.state,
         guidance_step_id=EXCLUDED.guidance_step_id,
         credential_kind=NULL,
         credential_encrypted=NULL,
         account_context='{}'::jsonb,
         discovery='{}'::jsonb,
         selected_compute_id=NULL,
         last_error_code=NULL,
         last_verified_at=NULL,
         updated_at=now()
       RETURNING *`,
      [input.id, input.projectId, input.providerId, input.state, input.guidanceStepId],
    );
    if (result.rowCount !== 1) throw new Error("provider selection did not return a row");
    return mapRow(result.rows[0]);
  }

  async setState(
    projectId: string,
    providerId: ProviderId,
    state: ProviderConnectionState,
    lastErrorCode: string | null = null,
  ): Promise<StoredProviderConnection> {
    const result = await this.pool.query(
      `UPDATE project_provider_connections
          SET state=$3,last_error_code=$4,updated_at=now()
        WHERE project_id=$1 AND provider_id=$2
        RETURNING *`,
      [projectId, providerId, state, lastErrorCode],
    );
    if (result.rowCount !== 1) throw new Error("provider connection state target is missing");
    return mapRow(result.rows[0]);
  }

  async saveReady(input: {
    projectId: string;
    providerId: ProviderId;
    encryptedCredential: EncryptedValue;
    discovery: ProviderDiscovery;
  }): Promise<StoredProviderConnection> {
    const discoveryPayload = {
      compute: input.discovery.compute,
      networks: input.discovery.networks,
      firewalls: input.discovery.firewalls,
    };
    const result = await this.pool.query(
      `UPDATE project_provider_connections
          SET state='READY',
              credential_kind='API_TOKEN',
              credential_encrypted=$3::jsonb,
              account_context=$4::jsonb,
              discovery=$5::jsonb,
              last_error_code=NULL,
              last_verified_at=now(),
              updated_at=now()
        WHERE project_id=$1 AND provider_id=$2
        RETURNING *`,
      [
        input.projectId,
        input.providerId,
        JSON.stringify(input.encryptedCredential),
        JSON.stringify(input.discovery.accountContext),
        JSON.stringify(discoveryPayload),
      ],
    );
    if (result.rowCount !== 1) throw new Error("provider connection target is missing");
    return mapRow(result.rows[0]);
  }

  async getConnection(projectId: string, providerId: ProviderId): Promise<StoredProviderConnection | null> {
    const result = await this.pool.query(
      "SELECT * FROM project_provider_connections WHERE project_id=$1 AND provider_id=$2",
      [projectId, providerId],
    );
    return result.rowCount === 1 ? mapRow(result.rows[0]) : null;
  }
}

export class StaticProviderAdapterResolver implements ProviderAdapterResolver {
  private readonly adapters: ReadonlyMap<ProviderId, ProviderAdapter>;

  constructor(adapters: readonly ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.providerId, adapter] as const));
  }

  get(providerId: ProviderId): ProviderAdapter | null {
    return this.adapters.get(providerId) ?? null;
  }
}
