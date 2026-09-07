# Rundea

Rundea is an infrastructure-agnostic deployment platform: Railway-like developer experience without the platform tax. Deploy on Rundea compute or your own VPS.

## v0 architecture

```text
Rundea Web -> Control Plane API -> outbound Agent connection -> Docker -> User Service
                      |
                  PostgreSQL
```

The control plane owns desired state and deployment history. A small Go agent runs on each VPS, opens an authenticated outbound WebSocket to the control plane, and executes explicit deployment commands against the local Docker runtime.

## What this foundation PR actually runs

The first vertical slice is intentionally small but real:

1. register a node in the control plane and receive a one-time node token;
2. run the Go agent on a Linux host with Docker and Git installed;
3. the agent connects outbound to the control plane;
4. create a deployment through the API or web UI;
5. the agent clones the requested Git ref, runs `docker build`, replaces the service container, performs an HTTP healthcheck, and streams status/log events back;
6. PostgreSQL stores deployment state and events.

`READY` is emitted only after a successful healthcheck.

## Local control plane

Requires Node.js 24 and Docker.

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
npm install
set -a; source .env; set +a
npm run dev:api
```

In another shell:

```bash
VITE_API_URL=http://localhost:4000 VITE_CONTROL_TOKEN=change-me npm run dev:web
```

## Node bootstrap

Create a node (bootstrap endpoint is temporary v0 administration and is protected by `RUNDEA_BOOTSTRAP_TOKEN`):

```bash
curl -sS -X POST http://localhost:4000/v0/nodes \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer change-me' \
  -d '{"name":"dev-node"}'
```

The response contains `id` and a **one-time** `token`. The API stores only its SHA-256 hash.

Run the agent:

```bash
cd apps/agent
go run . \
  --control-plane http://localhost:4000 \
  --node-id '<node-id>' \
  --token '<one-time-token>'
```

## Create a deployment

The source repository must currently be an HTTPS repository cloneable by the agent without interactive credentials. Private GitHub App source delivery is deliberately separated into the next slice; the architecture does not bake long-lived GitHub credentials into nodes.

```bash
curl -sS -X POST http://localhost:4000/v0/deployments \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer change-me' \
  -d '{
    "serviceName":"hello",
    "nodeId":"<node-id>",
    "sourceRepository":"https://github.com/example/hello.git",
    "sourceRef":"main",
    "dockerfile":"Dockerfile",
    "containerPort":8080,
    "hostPort":18080,
    "healthcheckPath":"/health"
  }'
```

## Current scope boundary

This PR proves the control-plane -> agent -> Docker execution path. It does **not** claim the complete Rundea v0 Definition of Done yet. GitHub App private-source delivery, encrypted service secrets, Caddy routing/automatic HTTPS, domain management, rollback UX, Sendina migration, and SMTP/IMAP egress verification are subsequent vertical slices and are recorded in the ADRs.

See `docs/architecture/` for the decisions that constrain those slices.
