# 0022 — Registry-first production deployment

## Status

Accepted for staged implementation.

## Context

Rundea currently performs source checkout and `docker build` on the target node. That keeps the deployment path self-contained, but it also makes the production node absorb transient build CPU, RAM and disk pressure. On small VPS nodes this can compete with the already-running production revision and can trigger host OOM or severe resource contention.

Production capacity should be sized for runtime load. Build capacity is a separate workload with different burst characteristics and security boundaries.

## Decision

The canonical production path becomes:

```
source -> isolated build worker -> registry -> immutable digest -> Agent pull -> candidate runtime -> healthcheck -> route switch
```

Node-local builds remain supported as a fallback/development path.

The first delivery slice introduces an immutable prebuilt-image deployment command without changing existing source builds. A prebuilt artifact is valid only when:

- its registry reference is pinned by `@sha256:<64 lowercase hex>`;
- an exact 40-character source commit SHA is persisted with it;
- no local build arguments are dispatched;
- the selected Agent advertises the `prebuiltImages` capability.

The Agent pulls the immutable reference, inspects its Docker image identity, re-tags it into Rundea's deployment-owned local artifact namespace, emits the normal artifact provenance event, and then uses the existing safe candidate promotion, healthcheck, routing and retention flow.

## Security boundary

Runtime secrets are not build inputs for this path and are not stored in the registry artifact. They continue to be written into a short-lived runtime env file immediately before container creation and removed afterwards.

Mutable registry tags are intentionally rejected. Rundea dispatches the exact content digest it has persisted, so a registry tag update cannot silently change what reaches production.

Registry authentication is not introduced in this slice. Initial acceptance uses a registry reachable by the Agent without new long-lived credentials. Registry credential brokering belongs with the Build Engine/registry integration and must use scoped, short-lived credentials rather than persistent plaintext node configuration.

## Failure semantics

Pull, digest validation or local retention failure marks only the candidate deployment FAILED. The current READY route is not replaced.

The existing runtime promotion path remains the only point at which traffic switches to a candidate.

## Compatibility

`prebuiltImages` is a selective capability, not a new global minimum capability. Existing Agents remain valid for existing source-build deployments. Control Plane refuses to dispatch a prebuilt artifact to a node that does not advertise the capability.

## Follow-up

1. Add isolated Build Engine jobs with explicit CPU/RAM/time limits.
2. Push build results to an artifact registry and persist immutable digest + source provenance.
3. Add build-state events distinct from runtime deployment state.
4. Add automatic build-to-deploy handoff.
5. Persist registry artifact identity strongly enough for cross-node rollback/migration to pull the exact historical artifact.
