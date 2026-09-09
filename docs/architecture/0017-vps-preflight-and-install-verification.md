# ADR 0017: VPS preflight and server-authoritative install verification

Status: Accepted

## Context

A one-command node installer runs as root and crosses an irreversible credential boundary when it exchanges a fresh bootstrap credential for the node's permanent Agent credential. Failing after that exchange is recoverable, but failing before it should not consume the one-time bootstrap token.

A process-level signal such as `systemctl start` is also insufficient evidence that a Rundea node is usable. The Agent may be running while DNS, TLS, firewall, credentials, or the outbound WebSocket path are broken. Installation success therefore needs to be defined by the Control Plane, not by the local process manager.

## Decision

The installer performs a local VPS preflight before it consumes the bootstrap credential.

Hard preflight failures are:

- installer is not running as root;
- Control Plane URL is not HTTPS;
- required host tools are missing;
- host is not systemd-based;
- Docker daemon is unavailable to root;
- CPU architecture is not linux/amd64 or linux/arm64;
- available root-filesystem space is below `RUNDEA_MIN_FREE_DISK_MB` (2048 MB by default, configurable but never below 512 MB);
- the exact Control Plane `/health` endpoint cannot be reached using HTTPS/TLS 1.2+ without redirects.

Existing TCP listeners on 80/443 are reported as a warning rather than a bootstrap failure. A node may be useful before public ingress is configured, but the conflict must not remain invisible.

The installer keeps the existing commit point:

1. preflight the VPS;
2. download the pinned Agent binary;
3. verify SHA-256;
4. install the binary, local permanent credential and systemd unit;
5. exchange the one-time bootstrap credential for the prepared permanent credential;
6. start the Agent;
7. wait for server-authoritative node state.

The Control Plane exposes `GET /v0/nodes/:nodeId/self/status`. It accepts only the permanent credential for that exact node. A bootstrap credential cannot call the endpoint and one node credential cannot inspect another node.

The installer exits successfully only after that endpoint returns `ONLINE`. `systemctl` process state alone is not a success condition.

If the Agent does not become ONLINE after the credential exchange, installation exits non-zero but leaves `/etc/rundea/agent.env` intact. The operator can repair networking or host configuration and restart `rundea-agent` without creating a new bootstrap credential.

## Security properties

- preflight failures do not consume the one-time bootstrap credential;
- credentials are kept out of curl process arguments through private temporary curl configuration files;
- self-status reveals only the authenticated node's coarse ONLINE/OFFLINE state;
- self-status cannot be authenticated with a bootstrap credential;
- server state, not local process state, is authoritative for installation success;
- HTTPS redirect following remains disabled for Control Plane bootstrap/self-verification requests.

## Acceptance contract

CI must prove at minimum:

- bootstrap credential is rejected by Agent WebSocket and self-status;
- bootstrap exchange remains one-time;
- permanent credential authenticates the Agent;
- the exact node becomes ONLINE after the real compiled Agent connects;
- permanent self-status returns ONLINE while the Agent is connected;
- after Agent disconnect reconciliation, permanent self-status returns OFFLINE;
- the existing deployment, failed-candidate, crash/reconnect, zero-downtime and metrics acceptance scenarios remain green.

## Boundary

This decision establishes deterministic host readiness checks and end-to-end installation verification. It does not certify every VPS provider, prove public DNS/ingress on an Internet host, or replace the separate real external-VPS acceptance gate.
