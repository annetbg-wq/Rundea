#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
BACKUP_ROOT="${2:-}"
RECOVERY_KEY_FILE="${3:-}"
COMPOSE_FILE="${4:-}"

if [[ -z "$ENV_FILE" || -z "$BACKUP_ROOT" || -z "$RECOVERY_KEY_FILE" ]]; then
  echo "usage: $0 /absolute/path/to/rundea.env /absolute/path/to/backup-root /absolute/path/to/recovery.key [compose-file]" >&2
  exit 2
fi
[[ ${EUID} -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "environment file not found: $ENV_FILE" >&2; exit 2; }
[[ -f "$RECOVERY_KEY_FILE" ]] || { echo "recovery key file not found: $RECOVERY_KEY_FILE" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -n "$COMPOSE_FILE" ]] || COMPOSE_FILE="$SCRIPT_DIR/../live/docker-compose.staging.yml"
for path in "$ENV_FILE" "$BACKUP_ROOT" "$RECOVERY_KEY_FILE" "$COMPOSE_FILE"; do
  [[ "$path" == /* ]] || { echo "all paths must be absolute: $path" >&2; exit 2; }
done

key_mode="$(stat -c '%a' "$RECOVERY_KEY_FILE" 2>/dev/null || stat -f '%Lp' "$RECOVERY_KEY_FILE")"
if (( 10#$key_mode > 600 )); then
  echo "recovery key file permissions must be 0600 or stricter" >&2
  exit 1
fi

install -d -m 0755 /usr/local/libexec/rundea
install -m 0755 "$SCRIPT_DIR/BACKUP_CONTROL_PLANE.sh" /usr/local/libexec/rundea/backup-control-plane
install -d -m 0700 "$BACKUP_ROOT"

cat >/etc/systemd/system/rundea-control-plane-backup.service <<EOF
[Unit]
Description=Rundea encrypted Control Plane backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=RUNDEA_RECOVERY_KEY_FILE=$RECOVERY_KEY_FILE
ExecStart=/usr/local/libexec/rundea/backup-control-plane $ENV_FILE $BACKUP_ROOT $COMPOSE_FILE
UMask=0077
EOF

cat >/etc/systemd/system/rundea-control-plane-backup.timer <<'EOF'
[Unit]
Description=Daily Rundea encrypted Control Plane backup

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=30m
Persistent=true
Unit=rundea-control-plane-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now rundea-control-plane-backup.timer
systemctl start rundea-control-plane-backup.service

echo "Rundea backup timer installed. First encrypted backup completed."
echo "Keep $RECOVERY_KEY_FILE off the backup volume and copy it to a separate protected location."
