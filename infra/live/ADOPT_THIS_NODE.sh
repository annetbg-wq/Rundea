#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
CONTROL_PLANE_URL="${2:-${RUNDEA_PUBLIC_CONTROL_PLANE_URL:-https://rundea.bachopus.com}}"
NODE_NAME="${3:-$(hostname)}"

if [[ -z "$ENV_FILE" ]]; then
  echo "usage: $0 /absolute/path/to/staging.env [control-plane-url] [node-name]" >&2
  exit 2
fi
[[ ${EUID} -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "environment file not found: $ENV_FILE" >&2; exit 2; }
[[ "$CONTROL_PLANE_URL" == https://* ]] || { echo "control plane URL must use https://" >&2; exit 2; }
for command in curl python3 mktemp chmod rm hostname; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${RUNDEA_CONTROL_TOKEN:?RUNDEA_CONTROL_TOKEN is required in the environment file}"

response_file="$(mktemp)"
control_config="$(mktemp)"
installer_file="$(mktemp)"
cleanup() {
  rm -f "$response_file" "$control_config" "$installer_file"
}
trap cleanup EXIT
chmod 0600 "$response_file" "$control_config" "$installer_file"

cat >"$control_config" <<EOF
silent
show-error
fail
header = "Authorization: Bearer ${RUNDEA_CONTROL_TOKEN}"
header = "Content-Type: application/json"
EOF

node_payload="$(python3 - "$NODE_NAME" <<'PY'
import json, sys
print(json.dumps({"name": sys.argv[1]}))
PY
)"

curl --config "$control_config" \
  --request POST \
  --data "$node_payload" \
  --connect-timeout 5 --max-time 15 \
  "http://127.0.0.1:4000/v0/nodes" \
  -o "$response_file"

readarray -t node_fields < <(python3 - "$response_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    body = json.load(fh)
node_id = str(body.get("id", "")).strip()
token = str(body.get("token", "")).strip()
if not node_id or not token:
    raise SystemExit("Control Plane did not return node bootstrap credentials")
print(node_id)
print(token)
PY
)
NODE_ID="${node_fields[0]}"
NODE_TOKEN="${node_fields[1]}"

curl --fail --silent --show-error \
  --proto '=https' --tlsv1.2 --max-redirs 0 \
  --connect-timeout 5 --max-time 15 \
  "${CONTROL_PLANE_URL%/}/v0/install.sh" \
  -o "$installer_file"
chmod 0700 "$installer_file"

RUNDEA_CONTROL_PLANE_URL="${CONTROL_PLANE_URL%/}" \
RUNDEA_NODE_ID="$NODE_ID" \
RUNDEA_NODE_TOKEN="$NODE_TOKEN" \
  bash "$installer_file"

unset NODE_TOKEN RUNDEA_CONTROL_TOKEN
printf 'Rundea adopted this host as node %s (%s).\n' "$NODE_ID" "$NODE_NAME"
printf 'Next gate: verify the node is ONLINE, then perform managed-ingress takeover.\n'
