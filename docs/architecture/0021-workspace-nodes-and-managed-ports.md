# ADR 0021 — Workspace-owned nodes and managed host ports

Status: accepted for RUNDEA DOGFOOD GATE v1 Foundation.

## Decision

A deployable Rundea node belongs to exactly one workspace. Canonical services may run only on ACTIVE, ONLINE nodes from the same workspace. Prototype-era nodes are retained in a hidden internal legacy workspace and are not selectable by canonical product flows.

Canonical deployment requests do not contain a host port. Rundea allocates a stable service/node port from the managed range `18000-29999`. Allocation is serialized per node in PostgreSQL and `(node_id, host_port)` is unique, so concurrent Rundea requests cannot reserve the same port.

The user may omit `nodeId`; Rundea then chooses an ACTIVE, ONLINE node in the service workspace, preferring the most recently seen node. If a node is selected explicitly it must pass the same workspace/lifecycle/online checks.

## Node lifecycle

Workspace node listings expose connectivity and compatibility evidence: last seen, Agent semantic version, immutable build SHA, declared capabilities, compatibility error and connected-at timestamp.

Archiving is allowed only for an ACTIVE, OFFLINE, non-legacy node with no READY deployment and no non-deleting domain. Archive revokes the stored node credential. An ONLINE node cannot be archived as a shortcut for stopping runtime work.

## Compatibility

Legacy flat node/deployment endpoints remain temporarily for the existing acceptance surface. Inserts that omit workspace identity default into the hidden legacy workspace. This compatibility path is not a canonical product API and will be removed with the old Web surface.

## Acceptance

The node E2E must prove with a real Agent and Docker runtime that:

- a workspace-owned Agent becomes ONLINE;
- a node from another workspace is rejected;
- canonical deployment succeeds without `nodeId` and without `hostPort`;
- Rundea selects the correct workspace node;
- the allocated port is inside the managed range and does not collide with another Rundea route;
- live HTTP traffic reaches the deployed revision through that managed port.

## Remaining hardening

Database allocation prevents collisions between Rundea-managed services. A later Runtime slice must also make the Agent detect unexpected host-level listeners in the managed range (processes created outside Rundea) and surface a node capability/readiness error instead of treating a bind failure as an opaque deployment failure.
