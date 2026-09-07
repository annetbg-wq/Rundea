#!/usr/bin/env bash
set -euo pipefail
: "${RUNDEA_AGENT_URL:?set RUNDEA_AGENT_URL to a released rundea-agent binary}"
: "${RUNDEA_AGENT_SHA256:?set RUNDEA_AGENT_SHA256 to the published SHA-256 checksum}"
: "${RUNDEA_CONTROL_PLANE_URL:?set RUNDEA_CONTROL_PLANE_URL}"
: "${RUNDEA_NODE_ID:?set RUNDEA_NODE_ID}"
: "${RUNDEA_NODE_TOKEN:?set RUNDEA_NODE_TOKEN}"
if [[ ${EUID} -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
command -v docker >/dev/null || { echo "Docker must be installed first" >&2; exit 1; }
command -v git >/dev/null || { echo "Git must be installed first" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl must be installed first" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum must be installed first" >&2; exit 1; }
[[ "$RUNDEA_AGENT_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || { echo "RUNDEA_AGENT_SHA256 must be a 64-character hex SHA-256" >&2; exit 1; }
install -d -m 0700 /etc/rundea /var/lib/rundea

tmp_agent="$(mktemp /tmp/rundea-agent.XXXXXX)"
cleanup() { rm -f "$tmp_agent"; }
trap cleanup EXIT
curl --fail --location --proto '=https' --tlsv1.2 "$RUNDEA_AGENT_URL" -o "$tmp_agent"
printf '%s  %s\n' "$RUNDEA_AGENT_SHA256" "$tmp_agent" | sha256sum --check --status || { echo "Rundea Agent checksum verification failed" >&2; exit 1; }
install -m 0755 "$tmp_agent" /usr/local/bin/rundea-agent

cat >/etc/rundea/agent.env <<EOF
RUNDEA_CONTROL_PLANE_URL=$RUNDEA_CONTROL_PLANE_URL
RUNDEA_NODE_ID=$RUNDEA_NODE_ID
RUNDEA_NODE_TOKEN=$RUNDEA_NODE_TOKEN
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
ExecStart=/usr/local/bin/rundea-agent
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now rundea-agent
systemctl --no-pager --full status rundea-agent || true
