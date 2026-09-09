# ADR 0016 — Versioned Agent release from verified main

Status: Accepted

## Context

Rundea now has a one-command node bootstrap path and an authenticated Control Plane release provider, but the Agent binary still needs a real immutable distribution boundary before an external VPS can be treated as a production-candidate node.

The previous `agent-release` workflow was tag-driven. That leaves a manual action between a green pull request and the exact commit that becomes the binary release. A mistyped or misplaced tag could therefore publish a different commit than the one reviewed and accepted.

## Decision

`apps/agent/VERSION` is the single release declaration for the Agent. It contains an exact semantic version `X.Y.Z`.

The release sequence is:

1. change `apps/agent/VERSION` in a pull request;
2. ordinary TypeScript/Go CI and full node acceptance must be green on the final PR head;
3. merge the PR into `main`;
4. the `agent-release` workflow is triggered by the `VERSION` change on `main`;
5. build static Linux amd64 and arm64 Agent binaries from the exact merge `GITHUB_SHA`;
6. generate and verify `SHA256SUMS`;
7. create annotated tag `agent-vX.Y.Z` on that exact merge SHA;
8. publish immutable GitHub Release assets without overwriting any existing release;
9. download the published assets again and verify their SHA-256 manifest.

No human-created release tag is required for the normal release path.

## Immutability and retry semantics

An existing `agent-vX.Y.Z` tag may never be moved to another commit.

On a pull request, CI rejects a `VERSION` whose release tag already exists.

On the post-merge release run:

- if the tag does not exist, the workflow creates it at the exact merge SHA;
- if the tag already exists at the same SHA, the workflow may resume after a partial previous run;
- if the tag exists at any other SHA, the workflow fails;
- if the GitHub Release already exists, its assets are not replaced;
- every successful run finishes by downloading and checksum-verifying the published release assets.

This allows recovery from a workflow interruption between tag creation and release publication without sacrificing tag immutability.

## Trust boundary

The GitHub Release is a private binary distribution source, not a credential passed to the VPS.

A production node receives the Agent through the authenticated Rundea Control Plane bootstrap path. The Control Plane release provider authenticates to GitHub, obtains the selected release asset, verifies it against `SHA256SUMS`, and serves it through the bounded one-time bootstrap flow already defined by the node bootstrap architecture.

The VPS does not receive a GitHub PAT, GitHub App private key, or installation token.

The release workflow's own post-publication download/checksum gate proves that the GitHub Release assets exist and match their published manifest. A claim that the complete Control Plane release-provider path works against the real private GitHub Release still requires live acceptance with the Rundea GitHub App configuration.

## Acceptance gates

Before `agent-v0.1.0` is treated as the first production-candidate Agent release:

- release PR CI is green;
- full node acceptance is green on the same PR head;
- merge to `main` is green post-merge;
- `agent-release` succeeds from the exact merge SHA;
- tag `agent-v0.1.0` resolves to that exact merge SHA;
- both Linux architecture assets and `SHA256SUMS` exist and verify;
- the real Rundea Control Plane release provider successfully obtains and verifies the release;
- a clean external Linux VPS completes one-command bootstrap and is reported `ONLINE` server-authoritatively;
- the external node completes deploy, HTTPS, zero-downtime replacement and rollback acceptance.

## Relationship to the AI/MCP roadmap

This ADR is part of the existing production-readiness plan and is not replaced by the additive AI/MCP/Guided Mode roadmap.

The future typed operation layer, MCP server and embedded AI must consume the same validated Control Plane operations. They do not receive a separate Agent installation or release bypass. Agent release/bootstrap remains an infrastructure trust boundary beneath all future UI, API and AI clients.
