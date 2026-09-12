# Rundea staging live stack

This directory is the first A14 staging deployment contract for `rundea-staging.buxopus.com`.

## Safety boundary

- staging uses its own PostgreSQL volume and staging-only secrets;
- the Control Plane image is pinned to an immutable Git commit SHA;
- `RUNDEA_PUBLIC_WEB_MODE=disabled` keeps the current admin/web surface fail-closed;
- PostgreSQL is not published to the host network;
- TLS is terminated by Caddy and certificates are managed automatically after DNS points at the host;
- `/health` is used only as the current Control Plane readiness check and does not return secret material;
- production must use a separate host/state/secrets set and must not reuse this staging volume.

## Bootstrap

1. Copy `staging.env.example` to a protected environment file outside the repository.
2. Replace every placeholder with staging-only values.
3. Set `RUNDEA_IMAGE_TAG` to the exact 40-character SHA successfully published by `live-runtime-image`.
4. Point the DNS record for `rundea-staging.buxopus.com` at the staging host.
5. Authenticate the host to GHCR with read-only package access if the package is private.
6. Start the stack with Docker Compose using the protected environment file.
7. Require PostgreSQL and API health before treating the release as ready.
8. Verify HTTPS and `/health` from outside the host before enabling MCP or any broader public surface.

No production promotion is implied by a successful staging boot. Production remains a separate A14 promotion step after staging acceptance.
