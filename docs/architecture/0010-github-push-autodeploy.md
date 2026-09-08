# ADR 0010: Signed GitHub push autodeploy

## Status

Accepted for v0.

## Context

Rundea already supports manual deployment of an exact Git commit SHA, but a Railway-like workflow requires a push to create a deployment without an operator copying a ref into the UI. The Control Plane is the correct trust boundary for GitHub events: nodes must not receive a webhook secret or a long-lived GitHub credential.

Private repository access is intentionally separate. A GitHub webhook proves that GitHub emitted an event; it does not by itself authorize a node to clone a private repository.

## Decision

Rundea stores a per-service autodeploy configuration containing:

- target node;
- canonical GitHub repository;
- source branch;
- optional Dockerfile path;
- container/host ports;
- healthcheck path;
- enabled state.

The public webhook endpoint accepts GitHub events only when `RUNDEA_GITHUB_WEBHOOK_SECRET` is configured and `X-Hub-Signature-256` matches an HMAC-SHA256 computed over the exact raw HTTP request body.

For `push` events Rundea:

1. validates `X-GitHub-Delivery` and uses it as the delivery idempotency key;
2. validates `repository.full_name` and `refs/heads/<branch>`;
3. requires `after` to be a full 40-hex Git SHA;
4. matches enabled autodeploy configurations by canonical repository + branch;
5. creates each deployment transactionally using the **stored repository URL**, never a clone URL supplied by the webhook payload;
6. sets `source_ref` to the exact `after` SHA;
7. captures the immutable encrypted environment snapshot in the same transaction;
8. records delivery-to-deployment links for observability;
9. dispatches queued deployments after commit.

Branch deletion events are recorded as ignored. Unsupported GitHub event types are ignored without creating deployments.

## Idempotency and replay boundary

`X-GitHub-Delivery` is persisted with a primary-key constraint. A retry/redelivery with the same delivery id cannot create a second deployment.

The delivery header is not part of GitHub's HMAC body signature, so HTTPS remains part of the trust boundary. Rundea does not log webhook signatures or raw payload bodies. A future hardened public edge may additionally enforce timestamp/replay windows or provider-specific request metadata.

## Raw-body parsing

Signature verification must occur against the exact bytes GitHub sent. The webhook is therefore registered in an encapsulated Fastify scope with a buffer JSON parser. Ordinary Control Plane JSON routes keep Fastify's normal parsed-object behavior.

## Schema

Migration `006_github_autodeploy.sql` owns:

- `service_autodeploys`;
- `github_webhook_deliveries`;
- `github_webhook_deployments`.

The current migration runner is intentionally primitive. Until it is replaced with versioned migration bookkeeping, the feature registration also executes the same idempotent migration file and all feature routes await that bootstrap promise. There is one DDL source, not duplicated schema strings.

## Acceptance contract

The node acceptance workflow must:

- configure autodeploy for the fixture service;
- send a correctly signed GitHub `push` payload;
- assert exactly one triggered deployment;
- replay the same `X-GitHub-Delivery` and assert idempotency;
- assert delivery observability links to the deployment;
- wait for the webhook-created deployment to reach `READY` on a real Docker runner;
- continue through Restart and exact Rollback checks.

## Not included

This ADR does not provide:

- GitHub App installation creation or OAuth setup;
- private-repository source delivery;
- short-lived installation-token brokering;
- automatic GitHub webhook registration on customer repositories;
- cross-provider SCM support.

Those require a separate GitHub App/private-source trust design.
