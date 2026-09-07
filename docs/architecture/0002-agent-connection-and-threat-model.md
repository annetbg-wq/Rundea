# ADR 0002: Outbound agent connection and trust boundary

Status: Accepted

## Decision

A node agent initiates an outbound TLS WebSocket to the control plane. Rundea does not require users to expose SSH or an administrative agent port to the public internet.

A node receives a random enrollment token once. The control plane stores only a SHA-256 token hash. The token authenticates the connection; future production hardening should rotate it into short-lived credentials and mTLS without changing the direction of trust.

## Threat model

The agent is a high-privilege component because it can create containers and invoke Docker. A compromised agent/node is considered a compromise of workloads on that node, but must not automatically grant access to other nodes or global platform secrets.

User containers are untrusted. They must not receive the Docker socket, node enrollment token, control-plane bootstrap credentials or credentials for unrelated services.

The control plane must authenticate every agent connection, scope commands to the authenticated node, validate state transitions, cap event sizes and audit privileged operations.

## Secrets

Service secrets are intentionally absent from the first vertical slice. The production path must use encrypted-at-rest secret material in the control plane and only deliver plaintext to the assigned node at deployment time. Read APIs and UI must never return secret plaintext after creation.
