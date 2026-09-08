# ADR 0008: Immutable deployment revisions, restart and rollback

Status: Accepted

## Context

A Railway-like platform needs more than a Deploy button. Operators must be able to restart the currently running revision and roll back a bad release without silently rebuilding source with different dependencies, environment variables, or runtime metadata.

Re-running an old Git ref is not a real rollback: the branch or tag may have moved, dependency resolution may have changed, service variables may have been edited, and an image tag may have been retagged. Rundea therefore treats a rollback target as an immutable revision identity rather than as a source hint.

## Decision: snapshot environment at deployment creation

Every new deployment captures the service environment into `deployment_variables` in the same PostgreSQL transaction that creates the deployment row. The values remain AES-256-GCM encrypted at rest using the existing Rundea master-key boundary.

Changing current service variables after a deployment is created does not mutate that deployment's runtime snapshot.

Legacy deployments created before this feature do not have an immutable environment snapshot and are not advertised as rollbackable.

## Decision: record source and image identity

After cloning and building a normal deployment, the Agent reports:

- the full 40-hex Git commit SHA resolved from the checked-out source;
- the Docker content-addressed image ID (`sha256:...`);
- the actual healthcheck path resolved by the Agent.

The Control Plane accepts this artifact event only from the authenticated node that owns the deployment and only while the deployment is in `BUILDING`.

A mutable Docker tag is not sufficient rollback identity.

## Decision: restart is the same revision

Restart does not create a new deployment. It creates an auditable `runtime_actions` row of kind `RESTART` for the current READY revision.

The Agent verifies that the stable service container carries the requested `rundea.deployment` label, performs `docker restart`, and requires the same healthcheck to pass again before reporting success.

Only one runtime action may be RUNNING on a node at a time, and deployment dispatch is blocked while a runtime action is active.

## Decision: rollback creates a new deployment

Rollback does not rewrite historical source/configuration. Selecting a revision that previously reached READY — currently represented by `READY` or `ROLLED_BACK` — creates a new deployment row with:

- `operation = ROLLBACK`;
- `rollback_target_id` pointing to the selected revision;
- the target revision's Git SHA and Docker image ID;
- a copy of the target revision's encrypted environment snapshot;
- the target revision's resolved healthcheck path and runtime ports.

The new rollback deployment then traverses the normal auditable state machine:

`QUEUED -> BUILDING -> DEPLOYING -> HEALTHCHECK -> READY | FAILED`

`BUILDING` for rollback means validation of the retained artifact, not a new source build.

## Decision: exact retained artifact only

The v0 Agent expects the target image to still exist on the target node under the target deployment's retained image tag. Before starting it, the Agent inspects the image and requires its content-addressed image ID to exactly equal the ID stored in PostgreSQL.

After validating it, the Agent also creates the new rollback deployment's own retained image tag pointing at that same verified image ID. This means a successful rollback revision can itself be selected later, including rollback-of-a-rollback chains, without rebuilding source.

If the artifact is absent or the identity differs, rollback fails. Rundea does not silently rebuild an approximation of the target revision.

This makes artifact retention/garbage collection part of the future rollback-retention policy.

## Decision: preserve the current revision during rollback promotion

Because v0 services use a stable container name and host port, the current service container must release that port before the rollback revision can start.

The Agent therefore:

1. renames the current service container to a temporary backup name;
2. stops it without deleting it;
3. starts the exact rollback artifact with the target environment snapshot;
4. removes the temporary environment file immediately after Docker consumes it;
5. waits for the rollback healthcheck;
6. writes the READY event to the authenticated Control Plane WebSocket;
7. only after that WebSocket write succeeds, deletes the backup container.

If startup, healthcheck, or the READY WebSocket write fails, the Agent removes the attempted rollback container and restores the previous container under the stable service name.

The current protocol does not yet include an application-level acknowledgement message for each Agent event; a successful WebSocket write is the delivery boundary used by the existing deployment protocol. A later protocol-hardening slice may add explicit event acknowledgements/idempotency.

After a rollback deployment becomes READY in PostgreSQL, the previously current READY deployment is recorded as `ROLLED_BACK`. That revision remains a valid rollback target if its immutable snapshot and retained artifact still exist. The selected historical target remains historical evidence; the new rollback deployment is the new current revision.

## Availability consequence

This is **not zero-downtime deployment**. There is a short interruption while the stable host port moves between the current and rollback containers.

Zero-downtime promotion requires deployment-specific containers plus an atomic proxy route switch and is a separate later slice.

## Scope boundary

Rollback in v0 is node-local because images are retained only in the selected node's Docker image store. Cross-node rollback requires a shared artifact registry or another content-addressed artifact store.

This ADR does not introduce GitHub App private-source delivery, cross-node artifact replication, zero-downtime deployment, explicit Agent event acknowledgements, or a live Sendina migration.
