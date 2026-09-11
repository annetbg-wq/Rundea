# Rundea — Quick Connect Hub + Live Domain Addendum

Status: additive to `AI_MCP_GUIDED_MIGRATION_ROADMAP.md`. This addendum does not replace or reorder already accepted security, MCP, runtime, migration, or production-readiness work. It adds two mandatory product tracks that should run alongside the existing roadmap.

---

# A13 — Quick Connect Hub: GitHub + Compute Provider Onboarding

## Goal

Make the first successful Rundea setup feel like connecting two things, not manually configuring an infrastructure platform:

```text
Connect GitHub project
        ↓
Rundea auto-discovers application metadata
        ↓
Choose compute provider
        ↓
Rundea auto-imports everything available through API / agent / metadata
        ↓
If provider blocks automation, Rundea shows the exact provider path and required action
        ↓
Rundea automatically verifies the result and continues
        ↓
Ready to deploy
```

The user must not be expected to know repository IDs, branch SHAs, ports, build commands, server identifiers, SSH layout, provider menu structure, or infrastructure terminology merely to get started.

## A13.1 — Fast GitHub project connection

Use the existing GitHub App foundation as the primary path.

### User flow

1. User selects `Connect GitHub`.
2. If the GitHub App is not installed, Rundea opens the GitHub installation flow and guides the user to repository selection.
3. Rundea lists only repositories available to the installation.
4. User chooses the working repository.
5. Rundea automatically creates a source profile and discovers everything it can safely infer.
6. User confirms only unresolved or ambiguous items.

### Automatic discovery

Rundea should automatically read, where available:

- repository identity and canonical URL;
- GitHub App installation identity;
- repository visibility;
- default branch;
- selected deployment branch;
- latest commit / revision metadata;
- Dockerfile and Docker build context;
- Compose files where supported;
- package manifests such as `package.json`, `go.mod`, `pom.xml`, Gradle files, Python manifests and equivalent runtime hints;
- detected language/runtime;
- build command candidates;
- start command candidates;
- exposed/listening port candidates;
- healthcheck hints;
- monorepo/workspace structure;
- service candidates inside a monorepo;
- environment-variable **names and requirements**, never secret values from source;
- existing GitHub Actions/autodeploy hints where relevant;
- webhook/autodeploy readiness.

### Discovery confidence

Every inferred field is classified as:

```text
CONFIRMED
HIGH_CONFIDENCE
NEEDS_CONFIRMATION
MISSING
UNSUPPORTED
```

Rundea must never silently convert a weak inference into a production setting.

### Acceptance

A supported repository should reach a reviewable deployment configuration without the user manually copying repository IDs, branch names, commit SHAs, detected runtime, or obvious build metadata.

---

## A13.2 — Fast compute-provider connection

After selecting the source project, the user chooses where it should run.

### Preset provider catalog — first 10

Initial compute-target presets:

1. Hetzner Cloud
2. AWS
3. Google Cloud Platform
4. Microsoft Azure
5. DigitalOcean
6. OVHcloud
7. Vultr
8. Akamai / Linode
9. Oracle Cloud
10. Scaleway

The UI must also contain:

> Other server / Generic VPS

The architecture must not hard-code the product to the initial ten providers. Provider support is registry-driven.

Railway and Render remain important platform/import adapters but are treated separately from the initial compute-target list because their control model differs from raw VM/VPS providers.

### Provider connection state machine

```text
PROVIDER_SELECTED
-> AUTH_REQUIRED
-> DISCOVERING
-> NEEDS_USER_STEP        (only if automation is blocked)
-> VERIFYING_USER_STEP
-> DISCOVERING_CONTINUED
-> READY
```

Side states:

```text
AUTH_FAILED
INSUFFICIENT_PERMISSION
UNSUPPORTED_CONFIGURATION
PROVIDER_UNAVAILABLE
VERIFICATION_FAILED
```

### Automatic provider discovery

Where the provider API/authorization permits, Rundea automatically obtains:

- account/project/subscription context;
- regions/zones;
- server/instance inventory;
- server IDs;
- public/private addresses;
- OS/image metadata;
- CPU/RAM/disk capability;
- network/firewall metadata relevant to Rundea;
- provider labels/tags;
- DNS/IP information where available;
- SSH/agent readiness metadata without exposing private credentials;
- existing Rundea Agent identity if already installed;
- runtime capability and node qualification data;
- egress restrictions;
- candidate target node;
- cost/size metadata when safely available.

### Exact Guided Mode handoff

If Rundea cannot obtain a required value automatically, it must not say merely:

> Enter your API token.

It must say, for example:

```text
Hetzner Cloud
Project -> Security -> API Tokens -> Generate API Token
Permissions: Read & Write
Copy the token once and paste it into the protected Rundea field.
```

Or:

```text
AWS
IAM -> Roles -> Create role -> Custom trust policy
Rundea needs: <specific permissions>
Step 1/5 ...
```

The guidance record must come from the Provider Guidance Registry and include freshness/version metadata.

### Automatic continuation

The user should not need to press a generic `Done` button and guess whether the step worked.

After a user action Rundea should automatically:

1. retry discovery;
2. verify the expected provider-side state;
3. import newly available metadata;
4. mark the guided step complete;
5. continue to the next unresolved step.

### Generic / unsupported provider path

For a provider outside the preset catalog, offer a universal connection path using the strongest available method:

```text
Provider API adapter, if available
        ↓ else
Rundea Agent bootstrap on Linux server
        ↓ else
Generic VPS / SSH-guided onboarding
```

The generic path should discover host/runtime data through the Rundea Agent and should not require adding a bespoke provider implementation before the user can deploy.

### Provider adapter contract

Each provider preset should implement a common capability model rather than leaking provider-specific concepts into core logic:

```text
provider_id
connection_methods[]
discover_account()
discover_compute()
discover_network()
required_manual_steps[]
verify_manual_step()
install_or_bind_agent()
normalize_target()
capabilities
last_verified_at
```

Provider adapters may expose different capabilities. Rundea must represent unsupported capabilities explicitly rather than pretending all providers are equivalent.

---

## A13.3 — Quick Connect UX contract

Default onboarding should be short:

```text
1. Choose repository
2. Choose server/provider
3. Resolve only the few items Rundea cannot obtain automatically
4. Review
5. Deploy
```

Advanced fields remain available but collapsed by default.

### Product rule

> If Rundea can discover a value itself, it must not ask the user to type or copy it.

Second rule:

> If Rundea cannot discover a value itself, it must tell the user exactly where it is and automatically verify the result afterward.

### Do not expose internal complexity

Normal users should not need to see raw installation IDs, node credentials, provider object IDs, reconciliation states, correlation IDs, migration internals, or security-control terminology unless they explicitly open an advanced/debug view.

---

## A13.4 — Security requirements

- GitHub App permissions stay least-privilege.
- No secret plaintext is inferred from repository contents and returned to AI clients.
- Provider credentials are encrypted/referenced; never written to logs/audit payloads.
- Provider connection permissions are validated server-side.
- Import/discovery operations are read-only until the user explicitly approves mutation.
- A compromised MCP client cannot silently attach a new provider account.
- Provider connection is bound to the authenticated Rundea workspace/account once multi-tenancy lands.
- All automatic mutation remains behind typed operations, policy and approval.

---

## A13.5 — Definition of done

A13 is considered proven when:

1. A user can install/select a GitHub repository and Rundea automatically obtains its source/build metadata.
2. The user can select at least Hetzner plus one second preset provider and Rundea automatically discovers server metadata.
3. A missing integration prerequisite produces an exact provider UI path instead of generic instructions.
4. After the prerequisite is completed, Rundea observes the new state automatically and resumes onboarding.
5. `Other server / Generic VPS` successfully connects a normal Linux VPS through Rundea Agent bootstrap.
6. The final review screen contains only unresolved choices, not values Rundea already knows.
7. The complete GitHub -> provider -> deploy path is covered by acceptance testing.

---

# A14 — Live Rundea Surface on buxopus

## Goal

Move Rundea from repository/demo-only status to a continuously reachable live product surface.

Initial canonical production hostname:

```text
https://rundea.buxopus.com
```

Recommended staging hostname:

```text
https://rundea-staging.buxopus.com
```

The exact host names remain configuration, but production and staging must be operationally separated.

## Initial live surface

`rundea.buxopus.com` should expose the user-facing product through HTTPS and become the canonical public origin for the first live environment.

Expected surface:

```text
https://rundea.buxopus.com/        -> Web UI
https://rundea.buxopus.com/api/... -> Control Plane/API as routed by the chosen architecture
https://rundea.buxopus.com/mcp      -> protected MCP endpoint when enabled
```

Internal health/debug routes must not become anonymously exposed merely because the product has a public hostname.

## Domain deployment work

- DNS record creation;
- TLS certificate provisioning/renewal;
- HTTPS-only public access;
- HTTP -> HTTPS redirect where appropriate;
- canonical origin configuration;
- allowed Host/Origin configuration for MCP;
- OAuth audience/resource configured to the live `/mcp` URL;
- secure cookie/CORS behavior if/when browser authentication lands;
- health and readiness checks;
- release/deploy wiring from `main` through the existing accepted production pipeline;
- rollback to previous known-good release;
- basic uptime/availability monitoring;
- production logs and metrics without secret leakage.

## Staging-before-production rule

Changes affecting authentication, MCP transport, routing, migrations or provider connections should first be validated at:

```text
rundea-staging.buxopus.com
```

before promotion to the production host.

This does not mean every text/UI change requires a heavyweight manual release ceremony. The deployment pipeline should keep this automatic where risk permits.

## Dogfood requirement

Where technically possible, the live Rundea surface should itself be operated using the same Rundea deployment/control mechanisms being sold to users.

The target is:

> Rundea deploys and monitors Rundea.

This is a product acceptance fixture, not merely a marketing demo.

## Live-domain acceptance

A14 is considered proven when:

1. `rundea.buxopus.com` resolves publicly and serves the current Web UI over valid HTTPS.
2. The Control Plane is reachable only through intended public routes.
3. A normal production deployment from the accepted pipeline can update the live environment.
4. A failed release preserves or restores the previous healthy version.
5. MCP Host/Origin validation accepts the canonical live domain and rejects an unconfigured host.
6. The OAuth protected-resource metadata advertises the real production `/mcp` resource when OAuth mode is enabled.
7. Staging and production use separate configuration/secrets and cannot accidentally share mutable runtime state.
8. Health/availability is observable without exposing internal secrets.

---

# Updated delivery placement

These tracks modify the recommended execution order as follows:

```text
Current safe AI/MCP foundation
        |
        +-> A14 Live staging/production surface
        |
        +-> Workspaces / Projects / Memberships
        |
        +-> A13 Quick Connect Hub
             |-> GitHub automatic discovery
             |-> Provider catalog + Guided Mode
             |-> Generic VPS / Agent path
        |
        +-> Expanded read-only MCP
        |
        +-> Real OAuth provider + ChatGPT staging acceptance
        |
        +-> actor/plan-bound approvals
        |
        +-> first write tools: restart -> deploy -> rollback
        |
        +-> embedded Rundea AI
        |
        +-> CIM / migration / cross-provider roadmap continues
```

A14 can progress in parallel with the early workspace and A13 work because a real domain/environment is needed for end-to-end OAuth, MCP and onboarding acceptance.

A13 should start before exposing broad write-capable AI because it is the canonical user entry path into Rundea.

---

# New end-to-end acceptance scenario

The first product-quality onboarding proof should be:

```text
User opens rundea.buxopus.com
-> Connect GitHub
-> select repository
-> Rundea auto-detects source/build/runtime metadata
-> choose Hetzner (or another preset provider)
-> Rundea auto-discovers available server/account metadata
-> Rundea identifies one missing prerequisite
-> Guided Mode shows the exact provider path
-> user performs that action
-> Rundea automatically verifies it
-> target node becomes READY
-> user reviews only unresolved choices
-> Deploy
-> health verification passes
-> service becomes reachable
```

The same connected project must then be visible to the safe MCP read catalog through the authenticated/resource-authorized path.

This scenario is a strategic acceptance fixture because it joins the three core promises of Rundea:

1. **No infrastructure treasure hunt.**
2. **Automatic discovery wherever technically possible.**
3. **One safe control plane for humans and AI.**
