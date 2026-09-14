import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { normalizeProjectName, normalizeProjectSlug } from "./project-service-admin";

type StoredCandidate = {
  name?: unknown;
  path?: unknown;
  dockerfile?: unknown;
  containerPorts?: unknown;
  buildArgumentNames?: unknown;
  environmentVariableNames?: unknown;
  healthcheckPath?: unknown;
};

export type DiscoverySelection = {
  path: string;
  name?: string;
  slug?: string;
  containerPort?: number;
  healthcheckPath?: string;
};

export type ConfirmedService = {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  sourcePath: string;
  dockerfile: string | null;
  containerPort: number;
  healthcheckPath: string;
  buildVariableNames: string[];
  runtimeVariableNames: string[];
  repositoryFullName: string;
  selectedBranch: string;
  revisionSha: string;
  reused: boolean;
};

export class DiscoveryConfirmationError extends Error {
  constructor(public readonly statusCode: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "DiscoveryConfirmationError";
  }
}

const pathPattern = /^(?:\.|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shaPattern = /^[0-9a-f]{40}$/;

function safePath(value: unknown): string {
  if (typeof value !== "string") throw new DiscoveryConfirmationError(400, "discovered service path is invalid");
  const path = value.trim();
  if (!path || path.length > 600 || !pathPattern.test(path) || path.split("/").includes("..")) {
    throw new DiscoveryConfirmationError(400, "discovered service path is invalid");
  }
  return path;
}

function defaultSlug(name: string): string {
  let slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (slug.length < 3) slug = `${slug || "app"}-svc`.slice(0, 64);
  return normalizeProjectSlug(slug);
}

function healthPath(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new DiscoveryConfirmationError(400, "healthcheckPath is invalid");
  const path = value.trim();
  if (!path.startsWith("/") || path.length > 512 || /[\r\n\u0000]/.test(path)) {
    throw new DiscoveryConfirmationError(400, "healthcheckPath must be blank or an absolute path up to 512 characters");
  }
  return path;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && envNamePattern.test(item)))].sort();
}

function candidatePort(candidate: StoredCandidate, override: number | undefined): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1 || override > 65535) {
      throw new DiscoveryConfirmationError(400, "containerPort must be an integer between 1 and 65535");
    }
    return override;
  }
  const ports = Array.isArray(candidate.containerPorts)
    ? candidate.containerPorts.filter((port): port is number => Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65535)
    : [];
  if (ports.length !== 1) throw new DiscoveryConfirmationError(409, "service needs one confirmed container port before import");
  return ports[0]!;
}

function candidateDockerfile(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const path = safePath(value);
  return path === "." ? null : path;
}

export function normalizeDiscoverySelections(input: unknown): DiscoverySelection[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw new DiscoveryConfirmationError(400, "services must contain 1-20 discovery selections");
  }
  const seen = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== "object") throw new DiscoveryConfirmationError(400, "service selection is invalid");
    const value = raw as Record<string, unknown>;
    const path = safePath(value.path);
    if (seen.has(path)) throw new DiscoveryConfirmationError(400, `duplicate discovery selection: ${path}`);
    seen.add(path);
    const name = value.name === undefined ? undefined : normalizeProjectName(String(value.name), 80);
    const slug = value.slug === undefined ? undefined : normalizeProjectSlug(String(value.slug));
    const containerPort = value.containerPort === undefined ? undefined : Number(value.containerPort);
    const healthcheckPath = value.healthcheckPath === undefined ? undefined : healthPath(value.healthcheckPath);
    return { path, name, slug, containerPort, healthcheckPath };
  });
}

function discoveryCandidates(discovery: unknown): StoredCandidate[] {
  if (!discovery || typeof discovery !== "object") return [];
  const services = (discovery as Record<string, unknown>).services;
  return Array.isArray(services) ? services.filter((item): item is StoredCandidate => Boolean(item && typeof item === "object")) : [];
}

async function existingService(client: PoolClient, projectId: string, slug: string) {
  return await client.query(
    `SELECT s.id,s.name,s.slug,s.status,c.source_path
       FROM services s
       LEFT JOIN service_source_configs c ON c.service_id=s.id
      WHERE s.project_id=$1 AND s.slug=$2
      FOR UPDATE OF s`,
    [projectId, slug],
  );
}

export async function confirmDiscoveredServices(
  pool: Pool,
  projectId: string,
  rawSelections: unknown,
): Promise<ConfirmedService[]> {
  const selections = normalizeDiscoverySelections(rawSelections);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceResult = await client.query(
      `SELECT repository_full_name,selected_branch,revision_sha,discovery
         FROM project_sources
        WHERE project_id=$1 AND provider='GITHUB'
        FOR UPDATE`,
      [projectId],
    );
    if (sourceResult.rowCount !== 1) throw new DiscoveryConfirmationError(404, "project has no connected GitHub source");
    const source = sourceResult.rows[0];
    const revisionSha = String(source.revision_sha);
    if (!shaPattern.test(revisionSha)) throw new DiscoveryConfirmationError(409, "connected source has no immutable revision");
    const candidates = discoveryCandidates(source.discovery);
    if (!candidates.length) throw new DiscoveryConfirmationError(409, "connected source has no concrete discovered services");

    const confirmed: ConfirmedService[] = [];
    for (const selection of selections) {
      const candidate = candidates.find((item) => item.path === selection.path);
      if (!candidate) throw new DiscoveryConfirmationError(409, `selected service is not in current discovery: ${selection.path}`);
      const inferredName = typeof candidate.name === "string" ? candidate.name : selection.path.split("/").pop() || "service";
      const name = selection.name ?? normalizeProjectName(inferredName, 80);
      const slug = selection.slug ?? defaultSlug(name);
      const containerPort = candidatePort(candidate, selection.containerPort);
      const dockerfile = candidateDockerfile(candidate.dockerfile);
      const resolvedHealthPath = selection.healthcheckPath ?? healthPath(candidate.healthcheckPath);
      const buildVariableNames = names(candidate.buildArgumentNames);
      const runtimeVariableNames = names(candidate.environmentVariableNames);

      const existing = await existingService(client, projectId, slug);
      let serviceId: string;
      let reused = false;
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (row.status !== "ACTIVE") throw new DiscoveryConfirmationError(409, `service slug ${slug} belongs to an archived service`);
        if (row.source_path && row.source_path !== selection.path) {
          throw new DiscoveryConfirmationError(409, `service slug ${slug} is already bound to another source path`);
        }
        if (!row.source_path) throw new DiscoveryConfirmationError(409, `service slug ${slug} already exists and was not created from this discovery`);
        serviceId = String(row.id);
        reused = true;
      } else {
        serviceId = randomUUID();
        await client.query(
          `INSERT INTO services(id,project_id,slug,name)
           VALUES($1,$2,$3,$4)`,
          [serviceId, projectId, slug, name],
        );
      }

      await client.query(
        `INSERT INTO service_source_configs(
           service_id,project_id,repository_full_name,selected_branch,revision_sha,source_path,dockerfile,
           container_port,healthcheck_path,build_variable_names,runtime_variable_names,confirmed_at,updated_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,now(),now())
         ON CONFLICT(service_id) DO UPDATE SET
           repository_full_name=EXCLUDED.repository_full_name,
           selected_branch=EXCLUDED.selected_branch,
           revision_sha=EXCLUDED.revision_sha,
           source_path=EXCLUDED.source_path,
           dockerfile=EXCLUDED.dockerfile,
           container_port=EXCLUDED.container_port,
           healthcheck_path=EXCLUDED.healthcheck_path,
           build_variable_names=EXCLUDED.build_variable_names,
           runtime_variable_names=EXCLUDED.runtime_variable_names,
           confirmed_at=now(),updated_at=now()`,
        [
          serviceId,
          projectId,
          String(source.repository_full_name),
          String(source.selected_branch),
          revisionSha,
          selection.path,
          dockerfile,
          containerPort,
          resolvedHealthPath,
          JSON.stringify(buildVariableNames),
          JSON.stringify(runtimeVariableNames),
        ],
      );
      confirmed.push({
        id: serviceId,
        projectId,
        name,
        slug,
        sourcePath: selection.path,
        dockerfile,
        containerPort,
        healthcheckPath: resolvedHealthPath,
        buildVariableNames,
        runtimeVariableNames,
        repositoryFullName: String(source.repository_full_name),
        selectedBranch: String(source.selected_branch),
        revisionSha,
        reused,
      });
    }
    await client.query("COMMIT");
    return confirmed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getConfirmedServiceSource(pool: Pool, serviceId: string) {
  const result = await pool.query(
    `SELECT c.service_id,c.project_id,c.repository_full_name,c.selected_branch,c.revision_sha,c.source_path,c.dockerfile,
            c.container_port,c.healthcheck_path,c.build_variable_names,c.runtime_variable_names,c.confirmed_at,c.updated_at
       FROM service_source_configs c
       JOIN services s ON s.id=c.service_id AND s.project_id=c.project_id
       JOIN projects p ON p.id=s.project_id
      WHERE c.service_id=$1 AND s.status='ACTIVE' AND p.status='ACTIVE'`,
    [serviceId],
  );
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  return {
    serviceId: String(row.service_id),
    projectId: String(row.project_id),
    repositoryFullName: String(row.repository_full_name),
    selectedBranch: String(row.selected_branch),
    revisionSha: String(row.revision_sha),
    sourcePath: String(row.source_path),
    dockerfile: row.dockerfile ? String(row.dockerfile) : null,
    containerPort: Number(row.container_port),
    healthcheckPath: String(row.healthcheck_path ?? ""),
    buildVariableNames: names(row.build_variable_names),
    runtimeVariableNames: names(row.runtime_variable_names),
    confirmedAt: new Date(row.confirmed_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
