# ADR 0006: Fixed-profile node egress qualification

Status: Accepted

## Context

Rundea's first proof workload is Sendina. A deployment can build and pass its HTTP healthcheck while still being unusable if the VPS provider blocks outbound mail protocols. Sendina needs TCP reachability to Gmail SMTP on ports 465 and 587 and IMAP on port 993.

Treating a node as usable merely because its Agent is online would therefore produce a false readiness signal.

## Decision

Node qualification is an explicit Control Plane → Agent command with persisted results. The first profile is `sendina-egress-v1` and contains exactly three targets:

- `smtp.gmail.com:465`
- `smtp.gmail.com:587`
- `imap.gmail.com:993`

The Agent opens a real outbound TCP connection from the node to every target with a bounded timeout, records latency or a sanitized error, closes the socket, and returns one aggregate result. The Control Plane accepts `PASSED` only when all three exact probes pass.

Qualification history belongs to the node and is stored in PostgreSQL. A previous pass is evidence about that node at that time, not a permanent capability claim.

## No arbitrary port scanner

The Control Plane sends only a profile identifier. Hostnames and ports are compiled into the Agent for that profile. Neither the API nor the WebSocket command accepts arbitrary probe targets.

This is deliberate. A privileged node agent should not become a generic remote network scanner or an SSRF-like primitive merely because network diagnostics are useful.

## Concurrency and failure semantics

Only one qualification may be `RUNNING` per node. This is enforced both by the API and by a PostgreSQL partial unique index.

A qualification is terminal as `PASSED` or `FAILED`. If the command cannot be delivered, the Agent disconnects, or the Control Plane restarts while a test is running, the record becomes `FAILED` rather than remaining indefinitely active. Infrastructure failure reasons are retained separately from per-probe errors.

## What the result proves

A passing result proves that, at qualification time, the selected VPS can establish TCP connections to all three required Gmail endpoints. It is a provider/network egress gate.

It does **not** prove:

- valid SMTP or IMAP credentials;
- successful TLS negotiation or application-level protocol exchange;
- Gmail account policy or rate limits;
- Sendina's own mailbox configuration;
- future network availability.

Those belong to the later full workload proof, where Sendina itself performs its existing mailbox verification flow.

## Sendina migration rule

Rundea must not move Sendina off Railway merely because the node Agent is online. Before the migration proof, the target node must have a current `PASSED` result for `sendina-egress-v1`, then pass deployment, HTTPS, secrets, health and rollback checks as separate gates.
