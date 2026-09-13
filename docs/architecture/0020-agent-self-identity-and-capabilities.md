# 0020 — Agent self-identity and capability contract

Status: accepted for RUNDEA DOGFOOD GATE v1 foundation.

## Context

Rundea previously inferred Agent feature support from a version string or by inspecting strings embedded in the compiled binary. That is not a protocol contract. It also made managed-ingress takeover depend on `strings`/binutils and allowed the Control Plane to treat an authenticated but incompatible Agent as usable.

The dogfood gate requires real capability negotiation. The binary therefore needs an authoritative identity that bootstrap, takeover and the Control Plane can consume without implementation inspection.

## Decision

Every Rundea Agent binary self-reports:

- `agentVersion` from the version file embedded at compile time;
- `buildSha`, injected from the exact immutable source commit for release/live builds;
- a sorted set of declared protocol capabilities.

The initial declared capabilities are:

- `buildArgs`;
- `managedIngress`;
- `runtimeMetrics`;
- `runtimeRecovery`;
- `safePromotion`.

The binary exposes local preflight commands:

- `--identity` — JSON identity;
- `--version`;
- `--build-sha`;
- `--capabilities`;
- `--require-capability=<name>` — exit 0 only when the capability is declared.

Release binaries and the Agent bundled into the live API image receive the exact Git commit SHA through the Go linker. A local development build reports the explicit `development` sentinel rather than pretending to have an immutable source identity.

The installer MUST checksum the downloaded binary and then verify its identity and baseline capabilities before consuming the one-time bootstrap credential. Managed-ingress takeover MUST query `managedIngress` through the Agent contract and MUST NOT inspect binary strings or require binutils.

## Next protocol step

This ADR establishes the binary identity contract and local preflight. It does **not** by itself make a node dispatch-compatible.

The next Foundation slice must transmit the same identity as the first authenticated WebSocket hello, persist it on the node record, and keep the node non-dispatchable until the Control Plane validates required capabilities. An authenticated connection without a valid compatible hello must never become ONLINE or receive deployment/ingress/runtime commands.

## Consequences

- Feature compatibility becomes explicit and testable rather than inferred from implementation details.
- Operator scripts no longer need `strings`, `grep` probes or binutils to determine Agent support.
- Release provenance can be matched to an exact Git commit.
- New capabilities can be added without coupling compatibility to semantic-version comparisons.
- Version remains useful for humans, but dispatch safety is capability-driven.
