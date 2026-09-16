import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const internalLegacyWorkspaceId = "00000000-0000-4000-8000-000000000001";
const slugPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: string, label: string): string {
  if (!uuidPattern.test(value)) throw new Error(`${label} must be a UUID`);
  return value.toLowerCase();
}

export function normalizeProjectSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slugPattern.test(slug)) throw new Error("slug must contain 3-64 lowercase letters, numbers or hyphens");
  return slug;
}

export function normalizeProjectName(value: string, max = 120): string {
  const name = value.trim();
  if (!name || name.length > max || /[\r\n\u0000]/.test(name)) {
    throw new Error(`name must contain 1-${max} safe characters`);
  }
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

function includeArchived(value: unknown): boolean {
  return value === "1" || value === "true";
}

function projectView(row: Record<string, any>) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serviceView(row: Record<string, any>) {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerProjectServiceAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireControl: ControlPreHandler,
): void {
  app.get("/v0/workspaces", { preHandler: requireControl }, async () => {
    const result = await pool.query(
      `SELECT id,slug,name,created_at,updated_at
         FROM workspaces
        WHERE id<>$1
        ORDER BY created_at ASC,id ASC`,
      [internalLegacyWorkspaceId],
    );
    return {
      workspaces: result.rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  });

  app.post<{ Body: { slug?: string; name?: string } }>(
    "/v0/workspaces",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const slug = normalizeProjectSlug(request.body?.slug ?? "");
        const name = normalizeProjectName(request.body?.name ?? "");
        const id = randomUUID();
        const result = await pool.query(
          `INSERT INTO workspaces(id,slug,name)
           VALUES($1,$2,$3)
           RETURNING id,slug,name,created_at,updated_at`,
          [id, slug, name],
        );
        const row = result.rows[0];
        return reply.code(201).send({ id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at });
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ error: "workspace slug is already in use" });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "workspace could not be created" });
      }
    },
  );

  app.get<{ Params: { workspaceId: string }; Querystring: { includeArchived?: string } }>(
    "/v0/workspaces/:workspaceId/projects",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const workspaceId = requireUuid(request.params.workspaceId, "workspaceId");
        const result = await pool.query(
          `SELECT id,workspace_id,slug,name,status,archived_at,created_at,updated_at
             FROM projects
            WHERE workspace_id=$1 AND ($2::boolean OR status='ACTIVE')
            ORDER BY created_at ASC,id ASC`,
          [workspaceId, includeArchived(request.query?.includeArchived)],
        );
        return { projects: result.rows.map(projectView) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "projects could not be listed" });
      }
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: { slug?: string; name?: string } }>(
    "/v0/workspaces/:workspaceId/projects",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const workspaceId = requireUuid(request.params.workspaceId, "workspaceId");
        if (workspaceId === internalLegacyWorkspaceId) return reply.code(404).send({ error: "workspace is unavailable" });
        const slug = normalizeProjectSlug(request.body?.slug ?? "");
        const name = normalizeProjectName(request.body?.name ?? "");
        const id = randomUUID();
        const result = await pool.query(
          `INSERT INTO projects(id,workspace_id,slug,name)
           SELECT $1,$2,$3,$4
            WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=$2 AND id<>$5)
           RETURNING id,workspace_id,slug,name,status,archived_at,created_at,updated_at`,
          [id, workspaceId, slug, name, internalLegacyWorkspaceId],
        );
        if (result.rowCount !== 1) return reply.code(404).send({ error: "workspace is unavailable" });
        return reply.code(201).send(projectView(result.rows[0]));
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ error: "project slug is already in use in this workspace" });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "project could not be created" });
      }
    },
  );

  app.patch<{ Params: { projectId: string }; Body: { slug?: string; name?: string } }>(
    "/v0/projects/:projectId",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireUuid(request.params.projectId, "projectId");
        const hasSlug = typeof request.body?.slug === "string";
        const hasName = typeof request.body?.name === "string";
        if (!hasSlug && !hasName) return reply.code(400).send({ error: "slug or name is required" });
        const slug = hasSlug ? normalizeProjectSlug(request.body!.slug!) : null;
        const name = hasName ? normalizeProjectName(request.body!.name!) : null;
        const result = await pool.query(
          `UPDATE projects p
              SET slug=COALESCE($2,p.slug),name=COALESCE($3,p.name),updated_at=now()
            WHERE p.id=$1 AND p.status='ACTIVE'
              AND p.workspace_id<>$4
          RETURNING id,workspace_id,slug,name,status,archived_at,created_at,updated_at`,
          [projectId, slug, name, internalLegacyWorkspaceId],
        );
        if (result.rowCount !== 1) return reply.code(404).send({ error: "active project is unavailable" });
        return projectView(result.rows[0]);
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ error: "project slug is already in use in this workspace" });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "project could not be updated" });
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/v0/projects/:projectId/archive",
    { preHandler: requireControl },
    async (request, reply) => {
      const client = await pool.connect();
      try {
        const projectId = requireUuid(request.params.projectId, "projectId");
        await client.query("BEGIN");
        const project = await client.query(
          `SELECT p.id,p.workspace_id,p.slug,p.name,p.status,p.archived_at,p.created_at,p.updated_at
             FROM projects p
            WHERE p.id=$1 AND p.workspace_id<>$2
            FOR UPDATE`,
          [projectId, internalLegacyWorkspaceId],
        );
        if (project.rowCount !== 1) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "project is unavailable" });
        }
        if (project.rows[0].status === "ACTIVE") {
          await client.query(
            `UPDATE services
                SET status='ARCHIVED',archived_at=now(),updated_at=now()
              WHERE project_id=$1 AND status='ACTIVE'`,
            [projectId],
          );
          const updated = await client.query(
            `UPDATE projects
                SET status='ARCHIVED',archived_at=now(),updated_at=now()
              WHERE id=$1
          RETURNING id,workspace_id,slug,name,status,archived_at,created_at,updated_at`,
            [projectId],
          );
          project.rows[0] = updated.rows[0];
        }
        await client.query("COMMIT");
        return projectView(project.rows[0]);
      } catch (error) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: error instanceof Error ? error.message : "project could not be archived" });
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { includeArchived?: string } }>(
    "/v0/projects/:projectId/services",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireUuid(request.params.projectId, "projectId");
        const result = await pool.query(
          `SELECT s.id,s.project_id,s.slug,s.name,s.status,s.archived_at,s.created_at,s.updated_at
             FROM services s
             JOIN projects p ON p.id=s.project_id
            WHERE s.project_id=$1 AND p.workspace_id<>$2 AND ($3::boolean OR s.status='ACTIVE')
            ORDER BY s.created_at ASC,s.id ASC`,
          [projectId, internalLegacyWorkspaceId, includeArchived(request.query?.includeArchived)],
        );
        return { services: result.rows.map(serviceView) };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "services could not be listed" });
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: { slug?: string; name?: string } }>(
    "/v0/projects/:projectId/services",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const projectId = requireUuid(request.params.projectId, "projectId");
        const slug = normalizeProjectSlug(request.body?.slug ?? "");
        const name = normalizeProjectName(request.body?.name ?? "", 80);
        const id = randomUUID();
        const result = await pool.query(
          `INSERT INTO services(id,project_id,slug,name)
           SELECT $1,p.id,$2,$3
             FROM projects p
            WHERE p.id=$4 AND p.status='ACTIVE' AND p.workspace_id<>$5
           RETURNING id,project_id,slug,name,status,archived_at,created_at,updated_at`,
          [id, slug, name, projectId, internalLegacyWorkspaceId],
        );
        if (result.rowCount !== 1) return reply.code(404).send({ error: "active project is unavailable" });
        return reply.code(201).send(serviceView(result.rows[0]));
      } catch (error) {
        if (isUniqueViolation(error)) return reply.code(409).send({ error: "service slug or name is already in use in this project" });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "service could not be created" });
      }
    },
  );

  app.post<{ Params: { serviceId: string } }>(
    "/v0/services/:serviceId/archive",
    { preHandler: requireControl },
    async (request, reply) => {
      try {
        const serviceId = requireUuid(request.params.serviceId, "serviceId");
        const result = await pool.query(
          `UPDATE services s
              SET status='ARCHIVED',archived_at=COALESCE(s.archived_at,now()),updated_at=now()
             FROM projects p
            WHERE s.id=$1 AND p.id=s.project_id AND p.workspace_id<>$2
          RETURNING s.id,s.project_id,s.slug,s.name,s.status,s.archived_at,s.created_at,s.updated_at`,
          [serviceId, internalLegacyWorkspaceId],
        );
        if (result.rowCount !== 1) return reply.code(404).send({ error: "service is unavailable" });
        return serviceView(result.rows[0]);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "service could not be archived" });
      }
    },
  );
}
