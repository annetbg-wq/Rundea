# SignalKit dogfood deployment on Rundea

SignalKit is the first non-trivial Rundea dogfood workload. It exercises a monorepo, two independent Dockerfiles, build-time public configuration, runtime secrets, external stateful dependencies, HTTP health checks, managed domains, and GitHub autodeploy.

## Source

- Repository: `https://github.com/vkpro72ai-create/signalkit.git`
- Initial branch: `deploy/pdf-export-and-workspace-fix`
- Production source should move to `main` only after the deployment branch is reconciled and merged in SignalKit.

For one-off deployments a mutable branch may use direct Git delivery. GitHub push autodeploy pins the deployment to the exact pushed commit SHA and uses Rundea brokered source delivery.

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

The API Dockerfile intentionally does not run Prisma migrations during container startup. Before the first Rundea deployment, confirm the existing SignalKit database already contains the migrations expected by the selected commit. If it does not, run the migration job separately before routing production traffic.

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

First choose an ONLINE Rundea node and free non-reserved host ports. The examples deliberately use placeholders because host ports are node-specific and must not be invented.

API deployment request:

```json
{
  "serviceName": "signalkit-api",
  "nodeId": "<NODE_ID>",
  "sourceRepository": "https://github.com/vkpro72ai-create/signalkit.git",
  "sourceRef": "deploy/pdf-export-and-workspace-fix",
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
  "sourceRef": "deploy/pdf-export-and-workspace-fix",
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

Rundea then reconciles managed Caddy ingress to the READY deployment's host port. DNS must point both hostnames at the selected Rundea node before public TLS verification can succeed.

## GitHub autodeploy after the first healthy release

Configure each service against the same SignalKit branch. Build args belong to the web autodeploy configuration so every GitHub-triggered rebuild is reproducible.

Web autodeploy configuration shape:

```json
{
  "nodeId": "<NODE_ID>",
  "repository": "https://github.com/vkpro72ai-create/signalkit",
  "branch": "deploy/pdf-export-and-workspace-fix",
  "dockerfile": "apps/web/Dockerfile",
  "buildArgs": {
    "NEXT_PUBLIC_API_URL": "https://api.signalkit.sys.bachopus.com",
    "NEXT_PUBLIC_DEFAULT_LOCALE": "en"
  },
  "containerPort": 3000,
  "hostPort": "<WEB_HOST_PORT>",
  "healthcheckPath": "/",
  "enabled": true
}
```

API autodeploy uses the same shape with `apps/api/Dockerfile`, `{}` build args, port `4000`, the API host port, and `/health`.

## Acceptance gate

The dogfood migration is complete only when all of the following are true:

1. Rundea Agent and Control Plane versions containing the build-args contract are deployed.
2. `signalkit-api` reaches `READY` using the existing database and external Redis.
3. `https://api.signalkit.sys.bachopus.com/health` succeeds through managed ingress.
4. `signalkit-web` reaches `READY` with `NEXT_PUBLIC_API_URL` supplied through Rundea build args.
5. `https://signalkit.sys.bachopus.com` loads and browser API requests reach the Rundea-hosted API.
6. A GitHub push creates exact-SHA autodeployments and preserves the web build args.
7. Rollback restores the retained previous image without rebuilding it.
8. No secret is supplied through `buildArgs` or written to deployment logs.

Known follow-up: durable volumes/object storage for SignalKit exports are a separate Rundea capability and are not silently emulated in this migration.
