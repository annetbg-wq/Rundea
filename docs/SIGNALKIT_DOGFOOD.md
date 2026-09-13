# SignalKit dogfood deployment on Rundea

SignalKit is the first non-trivial Rundea dogfood workload. It exercises a monorepo, two independent Dockerfiles, build-time public configuration, runtime secrets, external stateful dependencies, HTTP health checks, managed domains, and rollback.

## Same-node topology

The first SignalKit deployment intentionally shares the existing Hetzner node with the Rundea Control Plane. This is a product acceptance case, not a shortcut around Rundea.

Public ports `80/443` belong only to Rundea managed ingress. Neither `signalkit-api` nor `signalkit-web` may publish those ports directly. The Control Plane itself is a reserved system route on the same managed Caddy instance:

```text
rundea.bachopus.com -> 127.0.0.1:4000
```

SignalKit deployments receive separate loopback-only host ports selected by Rundea. Their public hostnames are then added to the same Caddy desired state. Agent `0.1.2` or later is required on this self-hosted node because it preserves reserved system ingress routes while reconciling application domains.

Before attaching any SignalKit domain, the live node must have completed the verified bootstrap-to-managed ingress handoff described in `infra/live/README.md`. The old bootstrap `edge` container must not remain the owner of `80/443` after that handoff.

## Source

- Repository: `https://github.com/vkpro72ai-create/signalkit.git`
- Preparation branch: `deploy/pdf-export-and-workspace-fix`
- Initial pinned commit: `589bdd739eb2c27f1386a7a49faa36eeb3ec6a53`
- Production source should move to `main` only after the deployment branch is reconciled and merged in SignalKit.

The first dogfood deployments must use the exact pinned commit above, not a mutable branch ref. That makes the first Rundea build reproducible and gives rollback/debugging an unambiguous source identity.

Because the SignalKit repository is public, the first deployment can use direct Git delivery while still pinning the exact commit SHA.

## Service: signalkit-api

- Dockerfile: `apps/api/Dockerfile`
- Container port: `4000`
- Health check: `/health`
- Intended public hostname: `api.signalkit.sys.bachopus.com`
- Build args: none required for the initial deployment

Runtime service variables:

```text
NODE_ENV=production
DATABASE_URL=<existing SignalKit PostgreSQL/Supabase pooled URL>
DIRECT_URL=<existing SignalKit direct PostgreSQL URL, if migration tooling needs it>
REDIS_URL=<external Redis URL>
JWT_SECRET=<secret>
JWT_EXPIRES_IN=7d
ENCRYPTION_KEY_FOR_LLM_KEYS=<secret>
CORS_ORIGINS=https://signalkit.sys.bachopus.com
```

Do not set `HOST` or `PORT`. Rundea owns those variables and injects `HOST=0.0.0.0` plus the selected container port.

The SignalKit API fails fast in production unless `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and `ENCRYPTION_KEY_FOR_LLM_KEYS` are present.

### Database migrations

The API Dockerfile intentionally does not run Prisma migrations during container startup. Before the first Rundea deployment, confirm the existing SignalKit database already contains the migrations expected by the pinned commit. If it does not, run the migration job separately before routing production traffic.

### Export persistence

The image writes generated export artifacts to `/var/lib/signalkit/exports`. Rundea v0 does not yet attach a persistent service volume through the deployment contract, so export files are ephemeral across container replacement/redeploy unless an external storage implementation is configured. This does not prevent API boot or normal non-export flows, but it is a known dogfood gap and must not be mistaken for durable production storage.

## Service: signalkit-web

- Dockerfile: `apps/web/Dockerfile`
- Container port: `3000`
- Health check: `/`
- Intended public hostname: `signalkit.sys.bachopus.com`

Build args:

```json
{
  "NEXT_PUBLIC_API_URL": "https://api.signalkit.sys.bachopus.com",
  "NEXT_PUBLIC_DEFAULT_LOCALE": "en"
}
```

These values are intentionally build arguments because Next.js compiles `NEXT_PUBLIC_*` values into the browser bundle. They are public configuration and must never contain secrets.

Runtime service variables may include `NODE_ENV=production`, but do not set `HOST` or `PORT`; Rundea injects them.

## Redis

The current SignalKit API requires Redis in production. For the first dogfood deployment use an external managed Redis endpoint and provide it as the encrypted `REDIS_URL` service variable.

Do not model Redis as a normal Rundea HTTP service yet: the current deployment readiness contract is HTTP-oriented and Rundea v0 has no durable stateful-service/volume contract. Native stateful dependencies should be designed separately rather than hidden behind a special-case SignalKit workaround.

## Create the initial deployments

First choose the existing ONLINE Hetzner Rundea node and free non-reserved host ports. The examples deliberately use placeholders because host ports are node-specific and must not be invented. Ports `80`, `443`, and the reserved Control Plane loopback port `4000` are not eligible workload host ports on this node.

API deployment request:

```json
{
  "serviceName": "signalkit-api",
  "nodeId": "<NODE_ID>",
  "sourceRepository": "https://github.com/vkpro72ai-create/signalkit.git",
  "sourceRef": "589bdd739eb2c27f1386a7a49faa36eeb3ec6a53",
  "sourceDelivery": "DIRECT",
  "dockerfile": "apps/api/Dockerfile",
  "buildArgs": {},
  "containerPort": 4000,
  "hostPort": "<API_HOST_PORT>",
  "healthcheckPath": "/health"
}
```

Web deployment request:

```json
{
  "serviceName": "signalkit-web",
  "nodeId": "<NODE_ID>",
  "sourceRepository": "https://github.com/vkpro72ai-create/signalkit.git",
  "sourceRef": "589bdd739eb2c27f1386a7a49faa36eeb3ec6a53",
  "sourceDelivery": "DIRECT",
  "dockerfile": "apps/web/Dockerfile",
  "buildArgs": {
    "NEXT_PUBLIC_API_URL": "https://api.signalkit.sys.bachopus.com",
    "NEXT_PUBLIC_DEFAULT_LOCALE": "en"
  },
  "containerPort": 3000,
  "hostPort": "<WEB_HOST_PORT>",
  "healthcheckPath": "/"
}
```

`hostPort` is an integer in the real API request; the quoted placeholder above is documentation only.

Deploy the API first. Do not deploy the web service until the API deployment reaches `READY`, because the browser bundle will permanently contain the public API hostname for that image.

## Attach domains

A Rundea domain can be attached only after the corresponding service has a `READY` deployment.

Create these domain mappings after readiness:

```json
{ "hostname": "api.signalkit.sys.bachopus.com", "serviceName": "signalkit-api" }
```

```json
{ "hostname": "signalkit.sys.bachopus.com", "serviceName": "signalkit-web" }
```

Rundea then reconciles the same managed Caddy instance that already owns `rundea.bachopus.com`. The reserved Control Plane route is merged with application routes and cannot be claimed by an application service. DNS must point both SignalKit hostnames at the selected Rundea node before public TLS verification can succeed.

## GitHub autodeploy follow-up

The repository already contains a GitHub autodeploy module. This change makes its stored configuration preserve `buildArgs` so a future push-triggered rebuild can reproduce the web image correctly.

However, the current Control Plane entrypoint does not register the autodeploy routes. Do not treat GitHub autodeploy as part of the initial SignalKit dogfood gate. Route registration, webhook-secret configuration, and exact-SHA webhook acceptance should be completed as a separate follow-up before enabling automatic deployments.

## Acceptance gate

The initial dogfood migration is complete only when all of the following are true:

1. Rundea Control Plane containing the build-args contract is deployed and the selected node runs Rundea Agent `0.1.2` or later.
2. `https://rundea.bachopus.com/health` remains healthy after managed-ingress takeover and after each SignalKit domain reconciliation.
3. `signalkit-api` reaches `READY` from pinned commit `589bdd739eb2c27f1386a7a49faa36eeb3ec6a53` using the existing database and external Redis.
4. `https://api.signalkit.sys.bachopus.com/health` succeeds through Rundea managed ingress.
5. `signalkit-web` reaches `READY` from the same pinned commit with `NEXT_PUBLIC_API_URL` supplied through Rundea build args.
6. `https://signalkit.sys.bachopus.com` loads and browser API requests reach the Rundea-hosted API.
7. Rollback restores a retained previous image without rebuilding it.
8. No secret is supplied through `buildArgs` or written to deployment logs.
9. Neither SignalKit container owns or publishes public host ports `80/443`.

Known follow-ups: durable volumes/object storage for SignalKit exports and GitHub autodeploy route wiring are separate Rundea capabilities and are not silently emulated in this migration.
