# Rundea — Additive AI / MCP / Guided Migration Roadmap

Status: proposed additive roadmap

This document extends the existing Rundea implementation plan. It does **not** replace, cancel, downgrade, or reorder already accepted work unless a later explicit decision says so.

The current Control Plane -> Agent -> Docker execution path remains the production foundation. Existing work on authentication, real-provider acceptance, GitHub App acceptance, node qualification, artifact retention, observability, release/distribution hardening, and other already planned production-readiness slices remains mandatory.

## Product direction

Rundea should become a safe infrastructure control plane for both humans and AI clients.

The target interaction model is:

```text
Human -> Web UI -------------------┐
Human -> Rundea AI ----------------┤
ChatGPT / Claude / Cursor -> MCP --┼-> Typed Operation Layer -> Policy / Approval -> Rundea Engine
CLI / API -------------------------┘                                      |
                                                                          +-> Nodes / Docker
                                                                          +-> Provider adapters
                                                                          +-> DNS / databases / external infrastructure
```

The same typed operations must power the Web UI, embedded AI, MCP, API, and CLI. AI is never a privileged bypass around the Control Plane.

Core product rule:

> If Rundea cannot safely perform a required action itself, it must tell the user exactly where the remaining action is located in the relevant provider UI, what to read or change, and how Rundea will verify completion.

## Non-negotiable architecture rules

1. **No generic AI shell tool.** MCP/AI must not receive unrestricted SSH, `exec(command)`, arbitrary SQL, or equivalent raw execution primitives.
2. **Typed operations only.** Examples: `deploy_service`, `restart_service`, `set_variable`, `attach_domain`, `create_backup`, `restore_backup`, `migrate_service`, `rollback_deployment`.
3. **Server-authoritative validation.** The Control Plane validates identity, ownership, state, preconditions, target scope, and payload before dispatch.
4. **Explicit risk classification.** Every operation is READ_ONLY, SAFE_WRITE, SENSITIVE_WRITE, or DESTRUCTIVE.
5. **Approval is a Control Plane property.** The model cannot self-approve an operation that requires user approval.
6. **Plan before mutation.** Multi-step changes produce an immutable execution plan before execution.
7. **Idempotency and resumability.** Retried AI/MCP requests must not duplicate destructive or billable actions.
8. **Verification after execution.** A successful command is not equivalent to a successful outcome. Health, connectivity, DNS, deployment state, or provider state must be checked.
9. **Rollback or recovery path.** Mutations with production impact require a defined rollback/recovery path when technically possible.
10. **Auditability.** Record actor, client type, requested intent, operation, approval, effective changes, result, and correlation id.
11. **Secrets stay protected.** Secret values are never exposed through read APIs/MCP merely because an AI client is connected. Prefer presence/fingerprint/reference metadata.
12. **UI and AI share contracts.** No hidden AI-only infrastructure path.

---

# Execution model

This roadmap is split into additive epics. Work may begin on the early contract/design slices while the existing production-readiness plan continues, but write-capable AI/MCP and automatic migrations must not jump ahead of the safety prerequisites.

Recommended dependency order:

```text
Existing Rundea plan continues unchanged
        |
        +-----------------------------+
        |                             |
     A1 Operations Core           A4 Guidance Registry 2.0
        |                             |
     A2 Policy / Approval              +-> A5 Provider Guidance Packs
        |
     A3 MCP Read-only
        |
     A6 MCP Safe Write
        |
     A7 Embedded AI
        |
     A8 Canonical Infrastructure Model
        |
     A9 Import / Migration Planner
        |
     A10 Migration Executor
        |
     A11 Cross-provider Optimization
```

A4/A5 can progress in parallel because they are primarily guidance/read-side work.

---

# A1 — Universal Typed Operation Layer

## Goal

Create one canonical application-operation layer used by Web UI, REST/API, MCP, embedded AI, and future CLI.

## Scope

Introduce an operation registry with stable names, schemas, preconditions, risk class, authorization scope, idempotency semantics, dry-run support, and verification strategy.

Initial operation families:

### Read
- list projects/services/nodes/deployments
- get deployment status
- get health state
- get domains and DNS readiness
- get variable metadata without secret plaintext
- get logs with bounded pagination/redaction
- get runtime metrics
- inspect node qualification/capabilities
- explain current configuration

### Safe write
- deploy known revision
- restart current ready revision
- set/update non-secret variable
- set/update secret value supplied by user
- enable/disable autodeploy
- attach a domain after validation

### Sensitive write
- rollback
- rotate node credential
- change production target node
- alter routing/cutover state
- restore backup
- migration cutover

### Destructive
- delete service
- delete database/storage
- purge retained artifacts
- remove production domain/routing where it causes downtime

## Deliverables

- `OperationDefinition` schema
- operation registry
- common authorization hook
- common idempotency key handling
- common structured result/error contract
- operation correlation ids
- dry-run/plan mode where meaningful
- integration tests proving Web/API operations use the same service layer

## Gate

No MCP write tool is exposed until target mutations run through this layer.

---

# A2 — Policy, Approval, Safety and Audit Layer

## Goal

Make external agents safe consumers of Rundea capabilities.

## Scope

### Risk policy
Each operation has a default risk class and optional contextual escalation. Example: restart on a development service can be SAFE_WRITE while a production cutover is SENSITIVE_WRITE.

### Approval model
- READ_ONLY: no mutation approval
- SAFE_WRITE: may execute under a user-granted session policy
- SENSITIVE_WRITE: explicit approval or pre-authorized policy with narrow scope
- DESTRUCTIVE: explicit fresh approval; no blanket AI self-approval

### Plan contract
Multi-step changes persist an immutable plan containing:
- source state snapshot
- intended target state
- operations
- dependencies
- expected impact
- unresolved manual steps
- validation checks
- rollback/recovery strategy

### Audit
Persist:
- human/account identity
- calling client (`WEB`, `API`, `MCP`, `RUNDEA_AI`, `CLI`)
- model/client metadata where supplied
- operation/plan id
- approvals
- before/after state references
- execution result
- verification result

## Gate

Negative tests must prove that MCP/AI cannot bypass production approval, ownership, secret boundaries, or operation preconditions.

---

# A3 — MCP Server v1: Read-only Infrastructure Context

## Goal

Allow an external AI client to understand Rundea state without permitting mutation.

## Initial tools/resources

- projects and services
- deployment status/history
- node state/capabilities
- domain and TLS status
- runtime metrics
- bounded/redacted logs
- variable names + secret/non-secret metadata
- configuration explanation
- failed-deployment diagnostics inputs

## Design requirements

- authenticated user/org scope
- least privilege
- pagination and bounded outputs
- log redaction
- no plaintext secret retrieval
- stable typed errors
- request correlation ids
- rate limiting

## Acceptance scenario

A connected AI must be able to answer:

> Why is service X unhealthy?

using Rundea state and logs, without SSH and without exposing secret values.

---

# A4 — Guided Mode 2.0

## Goal

Extend the existing local Guided Mode/help registry into a user-selectable infrastructure assistance system.

The current RU/EN guided experience is the foundation, not throwaway work.

## User modes

### OFF
For experienced users. No explanatory guidance unless requested.

### COMPACT
Show only the shortest provider path and required value/action.

Example:

```text
Railway -> Project -> Backend -> Variables -> DATABASE_URL
```

### STEP_BY_STEP
Guide one verified step at a time:

```text
Step 1/4: Open Railway and choose project X.
Step 2/4: Open Backend -> Variables.
Step 3/4: Find DATABASE_URL and copy it.
Step 4/4: Return to Rundea and paste it here.
```

## Requirements

- preference can be changed globally and per-session
- guidance is contextual to provider + action + resource type
- current step is resumable
- Rundea distinguishes instruction from verification
- completion is based on observed resulting state where possible, not merely "user clicked Done"
- RU/EN remain supported by the content model

---

# A5 — Provider Guidance Registry and Guidance Packs

## Goal

When an external provider prevents full automation, Rundea must tell the user exactly where the required value or setting lives.

## Canonical guidance model

Each guidance record should contain at minimum:

```text
provider
provider_ui_version / last_verified_at
action
resource_type
prerequisites
path[]
what_to_find
what_to_copy_or_change
sensitivity
expected_result
verification_strategy
fallback
localized_content
```

Do not bind core logic to prose strings. The provider path is structured data rendered into RU/EN instructions.

## Initial provider packs

Priority order based on likely Rundea workflows:

1. Railway
2. Hetzner Cloud
3. Cloudflare
4. Render
5. Supabase
6. Neon
7. generic Linux VPS / SSH-hosted Docker
8. AWS common paths only after the model is stable

## Important constraint

Provider interfaces change. Every guidance record therefore needs freshness/version metadata and a clear fallback when Rundea cannot confidently identify the current path.

Do not silently provide a stale path as fact.

## Example unresolved-secret behavior

Bad:

> Paste DATABASE_URL.

Required:

> Rundea cannot read this protected value from Railway. Open Railway -> project -> Backend -> Variables, find `DATABASE_URL`, copy the value, and paste it into the protected Rundea field. Rundea will then test database connectivity before continuing.

---

# A6 — MCP Server v2: Safe Write Operations

## Goal

Expose the A1 operation layer to authorized external AI clients without creating an alternate execution system.

## First write tools

- deploy service
- restart service
- set supplied variable/secret
- configure autodeploy
- attach domain
- rollback to retained revision

## Required tool behavior

Every tool response returns structured state such as:

```text
operation_id
status
risk_class
approval_required
preconditions
changes
verification
next_manual_action
recovery
```

If a provider-side manual action is required, `next_manual_action` references the A5 provider guidance record rather than returning generic prose.

## Gate

- no raw shell tool
- no arbitrary provider API passthrough
- no unrestricted secret reads
- replay/idempotency tests
- approval bypass tests
- organization/resource ownership tests
- production negative-path acceptance

---

# A7 — Embedded Rundea AI

## Goal

Provide the same capabilities to users who do not want to connect an external AI client.

## Principle

The embedded assistant calls the same A1 operations as MCP. It gets no special backend privileges.

## Primary jobs

- explain failures in human language
- locate settings
- propose a fix
- preview impact
- execute approved safe operations
- guide remaining external-provider steps
- verify resolution

## Target interaction

```text
User: Why is backend down?
Rundea: The current revision starts but cannot connect to Postgres. DATABASE_URL is missing.
        I can add it after you provide the protected value.
        In Railway it is located at Project -> Backend -> Variables -> DATABASE_URL.
User provides value.
Rundea: Connectivity check passed. Redeploy backend?
User: Yes.
Rundea: Deployment READY; healthcheck passed.
```

---

# A8 — Canonical Infrastructure Model (CIM)

## Goal

Create the portable representation needed for imports and migrations.

This is separate from the existing runtime desired state. Do not retrofit migrations as provider-specific one-off scripts.

## Initial entities

- application/project
- service
- source/revision/build strategy
- runtime/container
- environment variable metadata
- secret requirement/reference
- healthcheck
- domain
- routing
- database dependency
- volume/storage dependency
- network dependency
- node/runtime requirements
- egress capability
- backup/restore requirement

## Import classification

Every discovered property is classified as:
- AUTO_IMPORTABLE
- USER_INPUT_REQUIRED
- PROVIDER_ACTION_REQUIRED
- UNSUPPORTED
- UNKNOWN

The model must preserve uncertainty rather than hallucinating a migration mapping.

---

# A9 — Provider Import Adapters and Migration Planner

## Goal

Turn external infrastructure into a deterministic migration plan before changing anything.

## Initial adapters

Start narrowly:

1. Railway -> Rundea
2. Render -> Rundea
3. generic Docker/VPS -> Rundea

Add Hetzner/Cloudflare as target/control integrations where relevant rather than pretending every provider exposes the same source model.

## Planner stages

```text
Discover -> Normalize -> Validate -> Plan
```

### Discover
Read only what the provider/API/user authorization exposes.

### Normalize
Map provider-specific state into CIM.

### Validate
Identify missing secrets, unsupported services, incompatible storage, ports, domain requirements, database size/strategy, and downtime constraints.

### Plan
Produce immutable migration plan with:
- automatic steps
- user-input steps
- provider-guided steps
- estimated service impact (not fabricated time promises)
- cutover strategy
- verification
- rollback/recovery

## UX rule

Never label a migration "one click" when unresolved manual or unsupported steps exist. Show an accurate automation percentage/state instead.

---

# A10 — Migration Executor

## Goal

Execute approved migration plans safely and resumably.

## State machine

```text
DRAFT
-> DISCOVERED
-> VALIDATED
-> READY_FOR_EXECUTION
-> PROVISIONING
-> COPYING
-> VERIFYING
-> READY_FOR_CUTOVER
-> CUTTING_OVER
-> VERIFYING_PRODUCTION
-> COMPLETED
```

Side states:

```text
WAITING_FOR_USER
BLOCKED
FAILED_RECOVERABLE
ROLLED_BACK
FAILED_TERMINAL
```

## Rules

- persist checkpoints
- all steps idempotent or explicitly non-repeatable
- source remains active until cutover gate
- never delete source automatically as part of initial migration
- health/smoke verification before cutover
- post-cutover verification
- DNS TTL/propagation represented honestly
- database migration strategy selected explicitly
- large/zero-downtime database moves are separate capability levels, not hidden behind the simple path

## Manual-action bridge

When execution reaches a provider limitation:

```text
Migration -> WAITING_FOR_USER
          -> Provider Guidance Registry
          -> exact navigation/action
          -> Rundea observes/verifies result
          -> resume from checkpoint
```

---

# A11 — Rundea-to-Rundea Portability and Cross-provider Optimization

## Goal

After a workload is under Rundea control, make moving it between compatible nodes/providers substantially easier than initial import.

## First capabilities

- move stateless service between Rundea nodes
- re-provision target node
- copy retained image/artifact or rebuild exact revision
- reproduce environment snapshot securely
- validate target egress/capabilities
- staged health verification
- routing cutover
- recovery to previous node

Later:
- storage-aware migration
- database-aware migration
- cost/capacity recommendations
- policy-driven relocation

AI may recommend a move, but cost optimization must never automatically mutate production without an applicable approval policy.

---

# A12 — AI Diagnostics and Resolution Loop

## Goal

Convert logs/metrics/runtime state into actionable, verifiable resolution rather than generic chat advice.

## Loop

```text
Observe -> Diagnose -> Evidence -> Proposed operation -> Approval -> Execute -> Verify
```

## Requirements

- diagnosis cites concrete Rundea evidence internally by ids/timestamps
- distinguish hypothesis from confirmed cause
- redact secrets from model-visible material
- avoid unbounded log forwarding
- proposed fixes compile into A1 operations
- success requires measured recovery, not merely successful tool invocation

Initial scenarios:
- failed healthcheck
- missing required variable
- wrong port/listen address
- node offline
- DNS not pointing to target
- TLS pending/failure
- memory pressure / crash loop
- failed build/runtime start
- database connectivity failure where detectable

---

# Suggested delivery sequence

## Wave 0 — Continue current plan

No cancellation. Finish existing production-readiness work and active PRs under their existing CI/acceptance gates.

In parallel, only low-risk contract/document work from A1/A4/A5 should begin.

## Wave 1 — AI-safe foundation

- A1 typed operation layer
- A2 policy/approval/audit
- A3 read-only MCP
- A4 Guided Mode 2.0 contract

Outcome: external AI can inspect and explain Rundea safely; guided assistance is a first-class product concept.

## Wave 2 — Assisted operations

- A5 initial provider guidance packs
- A6 MCP safe writes
- A7 embedded AI
- A12 first diagnostics loop

Outcome: user can say "fix/explain/deploy"; Rundea either executes through typed operations or gives exact provider navigation and then verifies the result.

## Wave 3 — Portable infrastructure

- A8 canonical infrastructure model
- A9 Railway/Render/generic VPS import planning
- guided missing-secret/provider-action workflows

Outcome: Rundea can inspect an external deployment and produce an honest deterministic migration plan.

## Wave 4 — Controlled migrations

- A10 migration executor
- first Railway -> Rundea production acceptance fixture/live acceptance
- rollback/recovery acceptance

Outcome: supported migrations are resumable and safe rather than ad-hoc AI automation.

## Wave 5 — Rundea as infrastructure control plane

- A11 Rundea-to-Rundea moves
- broader provider adapters
- cost/capacity recommendations
- enterprise MCP identity/policy hardening as needed

Outcome: workloads already managed by Rundea become portable across compatible compute targets.

---

# Definition of done for the strategic direction

The roadmap is not complete merely because Rundea has a chatbot or an MCP endpoint.

The direction is considered technically proven when all of the following are true:

1. Web UI, embedded AI, MCP and API invoke the same typed operation layer.
2. An external AI can diagnose a failed deployment without SSH or plaintext secret access.
3. A safe write can be executed through MCP with authorization, idempotency, audit, verification and recovery semantics.
4. A sensitive production action demonstrably requires the configured approval gate.
5. Guided Mode can give provider-specific navigation for at least Railway, Hetzner and Cloudflare with version/freshness metadata.
6. A missing non-exportable secret becomes an explicit guided user step, not a hallucinated automatic migration.
7. Rundea can discover and normalize a supported external deployment into CIM and identify unsupported/unknown fields.
8. At least one real supported source migration can proceed through plan -> provision -> verify -> cutover -> post-cutover verify with a recovery path.
9. Once imported, a compatible stateless service can move between two Rundea-managed nodes without the user learning either provider's deployment UI.
10. Every AI-triggered mutation is attributable in the audit log to the user/client/operation/approval chain.

---

# Product positioning supported by this roadmap

Near term:

> Deploy and operate applications without learning every infrastructure panel.

Mid term:

> If Rundea can do it safely, it does it. If an external provider blocks automation, Rundea tells you exactly where to go and what to do.

Long term:

> Rundea is the infrastructure control plane for humans and AI: one safe operational layer across compute providers.
