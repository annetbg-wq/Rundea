#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
SYSTEM_HOSTNAME="${2:-}"
SYSTEM_PORT="${3:-4100}"

if [[ -z "$ENV_FILE" || -z "$SYSTEM_HOSTNAME" ]]; then
  echo "usage: $0 /absolute/path/to/staging.env rundea.example.com [web-gateway-loopback-port]" >&2
  exit 2
fi
[[ ${EUID} -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "environment file not found: $ENV_FILE" >&2; exit 2; }
[[ "$SYSTEM_HOSTNAME" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || {
  echo "system hostname must already be lowercase and normalized" >&2
  exit 2
}
[[ "$SYSTEM_HOSTNAME" == *.* ]] || { echo "system hostname must be a public hostname" >&2; exit 2; }
[[ "$SYSTEM_PORT" =~ ^[0-9]+$ ]] && (( SYSTEM_PORT >= 1 && SYSTEM_PORT <= 65535 )) || {
  echo "loopback port must be an integer from 1 to 65535" >&2
  exit 2
}

for command in docker curl systemctl install mktemp awk grep strings seq sleep mv chmod cat rm; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.staging.yml"
AGENT_ENV="/etc/rundea/agent.env"
AGENT_DROPIN_DIR="/etc/systemd/system/rundea-agent.service.d"
AGENT_DROPIN="$AGENT_DROPIN_DIR/10-reserved-ingress.conf"
CADDY_IMAGE="caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d"
CADDY_CONTAINER="rundea-caddy"
CADDY_DIR="/var/lib/rundea/caddy"
CADDY_DATA_DIR="/var/lib/rundea/caddy-data"
CADDY_CONFIG_DIR="/var/lib/rundea/caddy-config"

[[ -f "$AGENT_ENV" ]] || {
  echo "Rundea Agent must be installed before managed-ingress takeover" >&2
  exit 1
}
systemctl is-active --quiet rundea-agent || {
  echo "rundea-agent must be active before managed-ingress takeover" >&2
  exit 1
}
strings /usr/local/bin/rundea-agent | grep -q 'RUNDEA_RESERVED_INGRESS_ROUTES' || {
  echo "installed Rundea Agent does not support reserved system ingress; install Agent 0.1.2 or later first" >&2
  exit 1
}

curl --fail --silent --show-error \
  --connect-timeout 3 --max-time 5 \
  "http://127.0.0.1:${SYSTEM_PORT}/health" >/dev/null || {
    echo "Rundea web gateway is not healthy on loopback port ${SYSTEM_PORT}; refusing ingress takeover" >&2
    exit 1
  }

install -d -m 0700 "$CADDY_DIR" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"

edge_id="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile bootstrap-ingress ps -q edge)"
[[ -n "$edge_id" ]] || {
  echo "bootstrap edge is not running; refusing an unverified takeover" >&2
  exit 1
}

# Preserve the existing ACME state to avoid needless certificate re-issuance.
docker cp "${edge_id}:/data/." "$CADDY_DATA_DIR/" >/dev/null 2>&1 || true
docker cp "${edge_id}:/config/." "$CADDY_CONFIG_DIR/" >/dev/null 2>&1 || true

cat >"$CADDY_DIR/Caddyfile" <<EOF
${SYSTEM_HOSTNAME} {
	reverse_proxy 127.0.0.1:${SYSTEM_PORT}
}
EOF
chmod 0600 "$CADDY_DIR/Caddyfile"

docker run --rm \
  -v "$CADDY_DIR:/etc/caddy:ro" \
  "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

env_tmp="$(mktemp)"
cleanup() {
  rm -f "$env_tmp"
}
trap cleanup EXIT

old_dropin=""
if [[ -f "$AGENT_DROPIN" ]]; then
  old_dropin="$(cat "$AGENT_DROPIN")"
fi
install -d -m 0755 "$AGENT_DROPIN_DIR"
cat >"$AGENT_DROPIN" <<EOF
[Service]
Environment=RUNDEA_RESERVED_INGRESS_ROUTES=${SYSTEM_HOSTNAME}=${SYSTEM_PORT}
EOF
chmod 0644 "$AGENT_DROPIN"
systemctl daemon-reload

restore_agent_configuration() {
  if [[ -n "$old_dropin" ]]; then
    printf '%s\n' "$old_dropin" >"$AGENT_DROPIN"
    chmod 0644 "$AGENT_DROPIN"
  else
    rm -f "$AGENT_DROPIN"
  fi
  systemctl daemon-reload
}

rollback_bootstrap_edge() {
  docker rm -f "$CADDY_CONTAINER" >/dev/null 2>&1 || true
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile bootstrap-ingress up -d edge >/dev/null 2>&1 || true
  restore_agent_configuration
  systemctl restart rundea-agent >/dev/null 2>&1 || true
}

# Stop the Agent before changing the public ingress owner. This prevents an
# application-domain reconciliation from racing the bootstrap handoff.
systemctl stop rundea-agent

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile bootstrap-ingress stop edge >/dev/null
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile bootstrap-ingress rm -f edge >/dev/null

if ! docker run -d \
  --name "$CADDY_CONTAINER" \
  --restart unless-stopped \
  --network host \
  --label rundea.managed=true \
  --label rundea.role=ingress \
  -v "$CADDY_DIR:/etc/caddy:ro" \
  -v "$CADDY_DATA_DIR:/data" \
  -v "$CADDY_CONFIG_DIR:/config" \
  "$CADDY_IMAGE" \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
  rollback_bootstrap_edge
  echo "managed Caddy failed to start; bootstrap edge and Agent were restored" >&2
  exit 1
fi

public_ok=false
for _attempt in $(seq 1 30); do
  if curl --fail --silent --show-error \
    --connect-timeout 3 --max-time 5 \
    "https://${SYSTEM_HOSTNAME}/health" >/dev/null 2>&1; then
    public_ok=true
    break
  fi
  sleep 1
done

if [[ "$public_ok" != true ]]; then
  rollback_bootstrap_edge
  echo "managed ingress did not pass public HTTPS health; bootstrap edge and Agent were restored" >&2
  exit 1
fi

systemctl start rundea-agent
systemctl is-active --quiet rundea-agent || {
  rollback_bootstrap_edge
  echo "rundea-agent did not start with reserved ingress; bootstrap edge and previous Agent configuration were restored" >&2
  exit 1
}

awk '!/^RUNDEA_INGRESS_MODE=/' "$ENV_FILE" >"$env_tmp"
printf 'RUNDEA_INGRESS_MODE=managed\n' >>"$env_tmp"
chmod --reference="$ENV_FILE" "$env_tmp"
mv "$env_tmp" "$ENV_FILE"

echo "Managed ingress takeover complete: ${SYSTEM_HOSTNAME} stays on Rundea-owned 80/443."
