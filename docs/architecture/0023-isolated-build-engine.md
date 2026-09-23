# 0023 — Isolated Build Engine

## Status

Accepted for staged implementation.

## Context

Registry-first deployment removes `docker build` from production nodes only if an independent system can produce the immutable image. Build workloads have bursty CPU, memory and disk characteristics that must not compete with the live application runtime.

The Build Engine must also preserve Rundea's source-security boundary: a builder must not receive GitHub App private keys, and a production Agent must not receive build credentials.

## Decision

Builds are first-class Control Plane jobs with states:

```
QUEUED -> CLAIMED -> BUILDING -> PUSHED
                         \-> FAILED
```

A dedicated Rundea Builder process claims jobs through an authenticated HTTP worker API. It does not connect to PostgreSQL.

The Control Plane owns source access. The Builder downloads the exact source archive for the persisted 40-character commit SHA through the Control Plane. GitHub App credentials therefore remain in the Control Plane trust boundary.

Each build job is bound to a stable `service_id`, its confirmed service source path, exact commit SHA, Dockerfile selection, validated non-secret build arguments, and a Control-Plane-derived registry repository. Callers cannot choose an arbitrary registry destination.

The Builder:

1. claims a leased job;
2. marks it BUILDING;
3. downloads the exact source archive;
4. builds inside the confirmed service source path;
5. applies explicit Docker build memory/CPU limits and a wall-clock timeout;
6. pushes a temporary build tag to the configured registry;
7. resolves the registry digest;
8. reports only `repository@sha256:...` back to the Control Plane.

The Control Plane accepts completion only from the worker currently owning the live lease and only when the reported artifact repository exactly matches the repository assigned to that job.

## Credentials

`RUNDEA_BUILDER_TOKEN` authenticates Builder -> Control Plane. The Control Plane stores only its hash in memory.

Registry push credentials live only on the Builder through `RUNDEA_REGISTRY_USERNAME` and `RUNDEA_REGISTRY_PASSWORD`. They are never dispatched to production Agents.

This slice does not yet solve authenticated private-registry pulls on production nodes. That belongs to the automatic build-to-deploy handoff slice, where pull credentials must be scoped and short-lived.

## Resource isolation

Builds have three independent limits:

- `RUNDEA_BUILD_MEMORY_BYTES`;
- `RUNDEA_BUILD_CPU_QUOTA` / `RUNDEA_BUILD_CPU_PERIOD`;
- `RUNDEA_BUILD_TIMEOUT_SECONDS`.

The Builder is a separate process intended to run on build infrastructure, not on a production application node. Infrastructure may impose an additional outer cgroup/container limit.

## Failure and recovery

Claims are leased. The Builder sends heartbeats while a Docker build is running. If a worker disappears and its lease expires, another Builder may reclaim the job.

A failed build never creates or mutates a runtime deployment and cannot disturb the currently READY application.

## Follow-up

The next slice wires a PUSHED build artifact into deployment creation automatically, adds scoped private-registry pull credentials, and makes registry artifacts authoritative for cross-node rollback and migration.
