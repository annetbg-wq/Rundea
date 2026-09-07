#!/usr/bin/env bash
set -euo pipefail
: "${RUNDEA_AGENT_URL:?set RUNDEA_AGENT_URL to a released rundea-agent binary}"
: "${RUNDEA_CONTROL_PLANE_URL:?set RUNDEA_CONTROL_PLANE_URL}"
: "${RUNDEA_NODE_ID:?set RUNDEA_NODE_ID}"
: "${RUNDEA_NODE_TOKEN:?set RUNDEA_NODE_TOKEN}"
if [[ ${EUID} -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
command -v docker >/dev/null || { echo "Docker must be installed first" >&2; exit 1; }
command -v git >/dev/null || { echo "Git must be installed first" >&2; exit 1; }
install -d -m 0700 /etc/rundea /var/lib/rundea
curl --fail --location --proto '=https' --tlsv1.2 "$RUNDEA_AGENT_URL" -o /usr/local/bin/rundea-agent
chmod 0755 /usr/local/bin/rundea-agent
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
