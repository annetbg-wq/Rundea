# ADR 0016: Agent release distribution and one-time node bootstrap

Status: Accepted

## Context

Rundea can already enroll a node, run the Agent, deploy exact revisions and recover runtime state. The remaining bootstrap gap is distribution: the source repository is private, so a fresh VPS must not receive a long-lived GitHub credential merely to download the Rundea Agent.

The token returned by `POST /v0/nodes` is also copied into a shell command. Treating that copied value as the permanent Agent credential would unnecessarily preserve a credential that may remain in terminal history or an operator clipboard.

## Decision: immutable tagged Agent releases

Agent binaries are published from tags matching `agent-v*` by `.github/workflows/agent-release.yml`.

A release contains exactly the artifacts required by the installer:

- `rundea-agent-linux-amd64`;
- `rundea-agent-linux-arm64`;
- `SHA256SUMS`.

The workflow builds static Linux binaries, generates the manifest, verifies it before upload and refuses to overwrite an already existing release for the same tag. The configured Control Plane always resolves one explicit `RUNDEA_AGENT_RELEASE_TAG`; `latest` is not part of the trust contract.

## Decision: GitHub credentials stop at the Control Plane

The release repository may remain private. The Control Plane uses the existing Rundea GitHub App configuration to:

1. resolve the App installation for `RUNDEA_AGENT_RELEASE_REPOSITORY`;
2. mint a short-lived installation token restricted to that repository and `contents:read`;
3. resolve the exact configured release tag;
4. fetch release asset metadata and the `SHA256SUMS` asset;
5. download the selected architecture asset;
6. remove GitHub authorization before following a GitHub-controlled release CDN redirect;
7. calculate SHA-256 itself and require it to match the release manifest before the asset can be served to a node.

The GitHub installation token is never sent to the VPS, written to the deployment environment or persisted in PostgreSQL.

Release redirects are restricted to HTTPS GitHub-controlled `githubusercontent.com` asset hosts. Arbitrary redirect hosts are rejected.

## Decision: Control Plane is the node distribution boundary

A node downloads through authenticated Rundea endpoints:

- `GET /v0/agent/releases/:architecture/sha256`;
- `GET /v0/agent/releases/:architecture`.

Supported v0 architectures are `amd64` and `arm64` only. The Control Plane serves a binary only after upstream release verification. It does not redirect the node to GitHub.

`GET /v0/install.sh` is public and contains no secret. It is the checked-in installer source, served with `no-store`; the bootstrap and permanent credentials are supplied separately by the operator and authenticated endpoints.

## Decision: copied token is consumed during bootstrap

`POST /v0/nodes` continues to return a plaintext credential once. For a fresh node this value is treated as a **bootstrap credential**.

The installer:

1. generates a new 256-bit permanent Agent credential locally from `/dev/urandom`;
2. authenticates `POST /v0/nodes/:nodeId/bootstrap/exchange` with the copied bootstrap credential;
3. sends the locally generated permanent credential over the HTTPS body;
4. the Control Plane atomically replaces the stored token hash;
5. the copied bootstrap credential immediately stops authenticating;
6. only the permanent credential is written to `/etc/rundea/agent.env` with mode `0600`.

The exchange is accepted only while the node is still `OFFLINE`, has never connected, and was created less than 30 minutes earlier. This prevents a copied bootstrap command from being used to rotate an already enrolled node.

The Control Plane stores only SHA-256 hashes of node credentials. It never stores either plaintext credential.

## Installer verification

The installer:

- requires an `https://` Control Plane;
- detects `linux/amd64` or `linux/arm64`;
- downloads the expected checksum and Agent binary using the permanent node credential without placing that credential on the curl command line;
- refuses redirects from the authenticated Rundea binary endpoints;
- verifies SHA-256 locally before installing `/usr/local/bin/rundea-agent`;
- writes the existing systemd unit only after verification succeeds.

An explicit `RUNDEA_AGENT_URL` + `RUNDEA_AGENT_SHA256` pair remains supported as a bring-your-own immutable distribution override, but checksum verification remains mandatory.

## Executable acceptance

`node-acceptance` proves the credential lifecycle against real PostgreSQL and the running Control Plane:

- create a node;
- exchange the returned bootstrap credential once;
- prove replay with the old credential fails;
- prove the old credential no longer authenticates a node endpoint;
- prove the permanent credential does authenticate before release-provider configuration is evaluated.

The ordinary CI also validates installer shell syntax and the release-provider unit tests cover repository-scoped GitHub App permissions, credential stripping on release redirects, redirect-host restrictions and binary checksum mismatch.

## External gate

This ADR does **not** claim that an external VPS is already production-accepted. Before that claim, Rundea still needs:

1. an actual immutable `agent-v*` release created from a green main commit;
2. production Control Plane configuration for release repository/tag and public HTTPS origin;
3. a fresh external Linux VPS installed through the generated one-command bootstrap path;
4. the normal Rundea deploy, HTTPS ingress, restart, rollback and reboot/reconnect acceptance executed on that exact node.
