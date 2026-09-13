# Rundea staging live stack

This directory is the first A14 staging deployment contract for the live Rundea surface currently bound to `rundea.bachopus.com`.

## Safety boundary

- staging uses its own PostgreSQL volume and staging-only secrets;
- the Control Plane image is pinned to an immutable Git commit SHA;
- `RUNDEA_PUBLIC_WEB_MODE=disabled` keeps the current admin/web surface fail-closed;
- PostgreSQL is not published to the host network;
- the Control Plane publishes port 4000 only on `127.0.0.1`, never on a public interface;
- public ports 80/443 have exactly one owner at a time;
- `/health` is used only as the current Control Plane readiness check and does not return secret material;
- production must use a separate host/state/secrets set and must not reuse this staging volume.

## Ingress ownership

A fresh self-hosted Control Plane needs temporary HTTPS before a Rundea Agent can connect. The compose `edge` service therefore exists only under the `bootstrap-ingress` profile.

After Agent `0.1.2` or later is installed on the same node, `TAKEOVER_MANAGED_INGRESS.sh` performs a verified handoff:

1. proves the Control Plane is healthy on `127.0.0.1:4000`;
2. preserves the bootstrap Caddy ACME state;
3. records `rundea.bachopus.com=4000` as a reserved node-system route in the Agent environment;
4. validates the replacement Caddy configuration before changing public ingress;
5. stops the bootstrap edge and starts the Agent-compatible `rundea-caddy` on host ports 80/443;
6. verifies public HTTPS health;
7. restarts the Agent with the reserved route and switches the live stack to `RUNDEA_INGRESS_MODE=managed`;
8. restores the bootstrap edge if the handoff fails before completion.

Once managed mode is active, the compose deployment path never respawns `edge`. SignalKit and every later workload receive loopback-only host ports and are routed through this same Rundea-owned Caddy instance.

## Bootstrap

1. Copy `staging.env.example` to a protected environment file outside the repository.
2. Replace every placeholder with staging-only values.
3. Set `RUNDEA_IMAGE_TAG` to the exact 40-character SHA successfully published by `live-runtime-image`.
4. Leave `RUNDEA_INGRESS_MODE=bootstrap` for the initial bring-up.
5. Point the DNS record for `rundea.bachopus.com` at the staging host.
6. Authenticate the host to GHCR with read-only package access if the package is private.
7. Start the stack with `bash DEPLOY_STAGING.sh /absolute/path/to/staging.env`.
8. Require PostgreSQL, API and public HTTPS health before installing the same-node Agent.
9. Install Agent `0.1.2` or later and confirm the node is `ONLINE`.
10. Run `bash TAKEOVER_MANAGED_INGRESS.sh /absolute/path/to/staging.env rundea.bachopus.com 4000`.
11. Re-check `https://rundea.bachopus.com/health` before attaching workload domains.

The current public hostname does not change the runtime safety boundary: this stack still runs with `RUNDEA_ENVIRONMENT=staging`. Before a final production promotion, production state/secrets and the long-term staging hostname must remain operationally separated.
