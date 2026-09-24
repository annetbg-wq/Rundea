# ADR 0024: Brokered registry pull credentials

## Status

Accepted for the registry-first production path.

## Context

Registry-first deployment removes Docker build load from production nodes, but private OCI registries still require pull authentication.

Persisting a long-lived registry password or PAT in `~/.docker/config.json` on every production node would create an unnecessary standing credential. It would also widen the blast radius of a node compromise.

## Decision

Rundea keeps the configured registry pull credential at the Control Plane boundary.

When an immutable prebuilt deployment is about to be dispatched:

1. Control Plane validates that the artifact host matches the host derived from `RUNDEA_BUILD_REGISTRY_PREFIX`;
2. Control Plane creates a cryptographically opaque ticket bound to the exact deployment and node;
3. only the ticket is included in the Agent deploy command;
4. the ticket expires after two minutes and can be consumed once;
5. the Agent exchanges it over the Control Plane connection for the registry username/password;
6. the Agent creates a temporary `DOCKER_CONFIG`, performs `docker login`, pulls the exact `repository@sha256:...` artifact, and removes the temporary Docker configuration immediately;
7. the Agent never writes registry credentials to its normal home directory or Rundea work directory.

The credential itself may be provider-issued and long-lived; the node exposure is still bounded to one deployment attempt. Registry/provider adapters that can mint truly short-lived pull tokens can replace the static Control Plane secret later without changing the Agent ticket contract.

## Capability admission

Agents that can consume brokered registry credentials advertise:

`registryPullCredentials`

If private pull credentials are configured, the Control Plane refuses to dispatch a prebuilt deployment to an Agent that does not advertise that capability.

Public registries continue to work without a ticket.

## Threat boundary

The one-time ticket is:

- random and stored only as a hash in PostgreSQL;
- bound to deployment id and node id;
- bound to the configured registry host;
- single-use;
- short-lived;
- sent only as part of the existing authenticated Agent command path.

The credential response is returned with `Cache-Control: no-store`.

## Acceptance

A dedicated acceptance job must use a registry that actually requires Basic authentication and prove:

- Builder authenticates and pushes the image;
- unauthenticated registry access is rejected;
- Control Plane issues the node-bound one-time ticket;
- Agent consumes the ticket and pulls the immutable digest;
- deployment reaches READY;
- the ticket is marked consumed;
- no Docker credential file remains under the Agent HOME or Rundea work directory.
