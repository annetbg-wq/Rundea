#!/usr/bin/env bash
set -euo pipefail

: "${RUNDEA_CONTROL_PLANE_URL:?set RUNDEA_CONTROL_PLANE_URL}"
: "${RUNDEA_NODE_ID:?set RUNDEA_NODE_ID}"
: "${RUNDEA_NODE_TOKEN:?set RUNDEA_NODE_TOKEN to the one-time bootstrap token}"

if [[ ${EUID} -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
RUNDEA_CONTROL_PLANE_URL="${RUNDEA_CONTROL_PLANE_URL%/}"
[[ "$RUNDEA_CONTROL_PLANE_URL" == https://* ]] || { echo "Installed Rundea nodes require an https:// control plane URL" >&2; exit 1; }
for command in docker git curl sha256sum systemctl head od tr df awk uname install mktemp seq sleep; do
  command -v "$command" >/dev/null || { echo "$command must be installed first" >&2; exit 1; }
done

case "$(uname -m)" in
  x86_64|amd64) rundea_arch="amd64" ;;
  aarch64|arm64) rundea_arch="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m). Rundea currently publishes linux/amd64 and linux/arm64 Agent binaries." >&2; exit 1 ;;
esac

[[ -d /run/systemd/system ]] || { echo "Rundea Agent requires a systemd-based Linux host" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon is not available to root" >&2; exit 1; }

min_free_mb="${RUNDEA_MIN_FREE_DISK_MB:-2048}"
[[ "$min_free_mb" =~ ^[0-9]+$ ]] && (( min_free_mb >= 512 )) || {
  echo "RUNDEA_MIN_FREE_DISK_MB must be an integer of at least 512" >&2
  exit 1
}
free_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
[[ "$free_mb" =~ ^[0-9]+$ ]] || { echo "Could not determine free disk space" >&2; exit 1; }
(( free_mb >= min_free_mb )) || {
  echo "Insufficient free disk: ${free_mb} MB available; Rundea requires at least ${min_free_mb} MB before installation" >&2
  exit 1
}

# Prove outbound HTTPS/TLS connectivity to the exact Control Plane before the
# one-time credential is ever consumed. This catches DNS, firewall, proxy and
# certificate problems while the installation is still safely retryable.
curl --fail --silent --show-error \
  --proto '=https' --tlsv1.2 --max-redirs 0 \
  --connect-timeout 10 --max-time 15 \
  "${RUNDEA_CONTROL_PLANE_URL}/health" >/dev/null || {
    echo "Cannot reach Rundea Control Plane health endpoint over HTTPS" >&2
    exit 1
  }

if command -v ss >/dev/null 2>&1; then
  busy_ingress="$(ss -H -ltn 2>/dev/null | awk '$4 ~ /:(80|443)$/ {print $4}' | tr '\n' ' ')"
  if [[ -n "$busy_ingress" ]]; then
    echo "warning: ports 80/443 already have listeners (${busy_ingress}); Rundea public domain ingress may require resolving that conflict" >&2
  fi
fi

if [[ -n "${RUNDEA_AGENT_URL:-}" || -n "${RUNDEA_AGENT_SHA256:-}" ]]; then
  [[ -n "${RUNDEA_AGENT_URL:-}" && -n "${RUNDEA_AGENT_SHA256:-}" ]] || {
    echo "RUNDEA_AGENT_URL and RUNDEA_AGENT_SHA256 must be provided together" >&2
    exit 1
  }
  [[ "$RUNDEA_AGENT_URL" == https://* ]] || { echo "RUNDEA_AGENT_URL must use https://" >&2; exit 1; }
  [[ "$RUNDEA_AGENT_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "RUNDEA_AGENT_SHA256 must be a 64-character hex SHA-256" >&2; exit 1; }
fi

install -d -m 0700 /etc/rundea /var/lib/rundea /var/lib/rundea/deployments

tmp_agent="$(mktemp /tmp/rundea-agent.XXXXXX)"
tmp_bootstrap_config="$(mktemp /tmp/rundea-bootstrap-curl.XXXXXX)"
tmp_exchange_config="$(mktemp /tmp/rundea-exchange-curl.XXXXXX)"
tmp_self_config="$(mktemp /tmp/rundea-self-curl.XXXXXX)"
cleanup() { rm -f "$tmp_agent" "$tmp_bootstrap_config" "$tmp_exchange_config" "$tmp_self_config"; }
trap cleanup EXIT
chmod 0600 "$tmp_bootstrap_config" "$tmp_exchange_config" "$tmp_self_config"

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

# Capability preflight is executed against the verified binary before the
# bootstrap credential is consumed. This prevents installing a valid but
# protocol-incompatible Agent and makes feature support explicit rather than
# inferring it by inspecting strings inside the executable.
chmod 0700 "$tmp_agent"
agent_identity="$("$tmp_agent" --identity 2>/dev/null || true)"
[[ -n "$agent_identity" ]] || {
  echo "Downloaded Rundea Agent does not expose a valid self-identity" >&2
  exit 1
}
for capability in artifactRetention buildArgs buildGuardrails continuousHealth managedIngress nodeCapacity nodeDiskMetrics persistentVolumes resourceGuardrails runtimeMetrics; do
  if ! "$tmp_agent" "--require-capability=${capability}" >/dev/null 2>&1; then
    echo "Downloaded Rundea Agent is missing required capability: ${capability}" >&2
    exit 1
  fi
done
printf 'Verified Rundea Agent identity before install: %s\n' "$agent_identity"

# Prepare every durable local artifact before consuming the one-time bootstrap
# credential. If release download, checksum/capability verification, file
# installation or unit creation fails, the bootstrap token remains valid and
# the command can be safely retried.
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

cat >"$tmp_self_config" <<EOF
silent
show-error
fail
header = "Authorization: Bearer ${agent_token}"
EOF

systemctl daemon-reload
systemctl enable --now rundea-agent

# Success is server-authoritative. Do not tell the user the node is installed
# merely because systemd started a process; wait until the authenticated Agent
# WebSocket has made this exact node ONLINE in the Control Plane.
self_status=""
for _attempt in $(seq 1 30); do
  self_status="$(curl --config "$tmp_self_config" \
    --proto '=https' --tlsv1.2 --max-redirs 0 \
    --connect-timeout 5 --max-time 10 \
    "${RUNDEA_CONTROL_PLANE_URL}/v0/nodes/${RUNDEA_NODE_ID}/self/status" 2>/dev/null || true)"
  self_status="$(printf '%s' "$self_status" | tr -d '[:space:]')"
  if [[ "$self_status" == "ONLINE" ]]; then
    echo "Rundea node ${RUNDEA_NODE_ID} is ONLINE (${rundea_arch}, ${free_mb} MB free disk)."
    exit 0
  fi
  sleep 1
done

systemctl --no-pager --full status rundea-agent || true
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u rundea-agent --no-pager -n 50 || true
fi
echo "Rundea Agent was installed but node ${RUNDEA_NODE_ID} did not become ONLINE within 30 seconds. Permanent credentials are preserved in /etc/rundea/agent.env; fix connectivity and restart rundea-agent." >&2
exit 1