# ADR 0019: Single ingress ownership on self-hosted Rundea nodes

Status: Accepted

## Context

Rundea can host its own Control Plane on a node that also runs customer workloads. The initial live bootstrap used a compose-managed Caddy edge for `rundea.bachopus.com`, while the Rundea Agent independently owned a managed `rundea-caddy` runtime for workload domains. Both implementations expect host ports 80/443, so allowing them to coexist would create an ownership race and make first-party dogfood such as SignalKit unsafe.

Giving workload containers their own public ports is not an acceptable workaround. It would bypass Rundea ingress, duplicate TLS ownership, weaken isolation, and diverge from the normal deployment model.

## Decision

A node has exactly one public HTTP/HTTPS ingress owner. After bootstrap, that owner is the Agent-compatible `rundea-caddy` runtime on host ports 80/443.

The self-hosted Control Plane is treated as node infrastructure, not as a normal workload deployment. It is published only on a loopback host port and registered locally with the Agent through `RUNDEA_RESERVED_INGRESS_ROUTES` using the format:

```text
hostname=loopback-port[,hostname=loopback-port...]
```

For the first live node:

```text
rundea.bachopus.com=4000
```

Every application ingress reconciliation merges these reserved system routes with the Control Plane's application-domain desired state before rendering Caddy configuration. Reserved routes are never returned as application-domain results and cannot be claimed by an application hostname.

Before changing Caddy state, the Agent verifies every reserved upstream is reachable on `127.0.0.1:<port>`. If a reserved upstream is unavailable, reconciliation fails closed without applying a configuration that could intentionally remove the system route.

The total merged route set remains bounded by the existing v0 route limit.

## Bootstrap handoff

A fresh self-hosted Control Plane still needs public HTTPS before an Agent can connect. The compose Caddy therefore remains a bootstrap-only profile.

The live handoff is explicit and verified:

1. publish the Control Plane only on a loopback host port;
2. install a Rundea Agent version that supports reserved ingress routes;
3. prove the loopback Control Plane health endpoint is healthy;
4. preserve the bootstrap Caddy ACME state;
5. validate the future managed Caddy configuration;
6. stop the bootstrap edge;
7. start `rundea-caddy` on 80/443 with the reserved Control Plane route;
8. verify the public Control Plane health endpoint;
9. restart the Agent with the reserved route configured;
10. mark the live stack as managed-ingress mode so future compose deploys cannot respawn the bootstrap edge.

If the new Caddy cannot start or public HTTPS verification fails, the handoff restores the bootstrap edge instead of leaving the node without ingress.

## Consequences

- ports 80/443 belong to Rundea, not SignalKit or any other workload;
- the Control Plane and workloads can safely share one VPS without competing ingress daemons;
- workload containers remain loopback-only and receive arbitrary non-reserved host ports;
- adding or removing a workload domain cannot remove the reserved Control Plane route;
- the bootstrap edge is transitional infrastructure and must not be restarted after managed takeover;
- a future multi-node production Control Plane may use a separate ingress/load-balancer architecture, but that does not change the one-owner-per-node rule.
