# ADR 0013 — Runtime metrics observability

Status: accepted for v0

## Context

Rundea already records deployment state changes and container logs, but the console previously displayed CPU, memory and network as placeholders. A deployment platform must never manufacture operational telemetry. Runtime metrics therefore need an end-to-end path from the actual managed container to the operator UI with the same node ownership boundary used by deployment events.

## Decision

The Rundea Agent samples Docker runtime statistics for running containers labeled `rundea.managed=true`. Deployment identity is read only from the `rundea.deployment` label that Rundea itself writes when starting a container.

The Agent emits a typed `metric` event over the existing authenticated outbound WebSocket. No new inbound node port or telemetry credential is introduced.

The initial sample set is:

- CPU percentage from Docker;
- memory usage bytes;
- memory limit bytes;
- cumulative network receive bytes;
- cumulative network transmit bytes.

The Control Plane validates numeric bounds and accepts a sample only when the deployment belongs to the authenticated node and is in an active runtime state (`DEPLOYING`, `HEALTHCHECK`, or `READY`). The Agent timestamp is syntax-validated, but PostgreSQL `now()` is authoritative for persisted sample time so a bad node clock cannot corrupt the timeline.

Raw samples are retained for 48 hours in v0. The read API accepts windows from 5 minutes through 48 hours and uses PostgreSQL `date_bin` aggregation to keep responses to roughly 240 points rather than returning an unbounded series. `latest` is read separately from the newest raw sample so graph downsampling can never make a live runtime appear stale.

The console renders only values returned by this API. Before the first sample it shows a no-data state, not zeroes. A sample older than 45 seconds is marked stale. Network throughput is derived client-side from deltas between cumulative Docker counters; a counter reset produces an unknown rate rather than a negative value.

## Sampling

The default Agent interval is 15 seconds. `RUNDEA_METRICS_INTERVAL` exists for controlled environments such as CI; the Agent clamps effective intervals to 1 second through 5 minutes. Production configuration should normally use the default.

The Control Plane persists at most one sample per deployment every five seconds. Faster valid events are silently coalesced at the storage boundary, limiting database amplification even if a connected Agent is misconfigured or compromised.

Sampling errors are non-fatal to deployment execution. Repeated identical sampler failures are log-deduplicated so a broken Docker stats call cannot flood node logs.

## Trust and limits

These metrics are operational telemetry, not billing-grade measurements. CPU percentage may exceed 100% on multi-core workloads. Counters are restricted to JavaScript-safe integer range before transport and again at the Control Plane boundary.

Rundea does not currently provide:

- durable long-term time-series storage;
- cross-node metric federation;
- alert rules or paging;
- billing/accounting guarantees;
- process-level or application-specific OpenTelemetry ingestion.

Those are separate later layers and must not be implied by this v0 implementation.

## Acceptance

The node acceptance workflow shortens the Agent interval only for CI, deploys a real Docker workload through the normal Control Plane path, then queries the authenticated metrics API and requires at least one persisted sample with valid CPU, memory and network values. This proves `Docker → Agent → WebSocket → Control Plane → PostgreSQL → API` on the same runtime gate used for deployment/restart/rollback acceptance.
