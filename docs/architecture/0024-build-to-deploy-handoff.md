# 0024 — Automatic Build → Registry → Deploy handoff

## Status

Accepted for staged implementation.

## Context

Slice 2 introduced isolated build workers and immutable registry artifacts, but a successful build still stopped at PUSHED. Production deployment required a separate manual API call.

The production path should be one controlled operation while preserving the security and failure boundaries established by the Build Engine and prebuilt-image deployment slices.

## Decision

A build may be queued with `deployAfterPush=true`.

Rundea snapshots the canonical deployment target from the enabled service push-autodeploy configuration at queue time:

- service runtime identity;
- target node;
- container port;
- managed host port;
- healthcheck path.

The target is accepted only when the node is ONLINE, ACTIVE and advertises `prebuiltImages`.

After the Builder reports a valid immutable registry digest, the Control Plane performs the handoff transactionally:

1. locks the live build lease;
2. marks the build PUSHED and persists the immutable artifact;
3. creates a QUEUED deployment referencing exactly the build's source commit SHA and artifact digest;
4. captures the service runtime environment snapshot;
5. links the build to the deployment;
6. commits;
7. asks the target Agent to dispatch the queued deployment.

The production Agent receives only the immutable artifact path. It never receives source checkout instructions or build arguments for this deployment.

## Failure semantics

A build failure creates no deployment.

If the database transaction that creates the handoff fails, the build completion is rejected and no partial deployment is committed.

If artifact pull, candidate startup or healthcheck fails after handoff, the existing safe-promotion rules apply: the previous READY route remains live.

## Security boundary

Runtime secrets remain runtime-only and are captured only when the deployment is created.

The Builder never receives runtime secrets.

The production Agent never receives Builder credentials.

This slice proves the automatic handoff with a registry that is directly readable by the Agent. Scoped private-registry pull authentication remains a separate credential-brokering slice.

## Consequence

The canonical production path is now executable without a manual gap:

```
exact Git commit
  -> isolated Builder
  -> registry digest
  -> Control Plane handoff
  -> production Agent pull
  -> candidate
  -> healthcheck
  -> READY
```
