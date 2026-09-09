# ADR 0014 — Safe candidate promotion before stable-port cutover

Status: accepted for v0

## Context

The original v0 runtime path removed the current service container before the replacement revision had proved that it could start and pass healthcheck. A build or runtime regression could therefore turn a failed deployment into avoidable service downtime.

Rundea already has immutable source/image identity, deployment environment snapshots, runtime healthchecks and exact rollback artifacts. The missing invariant is runtime promotion: a new revision must prove health without destroying the current READY runtime first.

## Decision

Normal deploy and rollback use one Agent-local promotion primitive.

When a managed service already has a running revision:

1. build or resolve the new immutable image as usual;
2. start a **candidate** container from the exact deployment environment snapshot;
3. publish the candidate only on `127.0.0.1` using a Docker-assigned temporary host port;
4. keep the existing stable container and stable host port untouched;
5. run the deployment healthcheck against the candidate;
6. if the candidate fails, capture a short log tail, remove only that candidate and fail the new deployment while the old service remains live;
7. if the candidate passes, begin a short stable-port cutover;
8. persist a local recovery marker before changing the old runtime;
9. rename and stop the previous container, preserving it as a fallback;
10. start the new revision on the stable loopback host port and run the same healthcheck again;
11. if stable-port startup or healthcheck fails, remove the new managed container and restore the preserved previous revision;
12. after stable-port health succeeds, clear the recovery marker and remove the stale fallback.

A first deployment has no live revision to protect, so Rundea starts it directly on the stable port and healthchecks it normally.

Rollback follows exactly the same runtime promotion path after the retained image identity has been verified. It does not receive a weaker safety model than a normal deployment.

## Ownership boundary

Promotion may inspect, rename, stop or remove only containers that carry Rundea ownership labels. Destructive cleanup verifies `rundea.managed=true` and the expected `rundea.deployment` identity. Candidate cleanup additionally requires `rundea.candidate=true`.

A container that occupies a Rundea service slot but does not satisfy those ownership checks is treated as ambiguous and is not destroyed automatically.

Candidate ports are loopback-only. Candidate healthchecking does not expose an additional public listener and does not modify Caddy routes.

## Interrupted cutover recovery

Immediately before the previous runtime is renamed/stopped, the Agent writes a private marker under its work directory containing:

- stable container name;
- fallback container name;
- previous deployment identity;
- new deployment identity.

The marker is written with private filesystem permissions using a temporary file followed by rename.

After an Agent reconnect, recovery runs before new commands are processed. If a valid fallback is still present, Rundea validates all ownership labels, removes only an uncommitted new container belonging to the recorded new deployment, restores the previous container name, starts it if necessary and removes the marker.

Corrupt or ambiguous recovery state is non-destructive: the Agent refuses automatic cleanup rather than guessing which container should win.

## Healthcheck semantics

Candidate healthcheck success is necessary but not sufficient for READY. The promoted container must pass the same healthcheck again on the stable service port before the Agent emits READY.

This catches failures that are specific to the final port binding or stable runtime launch.

## What this does and does not guarantee

This change removes the large avoidable outage window where the old service was destroyed before the replacement had been validated.

It is **not yet true zero-downtime deployment**. Docker cannot transfer an already-published host port between two running containers. After the candidate passes, v0 still has a short cutover interval while the old container releases the stable port and the new container binds it.

The next architectural step for true zero-downtime is a stable local routing layer or equivalent indirection that can switch upstreams without rebinding the public/stable listener.

There is also a small control-plane consistency window after local promotion succeeds but before the final READY WebSocket event is durably observed. In that rare case the workload can be healthy while Control Plane state later requires reconciliation. This ADR does not claim to solve distributed commit between Agent runtime state and Control Plane state.

## Acceptance

Node acceptance must prove both directions:

- healthy subsequent deployments and rollbacks still promote successfully through real Docker;
- an intentionally bad candidate healthcheck reaches FAILED while the prior stable service remains reachable and retains the prior deployment identity throughout candidate validation and after failure.

The negative gate also requires temporary candidate cleanup and an auditable deployment event stating that the previous READY revision remained live.
