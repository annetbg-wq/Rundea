# ADR 0009: Node acceptance and Agent distribution boundary

Status: Accepted

## Context

Unit tests and compile checks are necessary but insufficient for a deployment platform. Rundea's critical path crosses process, network, database, Git and Docker boundaries:

`Control Plane -> WebSocket Agent -> Git checkout -> image build -> container -> healthcheck`

Restart and rollback add additional runtime state that cannot be proven by type checking alone.

The Rundea source repository is private. Installing a node directly from a private GitHub Release would require GitHub credentials on every node, expanding the node secret surface for a distribution concern.

## Decision: executable node acceptance contract

Rundea maintains a dedicated acceptance workflow on a real Linux Docker runner. The workflow starts:

- PostgreSQL 17;
- the Rundea Control Plane as a separate process;
- a compiled Rundea Agent as a separate process connected over the normal Agent WebSocket;
- real Docker containers managed by that Agent.

The acceptance harness enrolls a node through the Control Plane API and verifies:

1. the Agent becomes `ONLINE`;
2. a public Node.js fixture is cloned and uses Rundea's Node auto-build path;
3. the deployment reaches `READY` only after healthcheck success;
4. the service answers through the actual host port;
5. the Control Plane persisted the resolved Git SHA, Docker image ID, health path and immutable environment snapshot;
6. `Restart` succeeds and the service is healthy afterward;
7. a second deployment can replace the service;
8. rollback to the first exact retained image succeeds;
9. the replaced revision becomes `ROLLED_BACK`;
10. a second rollback can target that historical `ROLLED_BACK` revision, proving rollback chaining.

The fixture is `render-examples/express-hello-world`. The workflow currently requests its `main` ref and asserts that the resolved source commit is exactly:

`039c34770852fb07cef7f9f0f8534c5de408b207`

If upstream `main` moves, acceptance fails rather than silently testing different code. Native commit-SHA source refs are a separate source-resolution improvement.

## Decision: distributable build artifacts

CI cross-compiles static Linux Agent binaries for:

- `linux/amd64`;
- `linux/arm64`.

A `SHA256SUMS` manifest is generated and verified before the bundle is uploaded as a GitHub Actions artifact.

These artifacts prove that installable binaries can be produced reproducibly enough for acceptance and release preparation. They are retained as internal CI artifacts and are not the production public distribution channel.

## Decision: no long-lived GitHub credential on nodes for Agent download

Rundea nodes must not receive a long-lived GitHub PAT merely to download an Agent binary from the private source repository.

The production distribution channel must instead provide an HTTPS-downloadable binary plus a published checksum without granting source-repository access. Acceptable future implementations include:

- a public release-only repository containing binaries but no private source;
- a public object-storage/CDN release bucket;
- a Control Plane distribution endpoint backed by immutable release objects.

The existing installer remains deliberately generic: it accepts an HTTPS Agent URL and an independently supplied SHA-256 checksum and verifies the binary before installation.

## External VPS acceptance

GitHub Actions acceptance proves the full Rundea runtime path on a real Docker host, but it is not evidence that a separately provisioned Internet VPS has passed provider-specific networking and ingress checks.

A production-candidate node is accepted only after the same product path is executed on that actual node, including any workload-specific egress qualification such as Sendina's SMTP/IMAP probes.

## Scope boundary

This ADR does not claim:

- a production public Agent binary channel already exists;
- an external Koyeb, Hetzner or other VPS has already passed the gate;
- private GitHub source checkout is implemented;
- zero-downtime deployment is implemented.
