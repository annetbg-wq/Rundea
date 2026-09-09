#!/usr/bin/env bash
set -euo pipefail

: "${RUNDEA_CONTROL_PLANE_URL:?set RUNDEA_CONTROL_PLANE_URL}"
: "${RUNDEA_NODE_ID:?set RUNDEA_NODE_ID}"
: "${RUNDEA_NODE_TOKEN:?set RUNDEA_NODE_TOKEN to the one-time bootstrap token}"

if [[ ${EUID} -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
RUNDEA_CONTROL_PLANE_URL="${RUNDEA_CONTROL_PLANE_URL%/}"
[[ "$RUNDEA_CONTROL_PLANE_URL" == https://* ]] || { echo "Installed Rundea nodes require an https:// control plane URL" >&2; exit 1; }
for command in docker git curl sha256sum systemctl head od tr; do
  command -v "$command" >/dev/null || { echo "$command must be installed first" >&2; exit 1; }
done

if [[ -n "${RUNDEA_AGENT_URL:-}" || -n "${RUNDEA_AGENT_SHA256:-}" ]]; then
  [[ -n "${RUNDEA_AGENT_URL:-}" && -n "${RUNDEA_AGENT_SHA256:-}" ]] || {
    echo "RUNDEA_AGENT_URL and RUNDEA_AGENT_SHA256 must be provided together" >&2
    exit 1
  }
  [[ "$RUNDEA_AGENT_URL" == https://* ]] || { echo "RUNDEA_AGENT_URL must use https://" >&2; exit 1; }
  [[ "$RUNDEA_AGENT_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "RUNDEA_AGENT_SHA256 must be a 64-character hex SHA-256" >&2; exit 1; }
fi

case "$(uname -m)" in
  x86_64|amd64) rundea_arch="amd64" ;;
  aarch64|arm64) rundea_arch="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m). Rundea currently publishes linux/amd64 and linux/arm64 Agent binaries." >&2; exit 1 ;;
esac

install -d -m 0700 /etc/rundea /var/lib/rundea /var/lib/rundea/deployments

tmp_agent="$(mktemp /tmp/rundea-agent.XXXXXX)"
tmp_bootstrap_config="$(mktemp /tmp/rundea-bootstrap-curl.XXXXXX)"
tmp_exchange_config="$(mktemp /tmp/rundea-exchange-curl.XXXXXX)"
cleanup() { rm -f "$tmp_agent" "$tmp_bootstrap_config" "$tmp_exchange_config"; }
trap cleanup EXIT
chmod 0600 "$tmp_bootstrap_config" "$tmp_exchange_config"

# A fresh node token is bootstrap-only. It may fetch the pinned Agent release,
# but it cannot authenticate the Agent WebSocket. Keep it in a private curl
# config so the credential never appears in the curl process command line.
cat >"$tmp_bootstrap_config" <<EOF
silent
show-error
fail
header = "Authorization: Bearer ${RUNDEA_NODE_TOKEN}"
header = "X-Rundea-Node-Id: ${RUNDEA_NODE_ID}"
EOF

if [[ -n "${RUNDEA_AGENT_URL:-}" ]]; then
  expected_sha="${RUNDEA_AGENT_SHA256,,}"
  curl --fail --location --proto '=https' --tlsv1.2 "$RUNDEA_AGENT_URL" -o "$tmp_agent"
else
  checksum_url="${RUNDEA_CONTROL_PLANE_URL}/v0/agent/releases/${rundea_arch}/sha256"
  binary_url="${RUNDEA_CONTROL_PLANE_URL}/v0/agent/releases/${rundea_arch}"
  expected_sha="$(curl --config "$tmp_bootstrap_config" --proto '=https' --tlsv1.2 --max-redirs 0 "$checksum_url")"
  expected_sha="$(printf '%s' "$expected_sha" | tr -d '[:space:]')"
  [[ "$expected_sha" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "Control Plane returned an invalid Agent checksum" >&2; exit 1; }
  expected_sha="${expected_sha,,}"
  curl --config "$tmp_bootstrap_config" --proto '=https' --tlsv1.2 --max-redirs 0 "$binary_url" -o "$tmp_agent"
fi

printf '%s  %s\n' "$expected_sha" "$tmp_agent" | sha256sum --check --status || {
  echo "Rundea Agent checksum verification failed" >&2
  exit 1
}

# Prepare every durable local artifact before consuming the one-time bootstrap
# credential. If release download, checksum verification, file installation or
# unit creation fails, the bootstrap token remains valid and the command can be
# safely retried.
install -m 0755 "$tmp_agent" /usr/local/bin/rundea-agent
agent_token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[[ "$agent_token" =~ ^[a-f0-9]{64}$ ]] || { echo "failed to generate Agent credential" >&2; exit 1; }

cat >/etc/rundea/agent.env <<EOF
RUNDEA_CONTROL_PLANE_URL=$RUNDEA_CONTROL_PLANE_URL
RUNDEA_NODE_ID=$RUNDEA_NODE_ID
RUNDEA_NODE_TOKEN=$agent_token
RUNDEA_WORK_DIR=/var/lib/rundea
EOF
chmod 0600 /etc/rundea/agent.env

cat >/etc/systemd/system/rundea-agent.service <<'EOF'
[Unit]
Description=Rundea Node Agent
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
EnvironmentFile=/etc/rundea/agent.env
ExecStartPre=/usr/bin/find /var/lib/rundea/deployments -name runtime.env -type f -delete
ExecStart=/usr/local/bin/rundea-agent
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

cat >"$tmp_exchange_config" <<EOF
silent
show-error
fail
request = "POST"
header = "Authorization: Bearer ${RUNDEA_NODE_TOKEN}"
header = "Content-Type: application/json"
data = "{\"agentToken\":\"${agent_token}\"}"
EOF

# Commit point: rotate the server-side node credential only after the verified
# binary, durable Agent credential and systemd unit already exist locally. If a
# later systemd operation fails, /etc/rundea/agent.env still contains the valid
# permanent credential and recovery does not require the consumed bootstrap.
curl --config "$tmp_exchange_config" \
  --proto '=https' --tlsv1.2 --max-redirs 0 \
  "${RUNDEA_CONTROL_PLANE_URL}/v0/nodes/${RUNDEA_NODE_ID}/bootstrap/exchange" \
  -o /dev/null

unset RUNDEA_NODE_TOKEN
RUNDEA_NODE_TOKEN="$agent_token"
systemctl daemon-reload
systemctl enable --now rundea-agent
systemctl --no-pager --full status rundea-agent || true
