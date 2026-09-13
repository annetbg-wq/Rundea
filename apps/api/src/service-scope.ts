import type { Pool } from "pg";

export const internalLegacyWorkspaceId = "00000000-0000-4000-8000-000000000001";
export const internalLegacyProjectId = "00000000-0000-4000-8000-000000000002";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const serviceNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export type ServiceScope = Readonly<{
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  slug: string;
  runtimeKey: string;
}>;

export class ServiceScopeError extends Error {
  constructor(
    public readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ServiceScopeError";
  }
}

export function isServiceId(value: string): boolean {
  return uuidPattern.test(value.trim());
}

export function requireLegacyServiceName(value: string): string {
  const name = value.trim();
  if (!serviceNamePattern.test(name)) throw new ServiceScopeError(400, "invalid service name");
  return name;
}

export function runtimeServiceKey(name: string, serviceId: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "service";
  const suffix = serviceId.replace(/-/g, "").slice(0, 10).toLowerCase();
  return `${cleaned}-${suffix}`;
}

export async function resolveActiveCanonicalService(pool: Pool, rawServiceId: string): Promise<ServiceScope> {
  const serviceId = rawServiceId.trim().toLowerCase();
  if (!isServiceId(serviceId)) throw new ServiceScopeError(400, "serviceId must be a UUID");

  const result = await pool.query(
    `SELECT s.id,s.project_id,p.workspace_id,s.slug,s.name
       FROM services s
       JOIN projects p ON p.id=s.project_id
      WHERE s.id=$1
        AND s.status='ACTIVE'
        AND p.status='ACTIVE'
        AND p.id<>$2
        AND p.workspace_id<>$3`,
    [serviceId, internalLegacyProjectId, internalLegacyWorkspaceId],
  );
  if (result.rowCount !== 1) throw new ServiceScopeError(404, "active service is unavailable");
  const row = result.rows[0];
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id),
    slug: String(row.slug),
    name: String(row.name),
    runtimeKey: runtimeServiceKey(String(row.name), String(row.id)),
  };
}
