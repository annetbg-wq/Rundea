# ADR 0001: Control Plane, Node Agent and Runtime boundaries

Status: Accepted

## Decision

Rundea separates three trust and responsibility domains:

- **Control Plane**: identity, projects, services, desired deployment state, node registry, GitHub integration, domains, secret metadata, deployment history and API/UI.
- **Node Agent**: privileged executor installed on one Linux host. It reconciles explicit commands with Docker and reports observed state/logs.
- **Runtime**: user application containers. User workloads are untrusted relative to the agent and control plane.

PostgreSQL in the control plane is the source of truth for durable platform state. Agent memory and Docker labels are observed/runtime state, never the only copy of deployment history.

## Why Go for the agent

The agent should be distributed as a small standalone binary with predictable startup, low idle overhead, easy systemd integration and direct process/Docker control. TypeScript remains the default for the web/control plane where iteration speed and shared product types matter more.

## v0 execution model

The initial implementation uses the Docker CLI and Git CLI deliberately. Their invocations are explicit and observable. Replacing them with Docker Engine API or a source-fetch service later must preserve the command/event contract.

## Non-goals

No Kubernetes, hypervisor, autoscaler or multi-cloud scheduler is introduced in v0.
