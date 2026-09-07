# ADR 0004: Source delivery, networking and the Sendina proof workload

Status: Accepted

## Source delivery

The foundation agent can clone a repository that is already accessible from the node. Production private GitHub repositories must not require a permanent GitHub PAT on every VPS.

The next source slice should use the Rundea GitHub App in the control plane to obtain short-lived installation credentials or an authenticated source archive, scoped to the selected repository/ref. Credentials must be ephemeral and must not be persisted in runtime logs.

## Public ingress

Caddy is the preferred v0 reverse proxy because automatic ACME HTTPS and dynamic reverse proxy configuration fit the product requirements. The agent will eventually run service containers on a dedicated Rundea network and reconcile Caddy routes from explicit control-plane commands.

## Egress

Rundea itself will not introduce an application-level policy that blocks SMTP 465/587 or IMAP 993. Provider/network policy still applies. Node qualification for the Sendina migration must run real TCP probes to:

- `smtp.gmail.com:465`
- `smtp.gmail.com:587`
- `imap.gmail.com:993`

The Sendina workload remains on Railway until a Rundea node passes those probes and the full deployment/HTTPS/secrets/logging/health/rollback path is proven.
