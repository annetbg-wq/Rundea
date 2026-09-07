# ADR 0005: Encrypted service variables and deterministic Node auto-build

Status: Accepted

## Context

The first proof workload, Sendina, currently has no Dockerfile. It uses Node.js >=24, `npm run build`, `npm start`, and Railway metadata declaring `/api/health`. It also requires deployment-specific values such as `APP_TOKEN`, `DATABASE_URL`, mail credentials and encryption keys.

Forcing every workload to add a Rundea-specific Dockerfile would make the product materially worse than the PaaS experience it is intended to replace. Storing those runtime values in plaintext would be unacceptable.

## Decision: variables and secrets

Control Plane stores both ordinary variables and secrets encrypted at rest with AES-256-GCM. `RUNDEA_MASTER_KEY` is a 32-byte key supplied to the Control Plane from external secret configuration and is never stored in the repository.

Each encrypted row stores a random nonce/IV, ciphertext and authentication tag. The value type is versioned so encryption can be migrated later.

`secret=true` changes read semantics, not storage encryption:

- secret values are never returned by the read API;
- non-secret variable values may be returned to the authenticated control-plane client;
- both are encrypted in PostgreSQL;
- all values are decrypted only when a deployment command is being prepared.

`HOST`, `PORT` and `RUNDEA_*` are reserved. Rundea owns `HOST=0.0.0.0` and sets `PORT` to the selected container port.

The v0 transport rejects multiline values and NUL bytes. This keeps Docker env-file semantics explicit and diagnosable rather than implementing an ambiguous escaping dialect.

## Decision: node transport and trust boundary

The authenticated Agent WebSocket carries the deployment environment to the selected node. Installed production nodes require an HTTPS Control Plane URL, therefore the WebSocket is protected by TLS in the supported production install path.

The Agent writes a `0600` temporary env file, passes it to `docker run --env-file`, and removes it immediately after Docker consumes it. The installer also purges stale `runtime.env` files before Agent startup, and each new deployment removes stale transport files left by an interrupted predecessor.

This does **not** make a hostile node safe. The Agent and Docker daemon have privileged access to the VPS. A root user or principal with Docker access can inspect the environment of a running container. BYOVPS therefore places the node operator inside the workload trust boundary. Rundea protects secrets from database disclosure, UI/API readback, ordinary filesystem users and accidental command-line/log exposure; it cannot protect a workload from the root administrator of the machine executing that workload.

## Decision: Node.js auto-build

When no Dockerfile is specified:

1. use a repository-root Dockerfile if one exists;
2. otherwise, if `package.json` has a `start` script, generate a Node.js build Dockerfile;
3. use `npm ci` when `package-lock.json` exists, otherwise `npm install`;
4. run `npm run build` when a build script exists;
5. start with `npm start`.

The generated base image is pinned to a specific Node 24.20.0 multi-platform image digest instead of a floating `node:24` tag. This makes the base image reproducible for a given Rundea release. The source ref and application lockfile complete the v0 build inputs.

Dev dependencies are intentionally installed during this v0 Node build. Some valid workloads, including the current Sendina deployment, use a tool such as `tsx` from devDependencies in their `start` command. Pruning devDependencies before startup would break those workloads.

## Decision: healthcheck compatibility

An explicitly configured healthcheck path wins. If it is omitted, the Agent may read `railway.json` and reuse `deploy.healthcheckPath`; otherwise it falls back to `/health`.

Reading this small piece of migration metadata is a compatibility convenience, not a dependency on Railway. Rundea owns the resulting deployment state and health decision.

## Consequences

This slice makes Sendina-shaped Node workloads deployable without repository modifications, while keeping the runtime pipeline explicit. Private GitHub App source delivery, Caddy/HTTPS, immutable rollback and node egress qualification remain independent vertical slices.
