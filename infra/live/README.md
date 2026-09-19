# Rundea staging live stack

This directory is the A14 staging deployment contract for the live Rundea surface currently bound to `rundea.bachopus.com`.

## Safety boundary

- staging uses its own PostgreSQL volume and staging-only secrets;
- API and Web images are pinned to the same immutable Git commit SHA;
- `RUNDEA_PUBLIC_WEB_MODE=external-auth` is valid only because the browser surface is protected by the dedicated live Web gateway;
- the browser never receives `RUNDEA_CONTROL_TOKEN`; `/api/*` requests are authenticated at the gateway and the bearer token is injected server-side;
- machine endpoints such as `/v0/*`, `/mcp` and `/.well-known/*` keep their existing endpoint authentication and are not converted into browser-auth routes;
- PostgreSQL is not published to the host network;
- the Control Plane publishes port 4000 only on `127.0.0.1`;
- the Web gateway publishes port 4100 only on `127.0.0.1`;
- public ports 80/443 have exactly one owner at a time;
- `/health` stays public, secret-free and `no-store` so readiness can be verified without browser credentials;
- production must use a separate host/state/secrets set and must not reuse this staging volume.

## Browser access

The built React application is served by the `web` container. Browser administration uses HTTP Basic authentication at the live gateway with username `rundea`. Configure the password with `SET_WEB_PASSWORD.sh`; only its bcrypt hash is stored in the protected environment file. The plaintext password is never written to the repository or shipped to browser JavaScript.

## Ingress ownership

A fresh self-hosted Control Plane needs temporary HTTPS before a Rundea Agent can connect. The compose `edge` service therefore exists only under the `bootstrap-ingress` profile.

After Agent `0.1.2` or later is installed on the same node, `TAKEOVER_MANAGED_INGRESS.sh` performs a verified handoff:

1. proves the authenticated Web gateway is healthy on `127.0.0.1:4100`;
2. preserves the bootstrap Caddy ACME state;
3. records `rundea.bachopus.com=4100` as a reserved node-system route in the Agent environment;
4. validates the replacement Caddy configuration before changing public ingress;
5. stops the bootstrap edge and starts the Agent-compatible `rundea-caddy` on host ports 80/443;
6. verifies public HTTPS health;
7. restarts the Agent with the reserved route and switches the live stack to `RUNDEA_INGRESS_MODE=managed`;
8. restores the bootstrap edge if the handoff fails before completion.

Once managed mode is active, the compose deployment path never respawns `edge`. SignalKit and every later workload receive loopback-only host ports and are routed through this same Rundea-owned Caddy instance.

## Bootstrap

1. Copy `staging.env.example` to a protected environment file outside the repository.
2. Replace every staging secret placeholder except the Web password hash.
3. Run `bash SET_WEB_PASSWORD.sh /absolute/path/to/staging.env` and choose the browser password interactively.
4. Set `RUNDEA_IMAGE_TAG` to the exact 40-character SHA successfully published for both API and Web images by `live-runtime-image`.
5. Leave `RUNDEA_INGRESS_MODE=bootstrap` for the initial bring-up.
6. Point the DNS record for `rundea.bachopus.com` at the staging host.
7. Authenticate the host to GHCR with read-only package access if the package is private.
8. Start the stack with `bash DEPLOY_STAGING.sh /absolute/path/to/staging.env`.
9. Require PostgreSQL, API, Web and public HTTPS health before installing the same-node Agent.
10. Install Agent `0.1.2` or later and confirm the node is `ONLINE`.
11. Run `bash TAKEOVER_MANAGED_INGRESS.sh /absolute/path/to/staging.env rundea.bachopus.com` (port 4100 is the safe default).
12. Re-check `https://rundea.bachopus.com/health` and browser login before attaching workload domains.

The current public hostname does not change the runtime safety boundary: this stack still runs with `RUNDEA_ENVIRONMENT=staging`. Before a final production promotion, production state/secrets and the long-term staging hostname must remain operationally separated.


## Backup and disaster recovery

The canonical encrypted backup/restore procedure is in `infra/dr/README.md`.

Before treating this live stack as recoverable, install the daily backup timer, keep the recovery key outside both the VPS and backup volume, replicate backups off-host, and pass the clean-environment DR acceptance. The backup includes PostgreSQL, the protected environment containing the original `RUNDEA_MASTER_KEY`, and managed Caddy/Agent host state required to reconstruct ingress ownership.
