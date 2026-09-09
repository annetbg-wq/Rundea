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

`GET /v0/install.sh` is public and contains no secret. It is the checked-in installer source, served with `no-store`; node credentials are supplied separately by the operator and authenticated endpoints.

## Decision: bootstrap credential is not an Agent credential

`POST /v0/nodes` continues to return a plaintext credential once, but a fresh node stores that value only in `bootstrap_token_hash` with a 30-minute expiry. The normal `nodes.token_hash` Agent credential is deliberately unavailable until exchange completes.

The database insert trigger preserves compatibility with the existing node-creation API while enforcing this trust boundary for every new node. Existing enrolled nodes are untouched and keep their active `token_hash` credentials.

This separation is deliberate:

- the bootstrap credential may authenticate only the release-download and bootstrap-exchange path while it is unexpired and the node has never connected;
- `/v0/agent/ws` authenticates only `nodes.token_hash`, so a copied bootstrap command cannot impersonate a live Agent or receive deployment commands;
- a successful exchange writes the new permanent hash to `nodes.token_hash` and clears both bootstrap columns atomically;
- the consumed bootstrap value cannot authenticate either release or Agent endpoints afterward.

## Decision: consume bootstrap only after local preparation succeeds

The installer does not rotate credentials before it knows the node can actually be installed.

The order is:

1. authenticate the release-download endpoints with the bootstrap credential;
2. download the exact configured architecture binary and expected SHA-256;
3. verify SHA-256 locally;
4. install the verified binary and prepare the private Agent environment plus systemd unit;
5. generate a fresh 256-bit permanent Agent credential locally from `/dev/urandom` and persist it in `/etc/rundea/agent.env` with mode `0600`;
6. authenticate `POST /v0/nodes/:nodeId/bootstrap/exchange` with the bootstrap credential and send the permanent credential in the HTTPS request body;
7. atomically replace the server-side Agent credential hash and clear the bootstrap hash/expiry;
8. only then enable and start the Agent service.

If download, checksum verification, binary installation or unit preparation fails, the bootstrap token is not consumed and the command can be retried. If a later systemd operation fails after exchange, the permanent credential is already durable on the node, so recovery does not depend on the consumed bootstrap value.

The exchange is accepted only while the node is still `OFFLINE`, has never connected, has an unconsumed bootstrap hash and the bootstrap expiry has not passed. This prevents a copied bootstrap command from rotating an already enrolled node.

The Control Plane stores only SHA-256 hashes of node credentials. It never stores either plaintext credential.

## Installer verification

The installer:

- requires an `https://` Control Plane;
- detects `linux/amd64` or `linux/arm64`;
- keeps credentials in mode-`0600` curl config files rather than command-line arguments;
- refuses redirects from authenticated Rundea release endpoints;
- verifies SHA-256 locally before installing `/usr/local/bin/rundea-agent`;
- starts systemd only after the one-time credential exchange has committed.

An explicit `RUNDEA_AGENT_URL` + `RUNDEA_AGENT_SHA256` pair remains supported as a bring-your-own immutable distribution override, but checksum verification remains mandatory and bootstrap exchange still happens only after local preparation succeeds.

## Executable acceptance

`node-acceptance` proves the credential lifecycle against real PostgreSQL, the running Control Plane and the real compiled Agent:

- create a fresh node;
- prove the bootstrap credential can reach the authenticated release path;
- start the real Agent with that bootstrap credential and prove the node remains `OFFLINE`;
- exchange the bootstrap credential once;
- prove replay with the old credential fails;
- prove the old credential no longer authenticates the release path;
- prove the permanent credential authenticates the release path;
- start the real Agent with the permanent credential and prove the node becomes `ONLINE`.

The ordinary CI also validates installer shell syntax and the release-provider unit tests cover repository-scoped GitHub App permissions, credential stripping on release redirects, redirect-host restrictions and binary checksum mismatch.

## External gate

This ADR does **not** claim that an external VPS is already production-accepted. Before that claim, Rundea still needs:

1. an actual immutable `agent-v*` release created from a green main commit;
2. production Control Plane configuration for release repository/tag and public HTTPS origin;
3. a fresh external Linux VPS installed through the generated one-command bootstrap path;
4. the normal Rundea deploy, HTTPS ingress, restart, rollback and reboot/reconnect acceptance executed on that exact node.
