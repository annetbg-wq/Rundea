# ADR 0009: Node acceptance and Agent distribution boundary

Status: Accepted

## Context

Unit tests and compile checks are necessary but insufficient for a deployment platform. Rundea's critical path crosses process, network, database, Git and Docker boundaries:

`Control Plane -> WebSocket Agent -> source -> image build -> runtime router -> container -> healthcheck`

Restart, rollback, zero-downtime route switching and crash recovery add runtime state that cannot be proven by type checking alone.

## Decision: executable node acceptance contract

Rundea maintains a dedicated acceptance workflow on a real Linux Docker runner. The workflow starts PostgreSQL, the Control Plane, a separately compiled Go Agent and real Docker workloads.

The gate currently verifies:

1. node enrollment and Agent `ONLINE` state;
2. signed GitHub push autodeploy at an exact commit;
3. Source Broker delivery without GitHub credentials on the node;
4. Node.js auto-build and real Docker startup;
5. healthcheck before `READY`;
6. persisted Git SHA, Docker image ID and immutable environment snapshot;
7. Restart;
8. continuous HTTP while a healthy deployment switches through the stable runtime router;
9. failed candidate healthcheck preserving the previous live route;
10. exact retained-image rollback and rollback chaining;
11. continuous HTTP through rollback switching;
12. committed runtime route recovery after Agent crash/reconnect;
13. Agent -> Control Plane -> PostgreSQL runtime metrics;
14. one-time bootstrap credential rotation into a separate permanent node credential.

The public workload fixture is pinned to commit:

`039c34770852fb07cef7f9f0f8534c5de408b207`

Acceptance fails if the executed source identity differs.

## Decision: Agent build artifacts and releases

Ordinary node acceptance cross-compiles static Linux Agent binaries for `amd64` and `arm64` and verifies `SHA256SUMS`.

Production distribution is defined separately in ADR 0016. Tagged `agent-v*` releases publish the same architecture binaries and checksum manifest. A private release repository is acceptable because the Control Plane, not the node, performs GitHub App authentication and verifies the release before serving the Agent to an authenticated node.

No long-lived GitHub PAT or installation token is placed on the VPS merely to install Rundea.

## External VPS acceptance

GitHub Actions proves the full Rundea runtime path on a real Linux Docker host, including runtime routing and crash recovery, but it is not evidence that a separately provisioned Internet VPS has passed provider-specific networking, DNS and ingress behavior.

A production-candidate node is accepted only after the same product path is executed on that exact external host: one-command Agent installation, Agent reconnect behavior, deployment, public HTTPS, restart and rollback.

Workload-specific egress checks remain optional capabilities. In particular, applications using provider HTTPS APIs do not need SMTP/IMAP ports to become a generally valid Rundea node.

## Scope boundary

Implemented and CI-accepted now:

- public and brokered exact source delivery;
- GitHub App private-source credential boundary;
- managed HTTPS ingress;
- immutable runtime snapshots;
- restart and exact node-local rollback;
- zero-downtime deploy/rollback route switching;
- runtime metrics;
- Agent release/bootstrap mechanism.

Still requiring an external/live gate:

- an actual immutable `agent-v*` production release;
- a production Control Plane configured to distribute that release;
- a fresh Internet VPS installed through the one-command path;
- live GitHub App acceptance against a real private customer repository;
- production user/org authorization;
- cross-node artifact storage and rollback.
