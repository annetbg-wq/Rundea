# Rundea

Rundea is an infrastructure-agnostic deployment platform: Railway-like developer experience without the platform tax. Deploy on Rundea compute or your own VPS.

## v0 architecture

```text
Rundea Web -> Control Plane API -> outbound Agent connection -> Docker -> User Service
                      |                                  |
                  PostgreSQL                         managed Caddy
```

The Control Plane owns desired state, encrypted service configuration, domains and deployment history. A small Go Agent runs on each VPS, opens an authenticated outbound WebSocket to the Control Plane, and executes explicit deployment/runtime commands against the local Docker runtime.

## What runs today

The current vertical path is small but executable end to end:

1. register a node and receive a one-time node token;
2. run the Go Agent on a Linux host with Docker and Git installed;
3. the Agent connects outbound to the Control Plane;
4. save service variables/secrets encrypted at rest;
5. create a deployment through the API or web UI;
6. the Agent clones the requested public GitHub ref;
7. if a Dockerfile is present, use it; otherwise generate a Node.js 24 build plan from `package.json`;
8. run the container with a short-lived environment transport file;
9. resolve and execute the healthcheck;
10. persist Git SHA, Docker image identity, logs, state and immutable deployment environment snapshot;
11. attach custom domains through managed Caddy and automatic HTTPS;
12. restart the current READY revision with a required healthcheck;
13. roll back to an exact retained historical image and its exact encrypted environment snapshot;
14. qualify a node for workload-specific egress such as Sendina SMTP/IMAP connectivity.

`READY` is emitted only after a successful healthcheck.

## Local Control Plane

Requires Node.js 24 and Docker.

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm ci
set -a; source .env; set +a
npm run dev:api
```

The control token and master key in `.env.example` are explicit **local-development-only** values. Production must use separately generated high-entropy credentials. `RUNDEA_MASTER_KEY` must be a base64-encoded 32-byte key and must stay outside the repository.

In another shell:

```bash
RUNDEA_API_URL=http://localhost:4000 RUNDEA_CONTROL_TOKEN=local-dev-only-control-token-0123456789abcdef npm run dev:web
```

## Node bootstrap

Create a node (bootstrap endpoint is temporary v0 administration and is protected by `RUNDEA_CONTROL_TOKEN`):

```bash
curl -sS -X POST http://localhost:4000/v0/nodes \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-only-control-token-0123456789abcdef' \
  -d '{"name":"dev-node"}'
```

The response contains `id` and a **one-time** token. The API stores only its SHA-256 hash.

The browser bundle never receives `RUNDEA_CONTROL_TOKEN`: during local development Vite proxies `/api` server-side and injects the control credential. A production user-auth/session layer is intentionally a later slice; Rundea does not publish an administrative credential to client JavaScript.

Run the Agent directly during development:

```bash
cd apps/agent
go run . \
  --control-plane http://localhost:4000 \
  --node-id '<node-id>' \
  --token '<one-time-token>'
```

For installed nodes, `infra/agent/install.sh` requires an HTTPS Agent binary URL plus its SHA-256 checksum and an `https://` Control Plane URL. The installer refuses to place an unverified root-level Agent binary on the host.

The private Rundea source repository is **not** a production binary distribution channel. Nodes should not receive a long-lived GitHub PAT just to download the Agent. CI currently produces verified Linux amd64/arm64 bundles for acceptance/release preparation; public production distribution remains a separate release-channel boundary.

## Environment variables and secrets

Both ordinary variables and secrets are encrypted at rest. A secret is never returned in plaintext by the read API; ordinary non-secret variables may be read back by the authenticated control client.

Each deployment captures an immutable encrypted environment snapshot when it is created. Later edits to the service variables do not mutate historical rollback state.

Example:

```bash
curl -sS -X PUT http://localhost:4000/v0/services/sendina/variables \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-only-control-token-0123456789abcdef' \
  -d '{"variables":[
    {"key":"APP_TOKEN","value":"replace-me","secret":true},
    {"key":"DATABASE_URL","value":"postgres://...","secret":true}
  ]}'
```

`HOST`, `PORT` and `RUNDEA_*` are owned by Rundea. The Agent sets `HOST=0.0.0.0` and `PORT` to the selected container port. Multiline values are intentionally unsupported in v0 so Docker env-file transport remains simple and auditable.

## Create a deployment

The source repository must currently be an HTTPS GitHub repository cloneable by the Agent without interactive credentials. Private GitHub App source delivery remains a separate slice; Rundea will not require permanent GitHub PATs on nodes.

A Dockerfile is optional. When omitted, Rundea currently supports a Node.js 24 auto-build plan. Healthcheck path is also optional; compatible Railway metadata is read as a migration convenience before falling back to `/health`.

```bash
curl -sS -X POST http://localhost:4000/v0/deployments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-only-control-token-0123456789abcdef' \
  -d '{
    "serviceName":"sendina",
    "nodeId":"<node-id>",
    "sourceRepository":"https://github.com/annetbg-wq/sendina.git",
    "sourceRef":"main",
    "containerPort":3001,
    "hostPort":18080
  }'
```

For the current Sendina repository this selects the Node.js auto-build path and detects `/api/health` from its existing deployment metadata, without requiring a Rundea-specific commit in Sendina.

## Runtime controls

A successful normal deployment records the exact resolved Git SHA and content-addressed Docker image ID. Restart operates only on the current READY revision and requires the service healthcheck to pass again.

Rollback creates a new auditable deployment from a historical READY/ROLLED_BACK revision. It uses the exact retained Docker image and exact encrypted environment snapshot. v0 rollback is node-local and briefly interrupts the stable host port; it is explicitly **not zero-downtime promotion**.

## Node acceptance gate

`.github/workflows/node-acceptance.yml` exercises the actual runtime path on a Linux GitHub Actions Docker host with real PostgreSQL, a separately running Control Plane and a separately running Go Agent.

The gate verifies:

- Agent enrollment and `ONLINE` state;
- Node.js auto-build and real Docker container startup;
- healthcheck and actual HTTP response;
- persisted source SHA/image identity/environment snapshot;
- Restart;
- second deployment;
- exact rollback;
- rollback chaining.

CI also produces Linux amd64/arm64 Agent binaries and a verified `SHA256SUMS` manifest.

This is stronger than unit testing but is still not a claim that an independently provisioned Internet VPS has passed provider-specific networking, DNS and ingress checks. A real production-candidate node must run the same product path plus any workload-specific qualification on that actual host.

## Current scope boundary

Rundea now has the core Control Plane -> Agent -> Docker path, encrypted configuration, Node.js auto-build, node egress qualification, custom domains/managed HTTPS, deployment history, Restart and exact node-local Rollback.

Still outside the current v0 proof boundary:

- production user/org authentication and authorization;
- GitHub App private-source delivery and deployment-on-push;
- public production Agent binary distribution;
- external-VPS acceptance on a real provider node;
- cross-node artifact storage/rollback;
- zero-downtime promotion;
- mature log storage and artifact retention/garbage collection.

See `docs/architecture/` for the decisions that constrain those slices.
