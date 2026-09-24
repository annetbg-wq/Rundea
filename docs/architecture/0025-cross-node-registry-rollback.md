# ADR 0025: Cross-node rollback through immutable registry artifacts

## Status

Accepted for registry-first production deployments.

## Context

The original rollback contract assumed that the target revision's Docker image was still present in the local image store of the same node. That is not sufficient once a service has moved to another production node.

Registry-first builds now persist an immutable `repository@sha256:...` reference for every built artifact, so rollback can recover the exact revision without rebuilding source.

## Decision

Rollback remains an auditable new deployment with `operation = ROLLBACK` and `rollback_target_id` pointing to the selected historical revision.

The rollback destination is the node that currently owns the service's READY revision, not the historical target node.

For a target on the same node Rundea may use the locally retained image. If the local retained image is unavailable, or if the target revision came from another node, Rundea uses the historical revision's immutable registry artifact.

Cross-node rollback is allowed only when the historical revision has:

- an immutable registry reference pinned by `@sha256`;
- matching immutable source commit provenance;
- a captured runtime environment snapshot;
- a recorded Docker image identity.

The rollback deployment copies the target revision's environment snapshot, source provenance, image identity and immutable registry reference. It uses the current node's stable service port.

## Agent behavior

The rollback command may include an immutable artifact descriptor.

The Agent first checks the original retained local tag. If the exact expected image is available locally, it uses the existing fast path.

If the retained tag is absent and the command contains an immutable registry artifact, the Agent:

1. exchanges the optional one-time registry credential ticket;
2. pulls the exact `repository@sha256` artifact;
3. retains it under the new rollback deployment tag;
4. verifies that the pulled Docker image identity exactly equals the target revision's recorded image id;
5. starts the candidate using the target revision's environment snapshot;
6. requires the existing healthcheck and safe route promotion before READY.

There is no source checkout and no Docker build in rollback.

## Failure semantics

If a cross-node target has no immutable registry artifact, rollback is rejected before dispatch.

If the registry pull fails, the digest is wrong, or image identity does not match, the rollback candidate fails and the existing READY route remains unchanged.

## Acceptance

A dedicated acceptance scenario must prove:

- revision A reaches READY on node A from a registry-first build;
- the service then reaches READY on node B;
- revision A becomes historical;
- the node-local retained tag for revision A is removed;
- rollback to revision A is created on node B;
- Agent B logs that it recovered the immutable rollback artifact from the registry;
- rollback preserves `rollback_target_id` and the original immutable artifact reference;
- the rollback reaches READY without source checkout or Docker build.
