# ADR 0010: Signed GitHub push autodeploy

## Status

Accepted. Registry-first canonical path updated in 2026.

## Context

Rundea supports automatic deployment from signed GitHub push events. The Control Plane remains the trust boundary for GitHub events: production nodes must not receive webhook secrets, GitHub App private keys, or build credentials.

The original v0 path created source-build deployments directly from a push. That is no longer the canonical production design because it can move Docker build CPU/RAM pressure onto the production node.

## Decision

Rundea stores a per-service autodeploy configuration containing the canonical service identity, target node, GitHub repository, branch, build arguments, runtime port, healthcheck path and enabled state.

The public webhook endpoint accepts GitHub events only when `RUNDEA_GITHUB_WEBHOOK_SECRET` is configured and `X-Hub-Signature-256` matches HMAC-SHA256 over the exact raw request body.

For a canonical service push Rundea:

1. validates the delivery id, raw-body signature, repository, branch and exact 40-character `after` commit SHA;
2. matches enabled canonical autodeploy configuration by repository + branch;
3. creates a Build Engine job for that exact commit SHA with `deploy_after_push=true`;
4. records delivery-to-build provenance transactionally;
5. lets an isolated Builder fetch source through the Control Plane, build with explicit CPU/RAM/time limits, and push to the configured registry;
6. persists the immutable `repository@sha256:...` result;
7. atomically creates the runtime deployment only after the immutable artifact exists;
8. dispatches the production Agent a prebuilt-image command;
9. requires the Agent to pull the immutable digest, run the candidate, pass the existing healthcheck and only then switch the stable route.

The canonical GitHub path therefore is:

```
GitHub push
  -> signed Control Plane webhook
  -> Build Engine
  -> Registry @sha256
  -> prebuilt deployment
  -> production Agent pull
  -> candidate
  -> healthcheck
  -> READY
```

No canonical GitHub push may cause a production Agent to run `docker build`.

A bounded hidden/prototype compatibility path remains for legacy service-name-only autodeploy records that do not have a canonical `service_source_configs` identity. User-facing canonical services always take the Build Engine path.

## Idempotency and replay boundary

`X-GitHub-Delivery` is persisted with a primary-key constraint. Rundea also stores a unique SHA-256 fingerprint of the already signature-verified raw body because the delivery header itself is not included in GitHub's body HMAC.

Replaying the same delivery, or the same signed body under another delivery id, cannot enqueue a second build.

## Provenance

Migration `034_github_push_build_pipeline.sql` adds `github_webhook_builds`. A delivery is linked to the exact canonical `service_id` and `build_id`.

The build record retains the source commit SHA and immutable registry artifact. The runtime deployment retains both the source SHA and artifact digest, so the chain from GitHub event to running image is auditable.

## Failure behavior

A failed build does not create a runtime deployment.

If the configured production node is offline when a completed build attempts handoff, Rundea does not silently choose another node.

If a candidate runtime fails its healthcheck, the existing READY route remains active.

## Acceptance contract

The node acceptance workflow must prove that a signed canonical GitHub push:

- enqueues exactly one Build Engine job and no direct canonical source-build deployment;
- builds outside the production Agent;
- persists an immutable registry digest;
- automatically creates the linked deployment;
- preserves the exact GitHub commit SHA as provenance;
- reaches READY through the prebuilt-image Agent path;
- records an Agent log proving use of the immutable prebuilt artifact;
- does not emit the old source-broker/local-build log on the production Agent;
- remains idempotent on duplicate webhook delivery.

## Still separate

Private-registry pull authentication on production nodes must use scoped, preferably short-lived credentials. Automatic GitHub webhook installation on customer repositories and cross-provider SCM support remain separate work.
