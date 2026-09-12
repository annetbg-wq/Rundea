# 0018 — Docker build arguments

## Decision

Rundea deployments support an optional `build.args` map in the Control Plane → Agent deployment contract. The Control Plane persists the map as `deployments.build_args` and GitHub autodeploy configuration persists it as `service_autodeploys.build_args` so push-triggered deployments reproduce the same build.

The Agent validates the map again at the trust boundary and translates entries into deterministic, key-sorted `docker build --build-arg KEY=value` arguments.

## Validation contract

- maximum 64 entries;
- names must match `[A-Za-z_][A-Za-z0-9_]*` and be at most 128 bytes;
- values must be strings, at most 4096 bytes, and contain no CR, LF or NUL;
- an omitted map is equivalent to `{}`.

## Security boundary

Docker build arguments are **not secrets**. They can be exposed by Docker image history, Dockerfile instructions, build output or host process inspection. Rundea must not advertise `buildArgs` as a secret store.

Use encrypted Rundea service variables for runtime secrets. Build-time secrets require a separate BuildKit-secret design and are intentionally outside this contract.

## Why this exists

Some frameworks compile public configuration into browser bundles. SignalKit's Next.js image is the first dogfood case: `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_DEFAULT_LOCALE` must exist during `docker build`, while API credentials remain runtime-only encrypted service variables.

## Rollback behavior

Rollback does not rebuild an image and therefore does not consume build args. It reuses the retained immutable image identity from the target deployment.
