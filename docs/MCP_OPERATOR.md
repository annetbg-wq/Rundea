# Rundea operator MCP

Rundea exposes MCP at `/mcp`.

## Authentication modes

Two mutually exclusive modes exist:

- OAuth: diagnostic read-only MCP. OAuth identities remain constrained by resource grants.
- Static token: operator MCP. It uses a dedicated `RUNDEA_MCP_TOKEN` that must be different from `RUNDEA_CONTROL_TOKEN`.

The static token is intentionally the only mode that exposes infrastructure-changing tools. The MCP client never receives the Control Plane token. Write tools proxy canonical `/v0/*` operations over loopback, so existing validation, node placement, deployment, secret handling and ingress reconciliation stay authoritative.

Required live environment values:

```env
RUNDEA_MCP_TOKEN=<random 32-512 character secret distinct from RUNDEA_CONTROL_TOKEN>
RUNDEA_MCP_ALLOWED_HOSTS=rundea.bachopus.com
RUNDEA_MCP_ALLOWED_ORIGINS=rundea.bachopus.com
```

Restart the API after changing these values.

## Operator tool surface

Read:
- `rundea_workspaces_list`
- `rundea_projects_list`
- `rundea_services_list`
- `rundea_nodes_list`
- `rundea_service_variables_read`
- `rundea_service_deployments_list`
- `rundea_deployment_events_read`
- `rundea_service_domains_list`
- existing deployment metrics and node qualification diagnostics

Write:
- `rundea_workspace_create`
- `rundea_project_create`
- `rundea_service_create`
- `rundea_service_variables_upsert`
- `rundea_service_deploy`
- `rundea_service_domain_attach`

The first operator surface deliberately omits delete/archive, node maintenance, restart and rollback. Those actions should be added only through the operation approval layer because they can disrupt or remove a working runtime.

## Sendina dogfood sequence

1. Create workspace.
2. Create Sendina project.
3. Create Sendina service.
4. Confirm an ONLINE node.
5. Set required non-platform variables and secrets.
6. Deploy the exact Sendina commit using brokered source delivery.
7. Follow deployment events until READY.
8. Attach a hostname only after READY and only when DNS already resolves to the selected node.
