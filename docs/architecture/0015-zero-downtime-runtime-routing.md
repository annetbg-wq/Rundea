# ADR 0015 — Zero-downtime runtime routing

Status: Accepted

## Context

The safe-candidate model in ADR 0014 prevents an unhealthy candidate from replacing the current READY runtime, but a successful promotion still required the old container to release the stable host port before the new container could bind it. That creates an avoidable cutover window and couples workload lifecycle to the public service socket.

Rundea also needs deployment recovery to remain deterministic when the Agent or host stops during a route switch. A live proxy configuration must never silently become more authoritative than the durable route state.

## Decision

Each node runs a dedicated local `rundea-runtime-router` Caddy process for workload service ports. It is separate from the public ingress Caddy that owns ports 80/443 and TLS state.

### Workload backends

A deployment revision runs in a deployment-scoped Docker container and publishes its application port only on a Docker-assigned `127.0.0.1` host port. Workload containers never own the stable service `hostPort`.

The runtime router owns the stable service listener and proxies it to the active revision's loopback backend.

### Promotion

For deploy and exact rollback:

1. build or resolve the immutable artifact;
2. start the new revision on an isolated loopback port;
3. healthcheck that backend directly;
4. retain the current stable route while validation is in progress;
5. prepare and validate a candidate Caddy configuration;
6. gracefully reload Caddy so the stable listener points to the new backend without rebinding the listener;
7. verify the stable route through HTTP and require the exact `X-Rundea-Deployment` response marker;
8. commit the new `routes.json` state and durable Caddyfile;
9. retain the previous backend for a bounded drain window, then remove it.

A failed backend never changes the stable route.

### Durable state and crash recovery

`routes.json` is the authoritative committed runtime route state. The durable `Caddyfile` is regenerated from it during Agent recovery.

An in-progress deployment switch uses a private promotion marker and `Caddyfile.next`. The candidate file is used only for live reload and cannot become the boot configuration before commit. If the Agent stops before commit, recovery restores the committed route and removes the uncommitted backend when ownership matches.

For the first runtime-router on a node, Docker restart is disabled until the first route commit succeeds. This prevents a host reboot from starting an uncommitted first route.

After recovery, the Agent verifies each committed stable route and reports `runtimeRecovered` with the actual backend container identity. The Control Plane accepts recovery only from the authenticated owning node and does not allow an arbitrary failed deployment to be resurrected.

### Restart semantics

An explicit Restart restarts the active revision backend in place. Docker-assigned host ports are not assumed to remain stable across restart. The Agent re-reads the actual single loopback port after restart.

If Docker changes that port, Rundea first healthchecks the new backend socket, then commits the new route as the only valid route state and reloads the runtime router. The old random port is not treated as a rollback target because the restarted container no longer serves it. Recovery therefore converges to the verified new socket after an Agent crash.

Restart is not claimed as zero-downtime: restarting a single backend can briefly interrupt requests. Zero-downtime in this ADR applies to replacement deployment and rollback revision switches where old and new backends overlap.

### Caddy trust and persistence

The Caddy image is digest-pinned. Docker invocations set `--entrypoint caddy` explicitly rather than relying on image ENTRYPOINT metadata.

The local runtime router persists only Rundea-owned route state and Caddy configuration under the Agent work directory. It does not bind-mount Caddy `/data` or `/config` to the host because this HTTP-only router owns no certificate state. The separate public ingress Caddy continues to persist `/data` and `/config` for TLS.

The runtime router admin API listens only on `127.0.0.1:2020`.

## Invariants

- A candidate backend is never publicly selected before direct health succeeds.
- The stable service listener is not rebound during deploy or rollback promotion.
- Route verification requires both successful HTTP and the exact deployment marker.
- A failed candidate cannot replace the previous committed route.
- A reboot cannot promote `Caddyfile.next` into committed state.
- Router and workload container ownership are validated before destructive Docker operations.
- Runtime service ports 80, 443, 2019 and 2020 are reserved for Rundea routing infrastructure.

## Acceptance gates

The Docker acceptance workflow must prove on the exact merge head:

- continuous successful HTTP traffic while a deployment revision switches;
- continuous successful HTTP traffic while an exact rollback revision switches;
- an intentionally unhealthy replacement reaches FAILED while the prior stable route remains live;
- a committed route continues serving while the Agent process is stopped and reconciles after reconnect;
- restart succeeds even when Docker changes the backend's published loopback port;
- runtime metrics still traverse Agent → Control Plane → PostgreSQL after the routing change.

## Consequences

Benefits:
- failed candidates no longer threaten the current service;
- deploy and rollback no longer need a stable-port Docker cutover;
- public ingress can continue targeting a stable local port while revision routing changes underneath it;
- recovery has a single durable source of truth;
- future traffic policies can evolve at the router layer without changing workload container contracts.

Costs and current limits:
- each node has an additional managed Caddy process;
- exact rollback artifacts are still node-local until Rundea has an external artifact registry;
- this is single-node zero-downtime routing, not cross-node load balancing or rescheduling;
- graceful proxy switching cannot make an application protocol safe if the application itself does not tolerate connection draining;
- explicit Restart of a single backend can still have a short interruption.
