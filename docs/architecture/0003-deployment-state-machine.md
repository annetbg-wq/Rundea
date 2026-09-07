# ADR 0003: Explicit deployment state machine

Status: Accepted

## Decision

Canonical v0 states are:

`QUEUED -> BUILDING -> DEPLOYING -> HEALTHCHECK -> READY`

Terminal/exception states are `FAILED`, `CANCELLED`, and `ROLLED_BACK`.

`READY` is valid only after `HEALTHCHECK`. The control plane validates every transition in a database transaction and persists a corresponding deployment event.

## Idempotency

A deployment has an immutable UUID. Re-delivery of the same deployment command uses the same workspace/image tag and deterministic service container name. The agent removes/replaces that service container before starting the requested revision.

This foundation uses a short PostgreSQL dispatch lease to prevent duplicate sends of `QUEUED` work during reconnect/heartbeat races. A later slice must add durable command-attempt identities and reconciliation so an interrupted non-QUEUED deployment can be resumed or failed deterministically after agent restart.

## Rollback

Rollback is not implemented in this PR. The intended model is to keep immutable successful deployment revisions/image identities and issue a new reconciliation command selecting a previous revision. `ROLLED_BACK` describes the superseded deployment, not an unaudited mutation of history.
