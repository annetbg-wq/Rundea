import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const maxToolResponseBytes = 512 * 1024;
const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
const safeName = z.string().min(1).max(120).refine((value) => !/[\r\n\u0000]/.test(value), "unsafe name");
const variableKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export type McpControlHttpDependencies = Readonly<{
  controlToken: string;
  port?: number;
  fetchImpl?: typeof fetch;
}>;

function boundedResult(value: unknown, isError = false) {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = JSON.stringify({ error: "control plane result could not be serialized" });
    isError = true;
  }
  if (Buffer.byteLength(text, "utf8") > maxToolResponseBytes) {
    text = JSON.stringify({ error: "control plane result exceeded MCP response limit" });
    isError = true;
  }
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text),
  };
}

async function request(
  dependencies: McpControlHttpDependencies,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const port = dependencies.port ?? Number(process.env.PORT ?? "4000");
  const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
    method,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${dependencies.controlToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: "control plane returned a non-JSON response" };
    }
  }
  return boundedResult(
    response.ok ? payload : { ok: false, status: response.status, ...(payload && typeof payload === "object" ? payload as Record<string, unknown> : { error: "control plane request failed" }) },
    !response.ok,
  );
}

export function registerStaticControlMcpTools(server: McpServer, dependencies: McpControlHttpDependencies): void {
  server.registerTool(
    "rundea_workspaces_list",
    {
      title: "List Rundea workspaces",
      description: "List canonical Rundea workspaces available to the operator.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => request(dependencies, "GET", "/v0/workspaces"),
  );

  server.registerTool(
    "rundea_workspace_create",
    {
      title: "Create Rundea workspace",
      description: "Create a canonical Rundea workspace.",
      inputSchema: z.strictObject({ slug, name: safeName }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => request(dependencies, "POST", "/v0/workspaces", input),
  );

  server.registerTool(
    "rundea_projects_list",
    {
      title: "List Rundea projects",
      description: "List active projects in one Rundea workspace.",
      inputSchema: z.strictObject({ workspaceId: uuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ workspaceId }) => request(dependencies, "GET", `/v0/workspaces/${encodeURIComponent(workspaceId)}/projects`),
  );

  server.registerTool(
    "rundea_project_create",
    {
      title: "Create Rundea project",
      description: "Create a canonical project in one Rundea workspace.",
      inputSchema: z.strictObject({ workspaceId: uuid, slug, name: safeName }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ workspaceId, slug, name }) => request(
      dependencies,
      "POST",
      `/v0/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      { slug, name },
    ),
  );

  server.registerTool(
    "rundea_services_list",
    {
      title: "List Rundea services",
      description: "List active services in one canonical Rundea project.",
      inputSchema: z.strictObject({ projectId: uuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projectId }) => request(dependencies, "GET", `/v0/projects/${encodeURIComponent(projectId)}/services`),
  );

  server.registerTool(
    "rundea_service_create",
    {
      title: "Create Rundea service",
      description: "Create a canonical service in one active Rundea project.",
      inputSchema: z.strictObject({ projectId: uuid, slug, name: safeName.max(80) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, slug, name }) => request(
      dependencies,
      "POST",
      `/v0/projects/${encodeURIComponent(projectId)}/services`,
      { slug, name },
    ),
  );

  server.registerTool(
    "rundea_nodes_list",
    {
      title: "List Rundea nodes",
      description: "List Rundea nodes and their live Agent compatibility state.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => request(dependencies, "GET", "/v0/nodes"),
  );

  server.registerTool(
    "rundea_service_variables_read",
    {
      title: "Read service variables",
      description: "List variable names and non-secret values for one canonical service. Secret values are never returned.",
      inputSchema: z.strictObject({ serviceId: uuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ serviceId }) => request(
      dependencies,
      "GET",
      `/v0/services/${encodeURIComponent(serviceId)}/config/variables`,
    ),
  );

  server.registerTool(
    "rundea_service_variables_upsert",
    {
      title: "Set service variables",
      description: "Create or replace environment variables for one canonical service. Secret values are accepted but never returned.",
      inputSchema: z.strictObject({
        serviceId: uuid,
        variables: z.array(z.strictObject({
          key: variableKey,
          value: z.string().max(65536),
          secret: z.boolean().optional(),
        })).max(256),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ serviceId, variables }) => request(
      dependencies,
      "PUT",
      `/v0/services/${encodeURIComponent(serviceId)}/config/variables`,
      { variables },
    ),
  );

  server.registerTool(
    "rundea_service_deployments_list",
    {
      title: "List service deployments",
      description: "List recent deployments for one canonical service.",
      inputSchema: z.strictObject({ serviceId: uuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ serviceId }) => request(
      dependencies,
      "GET",
      `/v0/services/${encodeURIComponent(serviceId)}/deployments`,
    ),
  );

  server.registerTool(
    "rundea_service_deploy",
    {
      title: "Deploy service",
      description: "Create a deployment for one canonical service on an ONLINE node. Rundea allocates the host port.",
      inputSchema: z.strictObject({
        serviceId: uuid,
        nodeId: uuid.optional(),
        sourceRepository: z.string().url().max(500),
        sourceRef: z.string().min(1).max(160),
        sourceDelivery: z.enum(["DIRECT", "BROKER"]).optional(),
        dockerfile: z.string().min(1).max(300).optional(),
        buildArgs: z.record(z.string(), z.string()).optional(),
        containerPort: z.number().int().min(1).max(65535),
        healthcheckPath: z.string().max(512).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ serviceId, ...body }) => request(
      dependencies,
      "POST",
      `/v0/services/${encodeURIComponent(serviceId)}/deployments`,
      body,
    ),
  );

  server.registerTool(
    "rundea_deployment_events_read",
    {
      title: "Read deployment events",
      description: "Read bounded status and log events for one Rundea deployment.",
      inputSchema: z.strictObject({ deploymentId: uuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ deploymentId }) => request(
      dependencies,
      "GET",
      `/v0/deployments/${encodeURIComponent(deploymentId)}/events`,
    ),
  );

  server.registerTool(
    "rundea_service_domains_list",
    {
      title: "List service domains",
      description: "List public domains attached to one canonical service.",
      inputSchema: z.strictObject({ serviceId: uuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ serviceId }) => request(
      dependencies,
      "GET",
      `/v0/services/${encodeURIComponent(serviceId)}/domains`,
    ),
  );

  server.registerTool(
    "rundea_service_domain_attach",
    {
      title: "Attach service domain",
      description: "Attach a public hostname to a service that already has a READY deployment.",
      inputSchema: z.strictObject({
        serviceId: uuid,
        hostname: z.string().min(3).max(253),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ serviceId, hostname }) => request(
      dependencies,
      "POST",
      `/v0/services/${encodeURIComponent(serviceId)}/domains`,
      { hostname },
    ),
  );
}
