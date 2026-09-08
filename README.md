# Rundea

Rundea is an infrastructure-agnostic deployment platform: Railway-like developer experience without the platform tax. Deploy on Rundea compute or your own VPS.

## v0 architecture

```text
GitHub push -> Control Plane API -> outbound Agent connection -> Docker -> User Service
                    |                                  |
                PostgreSQL                         managed Caddy
                    |
             Source Broker
                    |
          GitHub / GitHub App
```

The Control Plane owns desired state, encrypted service configuration, GitHub push delivery state, domains and deployment history. A small Go Agent runs on each VPS, opens an authenticated outbound WebSocket to the Control Plane, and executes explicit deployment/runtime commands against the local Docker runtime.

## What runs today

The current vertical path is small but executable end to end:

1. register a node and receive a one-time node token;
2. run the Go Agent on a Linux host with Docker and Git installed;
3. the Agent connects outbound to the Control Plane;
4. save service variables/secrets encrypted at rest;
5. create a deployment through the API or web UI;
6. resolve a public GitHub branch/tag or an exact 40-hex commit SHA;
7. optionally deliver an exact source archive through the Rundea Source Broker so the node receives no GitHub credential;
8. if a Dockerfile is present, use it; otherwise generate a Node.js 24 build plan from `package.json`;
9. run the container with a short-lived environment transport file;
10. resolve and execute the healthcheck;
11. persist Git SHA, Docker image identity, logs, state and immutable deployment environment snapshot;
12. attach custom domains through managed Caddy and automatic HTTPS;
13. restart the current READY revision with a required healthcheck;
14. roll back to an exact retained historical image and its exact encrypted environment snapshot;
15. qualify a node for workload-specific egress such as Sendina SMTP/IMAP connectivity;
16. accept an HMAC-authenticated GitHub `push` event and create the matching service deployment at the exact pushed `after` commit SHA through the Source Broker;
17. when a Rundea GitHub App is configured, authenticate private repository archive retrieval inside the Control Plane without forwarding GitHub credentials to the node.

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

`sourceRef` may be a named branch/tag or a full 40-hex commit SHA. Exact commit deployments use shallow fetch + detached checkout and verify that the checked-out `HEAD` is exactly the requested SHA.

There are two source delivery modes:

- `DIRECT` — the Agent clones the GitHub repository itself. In v0 this requires a repository that is cloneable without interactive credentials.
- `BROKER` — requires an exact 40-hex commit SHA. The Control Plane issues a two-minute, single-use deployment/node-scoped Rundea ticket; the Agent downloads the exact source archive from Rundea and receives no GitHub repository credential.

A Dockerfile is optional. When omitted, Rundea currently supports a Node.js 24 auto-build plan. Healthcheck path is also optional; compatible Railway metadata is read as a migration convenience before falling back to `/health`.

Direct example:

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

Brokered exact-SHA example:

```bash
curl -sS -X POST http://localhost:4000/v0/deployments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-only-control-token-0123456789abcdef' \
  -d '{
    "serviceName":"private-service",
    "nodeId":"<node-id>",
    "sourceRepository":"https://github.com/acme/private-service.git",
    "sourceRef":"<exact-40-hex-commit-sha>",
    "sourceDelivery":"BROKER",
    "containerPort":3000,
    "hostPort":18080
  }'
```

For the current Sendina repository the Node.js auto-build path detects its existing health metadata without requiring a Rundea-specific commit in Sendina.

## GitHub App private source

Private GitHub repositories use the same `BROKER` Agent contract as public brokered source. GitHub authentication exists only in the Control Plane.

Configure both values together:

```text
RUNDEA_GITHUB_APP_ID=<numeric-app-id>
RUNDEA_GITHUB_APP_PRIVATE_KEY_BASE64=<base64-of-github-app-pem-private-key>
```

Never commit the real private key. The PEM is base64-encoded only to make secret/environment transport reliable; base64 is not encryption, so production must keep this value in a proper secret-management boundary.

When a brokered repository is not publicly downloadable, Rundea:

1. creates a short-lived RS256 GitHub App JWT;
2. resolves the App installation for the exact repository;
3. requests an installation token restricted to that one repository and `contents:read`;
4. requests the exact commit archive from `api.github.com` without automatically following redirects;
5. accepts only an HTTPS `codeload.github.com` redirect;
6. downloads that temporary URL in a new request **without** the installation token;
7. applies the existing compressed-size limit before delivering the archive through the one-time Rundea Source Broker ticket.

The GitHub App private key and installation token never go to the Agent, deployment environment or database. Installation tokens are not persisted.

The adapter, JWT signing, least-privilege token request and credential-stripping rules are covered in CI. A claim of real GitHub private-repository operation still requires a live Rundea GitHub App installation acceptance run; until that is performed, the external private-source integration is implemented but not live-accepted.

## GitHub push autodeploy

Set `RUNDEA_GITHUB_WEBHOOK_SECRET` to a high-entropy secret on the Control Plane. Configure a service once:

```bash
curl -sS -X PUT http://localhost:4000/v0/services/sendina/autodeploy \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-dev-only-control-token-0123456789abcdef' \
  -d '{
    "nodeId":"<node-id>",
    "repository":"https://github.com/annetbg-wq/sendina.git",
    "branch":"main",
    "containerPort":3001,
    "hostPort":18080,
    "healthcheckPath":"/api/health",
    "enabled":true
  }'
```

Configure the GitHub repository or Rundea GitHub App webhook to send `push` events to `/v0/github/webhook` using the same secret. The endpoint is intentionally public, but it accepts a GitHub event only when `X-Hub-Signature-256` matches the HMAC-SHA256 of the exact raw request body.

Rundea matches the authenticated push by canonical repository + branch, then creates the deployment using the repository URL stored in the service configuration and `sourceRef=<push.after>`. It does **not** trust a clone URL supplied by the webhook payload. `X-GitHub-Delivery` and the raw-body digest provide idempotency/replay protection.

Webhook-triggered deployments are forced into `BROKER` source delivery before dispatch. A GitHub push is already pinned to an exact commit SHA, so the node has no reason to perform a mutable branch clone. This also means the same autodeploy path can use the GitHub App adapter for private repositories without changing the Agent.

## Runtime controls

A successful normal deployment records the exact resolved Git SHA and content-addressed Docker image ID. Restart operates only on the current READY revision and requires the service healthcheck to pass again.

Rollback creates a new auditable deployment from a historical READY/ROLLED_BACK revision. It uses the exact retained Docker image and exact encrypted environment snapshot. v0 rollback is node-local and briefly interrupts the stable host port; it is explicitly **not zero-downtime promotion**.

## Node acceptance gate

`.github/workflows/node-acceptance.yml` exercises the actual runtime path on a Linux GitHub Actions Docker host with real PostgreSQL, a separately running Control Plane and a separately running Go Agent.

The gate verifies:

- Agent enrollment and `ONLINE` state;
- a signed GitHub `push` creating the deployment at the exact pushed commit;
- duplicate `X-GitHub-Delivery` idempotency, raw-body replay protection and delivery-to-deployment observability;
- one-time Source Broker ticket delivery and safe GitHub archive extraction;
- Node.js auto-build and real Docker container startup;
- healthcheck and actual HTTP response;
- persisted source SHA/image identity/environment snapshot;
- Restart;
- exact rollback;
- rollback chaining.

CI also produces Linux amd64/arm64 Agent binaries and a verified `SHA256SUMS` manifest.

This is stronger than unit testing but is still not a claim that an independently provisioned Internet VPS has passed provider-specific networking, DNS and ingress checks. A real production-candidate node must run the same product path plus any workload-specific qualification on that actual host.

The public fixture proves the Source Broker runtime mechanics. GitHub App unit/integration tests prove the private credential boundary, but real private-repository GitHub acceptance is a separate external gate because CI does not contain a production Rundea GitHub App private key.

## Current scope boundary

Rundea now has the core Control Plane -> Agent -> Docker path, encrypted configuration, Node.js auto-build, exact Git commit resolution, signed push autodeploy through Source Broker, optional GitHub App private-source retrieval, node egress qualification, custom domains/managed HTTPS, deployment history, Restart and exact node-local Rollback.

Still outside the current v0 proof boundary:

- production user/org authentication and authorization;
- live acceptance against a real installed Rundea GitHub App + private repository;
- automatic GitHub App installation/connect UX;
- public production Agent binary distribution;
- external-VPS acceptance on a real provider node;
- cross-node artifact storage/rollback;
- zero-downtime promotion;
- mature log storage and artifact retention/garbage collection.

See `docs/architecture/` for the decisions that constrain those slices.
