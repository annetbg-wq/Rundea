# Rundea Control Plane backup and disaster recovery

This directory is the canonical disaster-recovery contract for the self-hosted Rundea Control Plane.

## What is backed up

Every backup is a versioned directory containing:

- `database.dump.enc`: PostgreSQL custom-format dump encrypted before it leaves the temporary backup workspace;
- `environment.env.enc`: the live protected environment file, including the original `RUNDEA_MASTER_KEY`, encrypted under a **separate recovery key**;
- `host-state.tar.enc`: managed Caddy configuration/ACME state plus the local Agent identity/configuration needed to reconstruct the self-hosted ingress owner;
- `metadata.env`: non-secret backup metadata;
- `SHA256SUMS`: integrity checks for every durable backup artifact.

Plaintext database dumps, environment files and Caddy private key material are removed before the final backup directory is published.

## Recovery-key boundary

Create a 32-byte recovery key once and store it separately from both the Rundea host and the backup destination:

```bash
umask 077
openssl rand -base64 32 > /root/rundea-recovery.key
chmod 0600 /root/rundea-recovery.key
```

Copy that recovery key to a second protected/off-host location before relying on backups.

The recovery key is **never written into the backup**. The protected environment backup contains the original `RUNDEA_MASTER_KEY`; therefore encrypted service variables and managed Redis credentials cannot be recovered if both the live master key and its recovery-key-encrypted backup are lost.

Do not place `RUNDEA_RECOVERY_KEY` inside the normal Rundea environment file. Use `RUNDEA_RECOVERY_KEY_FILE` or an ephemeral environment variable during a controlled restore.

## Manual backup

```bash
sudo RUNDEA_RECOVERY_KEY_FILE=/root/rundea-recovery.key \
  bash infra/dr/BACKUP_CONTROL_PLANE.sh \
  /absolute/path/to/staging.env \
  /srv/rundea-backups \
  /absolute/path/to/infra/live/docker-compose.staging.yml
```

The default retention is 14 backups. Set `RUNDEA_BACKUP_RETENTION` in the protected environment file to change it.

## Automated daily backup

```bash
sudo bash infra/dr/INSTALL_BACKUP_TIMER.sh \
  /absolute/path/to/staging.env \
  /srv/rundea-backups \
  /root/rundea-recovery.key \
  /absolute/path/to/infra/live/docker-compose.staging.yml
```

The timer runs daily at 03:15 with up to 30 minutes randomized delay and is persistent across reboot. Installation immediately runs one backup; installation fails if the first backup fails.

The backup destination should itself be replicated off-host. A backup stored only on the same VPS is not a disaster-recovery copy.

## Clean-environment restore

On the replacement host, install Docker/Compose, obtain the same Rundea repository/release contract, provide the recovery key, and run:

```bash
sudo RUNDEA_RECOVERY_KEY_FILE=/secure/off-host-copy/rundea-recovery.key \
  bash infra/dr/RESTORE_CONTROL_PLANE.sh \
  /etc/rundea/staging.env \
  /mnt/backup/20260919T031500Z \
  /opt/Rundea/infra/live/docker-compose.staging.yml
```

Restore performs these gates in order:

1. verifies backup checksums;
2. decrypts the protected environment and proves it contains `RUNDEA_MASTER_KEY` and PostgreSQL credentials;
3. starts or targets a clean PostgreSQL container;
4. restores the database with `pg_restore --clean --if-exists`;
5. rejects unexpected archive paths before restoring managed ingress/Agent host state;
6. reconstructs managed Caddy from the restored Caddyfile and ACME data when restoring the real root filesystem;
7. restarts the Agent when its binary is installed;
8. starts API and Web from the immutable image tag restored from the protected environment file.

After restore, verify `/health`, Web authentication, one encrypted non-secret variable readback, node state and every ACTIVE domain. The Agent will reconcile workload domains from PostgreSQL desired state after reconnect.

## Test-only controls

Acceptance uses `RUNDEA_POSTGRES_CONTAINER` to target an isolated PostgreSQL container and `RUNDEA_DR_ROOT` to restore host-state into a temporary root rather than `/`. Production operators should not set these values.
