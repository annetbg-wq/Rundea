#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
BACKUP_ROOT="${2:-}"
COMPOSE_FILE="${3:-}"

if [[ -z "$ENV_FILE" || -z "$BACKUP_ROOT" ]]; then
  echo "usage: $0 /absolute/path/to/rundea.env /absolute/path/to/backup-root [compose-file]" >&2
  exit 2
fi
[[ -f "$ENV_FILE" ]] || { echo "environment file not found: $ENV_FILE" >&2; exit 2; }

for command in docker openssl sha256sum tar date mktemp chmod mkdir mv find sort head wc stat tr rm ln; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "$COMPOSE_FILE" ]]; then
  COMPOSE_FILE="$SCRIPT_DIR/../live/docker-compose.staging.yml"
fi
[[ -f "$COMPOSE_FILE" ]] || { echo "compose file not found: $COMPOSE_FILE" >&2; exit 2; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

POSTGRES_USER="${POSTGRES_USER:-rundea}"
POSTGRES_DB="${POSTGRES_DB:-rundea}"
RUNDEA_BACKUP_RETENTION="${RUNDEA_BACKUP_RETENTION:-14}"
DR_ROOT="${RUNDEA_DR_ROOT:-/}"

load_recovery_key() {
  if [[ -n "${RUNDEA_RECOVERY_KEY:-}" ]]; then
    printf '%s' "$RUNDEA_RECOVERY_KEY"
    return
  fi
  : "${RUNDEA_RECOVERY_KEY_FILE:?set RUNDEA_RECOVERY_KEY_FILE to a protected off-backup key file}"
  [[ -f "$RUNDEA_RECOVERY_KEY_FILE" ]] || { echo "recovery key file not found: $RUNDEA_RECOVERY_KEY_FILE" >&2; exit 1; }
  local mode
  mode="$(stat -c '%a' "$RUNDEA_RECOVERY_KEY_FILE" 2>/dev/null || stat -f '%Lp' "$RUNDEA_RECOVERY_KEY_FILE")"
  if (( 10#$mode > 600 )); then
    echo "recovery key file permissions must be 0600 or stricter" >&2
    exit 1
  fi
  tr -d '\r\n' < "$RUNDEA_RECOVERY_KEY_FILE"
}

RUNDEA_RECOVERY_KEY="$(load_recovery_key)"
export RUNDEA_RECOVERY_KEY
decoded_bytes="$(printf '%s' "$RUNDEA_RECOVERY_KEY" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
[[ "$decoded_bytes" == "32" ]] || { echo "recovery key must be base64 for exactly 32 bytes" >&2; exit 1; }

[[ "$RUNDEA_BACKUP_RETENTION" =~ ^[0-9]+$ ]] && (( RUNDEA_BACKUP_RETENTION >= 2 )) || {
  echo "RUNDEA_BACKUP_RETENTION must be an integer >= 2" >&2
  exit 1
}

umask 077
mkdir -p "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
lock_dir="$BACKUP_ROOT/.backup-lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "another Rundea backup is already running" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "$BACKUP_ROOT/.tmp.XXXXXX")"
plain_db="$tmp_dir/database.dump"
plain_host="$tmp_dir/host-state.tar"
list_file="$tmp_dir/host-state.list"
cleanup() {
  rm -rf "$tmp_dir" "$lock_dir"
}
trap cleanup EXIT

if [[ -n "${RUNDEA_POSTGRES_CONTAINER:-}" ]]; then
  postgres_id="$RUNDEA_POSTGRES_CONTAINER"
else
  postgres_id="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q postgres)"
fi
[[ -n "$postgres_id" ]] || { echo "Rundea PostgreSQL container is not running" >&2; exit 1; }

docker exec "$postgres_id" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

docker exec "$postgres_id"   pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"   --format=custom --no-owner --no-acl > "$plain_db"
[[ -s "$plain_db" ]] || { echo "PostgreSQL dump is empty" >&2; exit 1; }

encrypt_file() {
  local input="$1" output="$2"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt     -pass env:RUNDEA_RECOVERY_KEY -in "$input" -out "$output"
}

encrypt_file "$plain_db" "$tmp_dir/database.dump.enc"
encrypt_file "$ENV_FILE" "$tmp_dir/environment.env.enc"

: > "$list_file"
for path in   var/lib/rundea/caddy   var/lib/rundea/caddy-data   var/lib/rundea/caddy-config   etc/rundea/agent.env   etc/systemd/system/rundea-agent.service   etc/systemd/system/rundea-agent.service.d/10-reserved-ingress.conf
do
  if [[ -e "$DR_ROOT/$path" ]]; then
    printf '%s\n' "$path" >> "$list_file"
  fi
done

tar -C "$DR_ROOT" -cf "$plain_host" --files-from "$list_file"
encrypt_file "$plain_host" "$tmp_dir/host-state.tar.enc"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
final_dir="$BACKUP_ROOT/$timestamp"
cat > "$tmp_dir/metadata.env" <<EOF
RUNDEA_BACKUP_FORMAT=1
RUNDEA_BACKUP_CREATED_AT=$timestamp
RUNDEA_POSTGRES_DB=$POSTGRES_DB
RUNDEA_POSTGRES_USER=$POSTGRES_USER
RUNDEA_INGRESS_MODE=${RUNDEA_INGRESS_MODE:-unknown}
EOF

(
  cd "$tmp_dir"
  sha256sum database.dump.enc environment.env.enc host-state.tar.enc metadata.env > SHA256SUMS
)
chmod 0600 "$tmp_dir"/*
rm -f "$plain_db" "$plain_host" "$list_file"
mv "$tmp_dir" "$final_dir"
tmp_dir="$BACKUP_ROOT/.moved"
ln -sfn "$timestamp" "$BACKUP_ROOT/latest"

mapfile -t old_backups < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20????????T??????Z' -printf '%f\n' | sort -r | tail -n "+$((RUNDEA_BACKUP_RETENTION + 1))")
for old in "${old_backups[@]}"; do
  rm -rf -- "$BACKUP_ROOT/$old"
done

rm -rf "$lock_dir"
trap - EXIT
unset RUNDEA_RECOVERY_KEY

echo "Rundea encrypted backup created: $final_dir"
echo "Recovery key was not written into the backup."
