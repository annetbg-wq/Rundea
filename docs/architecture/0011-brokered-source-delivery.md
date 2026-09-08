# ADR 0011: Brokered source delivery

## Status

Accepted for v0.

## Context

Direct `git clone` is sufficient for public repositories but is the wrong trust boundary for private source. Giving a VPS a long-lived PAT or a GitHub App installation token would expand the blast radius of a node compromise and couple the Agent to one source-control provider.

Rundea needs a provider-neutral delivery contract where source-control credentials remain in the Control Plane.

## Decision

Deployments support two source-delivery modes:

- `DIRECT`: the Agent clones an HTTPS public GitHub repository as before;
- `BROKER`: the Control Plane supplies an exact source archive through a short-lived deployment-scoped ticket.

`BROKER` requires an exact full Git commit SHA. Branch names are deliberately not accepted because the archive identity must be immutable before dispatch.

### Ticket lifecycle

The Control Plane issues the broker ticket only when a queued deployment is actually leased for dispatch.

The ticket:

- is a 256-bit random opaque value;
- is persisted only as SHA-256;
- is bound to one deployment and one node;
- expires after two minutes;
- is single-use;
- is replaced on a later re-dispatch, invalidating the previous ticket;
- is sent to the Agent only inside the authenticated Agent command;
- is sent back to the source endpoint only in the `Authorization` header, never in a URL.

The broker endpoint also requires the node id header to match the ticket binding.

### Agent contract

A brokered Agent command contains:

- `mode: bundle`;
- exact source SHA;
- one-time ticket;
- optional Dockerfile path;
- no repository clone URL;
- no GitHub credential.

The Agent downloads `/v0/source-bundles/<deploymentId>` from its configured Control Plane and verifies the `X-Rundea-Source-Sha` response identity before extracting.

### Archive safety

The Agent treats the source archive as hostile input even though it came through Rundea.

The v0 extractor:

- permits one archive root only and strips it;
- rejects absolute paths and `..` traversal;
- rejects duplicate paths;
- rejects symlinks and hardlinks;
- rejects special tar entry types;
- caps compressed bytes, uncompressed bytes, per-file bytes and entry count;
- preserves only ordinary executable bits, not arbitrary ownership/special mode bits.

Symlink support can be introduced later only with a confinement design that proves subsequent archive entries cannot write through a link outside the workspace.

## Upstream adapters

The current proof fetches a public exact-SHA GitHub archive in the Control Plane.

Private GitHub support will add a GitHub App adapter that mints a short-lived installation token inside the Control Plane and uses it only for the upstream archive request. That token must never be serialized into an Agent command, deployment event, log or database field intended for nodes.

The same broker contract can later support GitLab, Bitbucket, object-storage artifacts or Rundea build-cache artifacts without changing the Agent trust model.

## Failure semantics

A ticket is consumed before the upstream archive is returned. If the upstream archive fetch fails, the deployment fails rather than reusing the same capability. A later deployment or re-dispatch receives a new ticket.

This prefers a small availability cost over replayable source capabilities.

## Acceptance contract

The full node acceptance workflow must keep the existing direct GitHub push deployment and additionally create a second exact-SHA deployment with `sourceDelivery: BROKER`.

The brokered deployment must:

- reach `READY` on the real Docker runner;
- persist the exact expected source SHA and artifact identity;
- emit the Agent system event proving broker delivery was used;
- continue to participate in Restart/Rollback history correctly.

## Not included

This ADR does not yet claim:

- private GitHub repository acceptance;
- GitHub App JWT/installation-token minting;
- source bundles larger than the v0 safety limits;
- symlink-containing repositories;
- source bundle caching/object-storage offload;
- cross-provider SCM adapters.
