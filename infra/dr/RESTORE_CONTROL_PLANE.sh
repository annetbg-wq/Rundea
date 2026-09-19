#!/usr/bin/env bash
set -euo pipefail

TARGET_ENV_FILE="${1:-}"
BACKUP_DIR="${2:-}"
COMPOSE_FILE="${3:-}"

if [[ -z "$TARGET_ENV_FILE" || -z "$BACKUP_DIR" ]]; then
  echo "usage: $0 /absolute/path/to/target.env /absolute/path/to/backup [compose-file]" >&2
  exit 2
fi
[[ -d "$BACKUP_DIR" ]] || { echo "backup directory not found: $BACKUP_DIR" >&2; exit 2; }

for command in docker openssl sha256sum tar mktemp chmod mkdir mv grep awk; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "$COMPOSE_FILE" ]]; then
  COMPOSE_FILE="$SCRIPT_DIR/../live/docker-compose.staging.yml"
fi
[[ -f "$COMPOSE_FILE" ]] || { echo "compose file not found: $COMPOSE_FILE" >&2; exit 2; }

for required in database.dump.enc environment.env.enc host-state.tar.enc metadata.env SHA256SUMS; do
  [[ -f "$BACKUP_DIR/$required" ]] || { echo "backup is missing $required" >&2; exit 1; }
done

(
  cd "$BACKUP_DIR"
  sha256sum --check --strict SHA256SUMS
)

load_recovery_key() {
  if [[ -n "${RUNDEA_RECOVERY_KEY:-}" ]]; then
    printf '%s' "$RUNDEA_RECOVERY_KEY"
    return
  fi
  : "${RUNDEA_RECOVERY_KEY_FILE:?set RUNDEA_RECOVERY_KEY_FILE to the protected recovery key}"
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

umask 077
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

decrypt_file() {
  local input="$1" output="$2"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000     -pass env:RUNDEA_RECOVERY_KEY -in "$input" -out "$output"
}

decrypt_file "$BACKUP_DIR/environment.env.enc" "$tmp_dir/environment.env"
decrypt_file "$BACKUP_DIR/database.dump.enc" "$tmp_dir/database.dump"
decrypt_file "$BACKUP_DIR/host-state.tar.enc" "$tmp_dir/host-state.tar"

grep -q '^RUNDEA_MASTER_KEY=' "$tmp_dir/environment.env" || {
  echo "protected environment backup does not contain RUNDEA_MASTER_KEY" >&2
  exit 1
}
grep -q '^POSTGRES_PASSWORD=' "$tmp_dir/environment.env" || {
  echo "protected environment backup does not contain POSTGRES_PASSWORD" >&2
  exit 1
}

target_parent="$(dirname "$TARGET_ENV_FILE")"
mkdir -p "$target_parent"
chmod 0700 "$target_parent" 2>/dev/null || true
install -m 0600 "$tmp_dir/environment.env" "$TARGET_ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$TARGET_ENV_FILE"
set +a
POSTGRES_USER="${POSTGRES_USER:-rundea}"
POSTGRES_DB="${POSTGRES_DB:-rundea}"
DR_ROOT="${RUNDEA_DR_ROOT:-/}"

if [[ -z "${RUNDEA_POSTGRES_CONTAINER:-}" ]]; then
  docker compose --env-file "$TARGET_ENV_FILE" -f "$COMPOSE_FILE" stop api web >/dev/null 2>&1 || true
  docker compose --env-file "$TARGET_ENV_FILE" -f "$COMPOSE_FILE" up -d postgres >/dev/null
  postgres_id=""
  for _attempt in $(seq 1 60); do
    postgres_id="$(docker compose --env-file "$TARGET_ENV_FILE" -f "$COMPOSE_FILE" ps -q postgres)"
    if [[ -n "$postgres_id" ]] && docker exec "$postgres_id" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
else
  postgres_id="$RUNDEA_POSTGRES_CONTAINER"
fi
[[ -n "$postgres_id" ]] || { echo "restored PostgreSQL container is unavailable" >&2; exit 1; }
docker exec "$postgres_id" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null

docker exec -i "$postgres_id"   pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB"   --clean --if-exists --no-owner --no-acl < "$tmp_dir/database.dump"

mapfile -t archive_entries < <(tar -tf "$tmp_dir/host-state.tar")
for entry in "${archive_entries[@]}"; do
  [[ -z "$entry" ]] && continue
  case "$entry" in
    var/lib/rundea/caddy|var/lib/rundea/caddy/*|    var/lib/rundea/caddy-data|var/lib/rundea/caddy-data/*|    var/lib/rundea/caddy-config|var/lib/rundea/caddy-config/*|    etc/rundea/agent.env|    etc/systemd/system/rundea-agent.service|    etc/systemd/system/rundea-agent.service.d/10-reserved-ingress.conf)
      ;;
    *)
      echo "backup contains unexpected host-state path: $entry" >&2
      exit 1
      ;;
  esac
done
mkdir -p "$DR_ROOT"
tar -C "$DR_ROOT" -xf "$tmp_dir/host-state.tar"

if [[ "$DR_ROOT" == "/" && "${RUNDEA_RESTORE_SKIP_RUNTIME_START:-0}" != "1" ]]; then
  if [[ "${RUNDEA_INGRESS_MODE:-}" == "managed" && -f /var/lib/rundea/caddy/Caddyfile ]]; then
    docker rm -f rundea-caddy >/dev/null 2>&1 || true
    docker run -d       --name rundea-caddy       --restart unless-stopped       --network host       --label rundea.managed=true       --label rundea.role=ingress       -v /var/lib/rundea/caddy:/etc/caddy:ro       -v /var/lib/rundea/caddy-data:/data       -v /var/lib/rundea/caddy-config:/config       caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d       caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  fi

  if command -v systemctl >/dev/null 2>&1 && [[ -f /etc/systemd/system/rundea-agent.service && -x /usr/local/bin/rundea-agent ]]; then
    systemctl daemon-reload
    systemctl restart rundea-agent
  fi

  docker compose --env-file "$TARGET_ENV_FILE" -f "$COMPOSE_FILE" up -d api web >/dev/null
fi

unset RUNDEA_RECOVERY_KEY
echo "Rundea restore complete from: $BACKUP_DIR"
echo "Protected environment, PostgreSQL state and managed-ingress host state were restored."
