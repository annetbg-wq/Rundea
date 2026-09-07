# Rundea

Rundea is an infrastructure-agnostic deployment platform: Railway-like developer experience without the platform tax. Deploy on Rundea compute or your own VPS.

## v0 architecture

```text
Rundea Web -> Control Plane API -> outbound Agent connection -> Docker -> User Service
                      |
                  PostgreSQL
```

The control plane owns desired state, encrypted service configuration and deployment history. A small Go agent runs on each VPS, opens an authenticated outbound WebSocket to the control plane, and executes explicit deployment commands against the local Docker runtime.

## What runs today

The current vertical path is intentionally small but real:

1. register a node in the control plane and receive a one-time node token;
2. run the Go agent on a Linux host with Docker and Git installed;
3. the agent connects outbound to the control plane;
4. save service variables/secrets encrypted at rest;
5. create a deployment through the API or web UI;
6. the agent clones the requested Git ref;
7. if a Dockerfile is present, use it; otherwise generate a reproducible Node.js 24 build plan from `package.json` and the package lock;
8. run the container with a short-lived environment transport file;
9. detect the healthcheck from explicit config, compatible `railway.json` metadata, or `/health` fallback;
10. stream status/log events back while PostgreSQL stores deployment state and history.

`READY` is emitted only after a successful healthcheck.

## Local control plane

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

The response contains `id` and a **one-time** `token`. The API stores only its SHA-256 hash.

The browser bundle never receives `RUNDEA_CONTROL_TOKEN`: during local development Vite proxies `/api` server-side and injects the control credential. A production user-auth/session layer is intentionally a later slice; Rundea does not publish an administrative credential to client JavaScript.

Run the agent directly during development:

```bash
cd apps/agent
go run . \
  --control-plane http://localhost:4000 \
  --node-id '<node-id>' \
  --token '<one-time-token>'
```

For installed nodes, `infra/agent/install.sh` requires the published agent binary URL and its SHA-256 checksum, and requires an `https://` Control Plane URL. The installer refuses to place an unverified root-level agent binary on the host.

## Environment variables and secrets

Both ordinary variables and secrets are encrypted at rest. A secret is never returned in plaintext by the read API; ordinary non-secret variables may be read back by the authenticated control client.

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

`HOST`, `PORT` and `RUNDEA_*` are owned by Rundea. The agent sets `HOST=0.0.0.0` and `PORT` to the selected container port. Multiline values are intentionally unsupported in v0 so Docker env-file transport remains simple and auditable.

## Create a deployment

The source repository must currently be an HTTPS GitHub repository cloneable by the agent without interactive credentials. Private GitHub App source delivery remains a separate slice; Rundea will not require permanent GitHub PATs on nodes.

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

## Current scope boundary

The platform now has the real control-plane -> agent -> Docker path, encrypted service configuration and Node.js auto-build. It does **not** yet claim the complete Rundea v0 Definition of Done. GitHub App private-source delivery, Caddy routing/automatic HTTPS, domain management, rollback/restart UX, deployment-on-push and real SMTP/IMAP egress qualification are subsequent vertical slices recorded in the ADRs.

See `docs/architecture/` for the decisions that constrain those slices.
