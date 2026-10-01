#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${RUNDEA_STAGING_AUTOUPDATE_CONFIG:-/etc/rundea/staging-autoupdate.env}"
[[ -f "$CONFIG_FILE" ]] || { echo "missing staging autoupdate config: $CONFIG_FILE" >&2; exit 1; }

# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${RUNDEA_STAGING_ENV_FILE:?RUNDEA_STAGING_ENV_FILE is required}"
: "${RUNDEA_STAGING_REPO_DIR:?RUNDEA_STAGING_REPO_DIR is required}"

[[ "${EUID}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$RUNDEA_STAGING_ENV_FILE" ]] || { echo "staging env file is unavailable" >&2; exit 1; }
[[ -d "$RUNDEA_STAGING_REPO_DIR/.git" ]] || { echo "staging repository checkout is unavailable" >&2; exit 1; }

for command in git docker curl flock mktemp awk grep install systemctl python3 stat seq sleep cp chmod; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

exec 9>/run/rundea-staging-autoupdate.lock
flock -n 9 || exit 0

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$RUNDEA_STAGING_ENV_FILE"
}

current_tag="$(read_env_value RUNDEA_IMAGE_TAG)"
ingress_mode="$(read_env_value RUNDEA_INGRESS_MODE)"
[[ "$current_tag" =~ ^[0-9a-f]{40}$ ]] || { echo "current RUNDEA_IMAGE_TAG is not an immutable SHA" >&2; exit 1; }
[[ "$ingress_mode" == "managed" ]] || { echo "automatic staging deploy requires RUNDEA_INGRESS_MODE=managed" >&2; exit 1; }

git -C "$RUNDEA_STAGING_REPO_DIR" remote get-url origin | grep -Eq '^https://github\.com/annetbg-wq/Rundea(\.git)?$' || {
  echo "unexpected staging repository origin" >&2
  exit 1
}
git -C "$RUNDEA_STAGING_REPO_DIR" fetch --quiet --prune origin main
target="$(git -C "$RUNDEA_STAGING_REPO_DIR" rev-parse origin/main)"
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || { echo "could not resolve immutable main SHA" >&2; exit 1; }

if [[ "$target" == "$current_tag" ]]; then
  echo "Rundea staging already current: $current_tag"
  exit 0
fi

runs_json="$(mktemp /tmp/rundea-staging-runs.XXXXXX)"
trap 'rm -f "$runs_json"' RETURN
if ! curl -fsS --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 20 \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: Rundea-Staging-Autoupdate' \
  "https://api.github.com/repos/annetbg-wq/Rundea/actions/runs?head_sha=$target&event=push&per_page=100" \
  -o "$runs_json"; then
  echo "could not read GitHub safety gates; will retry automatically"
  rm -f "$runs_json"
  trap - RETURN
  exit 0
fi
if ! python3 - "$runs_json" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)

required = {"ci", "node-acceptance", "live-runtime-image"}
successful = {
    str(run.get("name"))
    for run in payload.get("workflow_runs", [])
    if run.get("status") == "completed" and run.get("conclusion") == "success"
}
missing = sorted(required - successful)
if missing:
    print("waiting for successful main gates: " + ", ".join(missing))
    raise SystemExit(1)
PY
then
  rm -f "$runs_json"
  trap - RETURN
  exit 0
fi
rm -f "$runs_json"
trap - RETURN

api_image="ghcr.io/annetbg-wq/rundea-api:$target"
web_image="ghcr.io/annetbg-wq/rundea-web:$target"
for image in "$api_image" "$web_image"; do
  if ! docker manifest inspect "$image" >/dev/null 2>&1; then
    echo "staging image not published yet: $image; will retry automatically"
    exit 0
  fi
done

tmp_env="$(mktemp /etc/rundea/staging.env.next.XXXXXX)"
backup_env="$(mktemp /etc/rundea/staging.env.previous.XXXXXX)"
cleanup() { rm -f "$tmp_env" "$backup_env"; }
trap cleanup EXIT

cp -p "$RUNDEA_STAGING_ENV_FILE" "$backup_env"
awk -v sha="$target" '
  BEGIN { replaced=0 }
  /^RUNDEA_IMAGE_TAG=/ { print "RUNDEA_IMAGE_TAG=" sha; replaced=1; next }
  { print }
  END { if (!replaced) print "RUNDEA_IMAGE_TAG=" sha }
' "$RUNDEA_STAGING_ENV_FILE" >"$tmp_env"
chmod --reference="$RUNDEA_STAGING_ENV_FILE" "$tmp_env"

previous_checkout="$(git -C "$RUNDEA_STAGING_REPO_DIR" rev-parse HEAD)"
git -C "$RUNDEA_STAGING_REPO_DIR" checkout --quiet --detach "$target"
install -m "$(stat -c '%a' "$RUNDEA_STAGING_ENV_FILE")" "$tmp_env" "$RUNDEA_STAGING_ENV_FILE"

deploy_script="$RUNDEA_STAGING_REPO_DIR/infra/live/DEPLOY_STAGING.sh"

rollback() {
  echo "staging update to $target failed; rolling back to $current_tag" >&2
  cp -p "$backup_env" "$RUNDEA_STAGING_ENV_FILE"
  git -C "$RUNDEA_STAGING_REPO_DIR" checkout --quiet --detach "$current_tag" 2>/dev/null ||     git -C "$RUNDEA_STAGING_REPO_DIR" checkout --quiet --detach "$previous_checkout"
  bash "$RUNDEA_STAGING_REPO_DIR/infra/live/DEPLOY_STAGING.sh" "$RUNDEA_STAGING_ENV_FILE" || true
}

if ! bash "$deploy_script" "$RUNDEA_STAGING_ENV_FILE"; then
  rollback
  exit 1
fi

healthy=0
for _attempt in $(seq 1 36); do
  api_ok=0
  web_ok=0
  public_ok=0
  curl -fsS --connect-timeout 3 --max-time 5 http://127.0.0.1:4000/health >/dev/null 2>&1 && api_ok=1
  curl -fsS --connect-timeout 3 --max-time 5 http://127.0.0.1:4100/health >/dev/null 2>&1 && web_ok=1
  curl -fsS --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 8 https://rundea.bachopus.com/health >/dev/null 2>&1 && public_ok=1
  if [[ "$api_ok" == 1 && "$web_ok" == 1 && "$public_ok" == 1 ]]; then
    healthy=1
    break
  fi
  sleep 5
done

if [[ "$healthy" != 1 ]]; then
  rollback
  exit 1
fi

echo "Rundea staging updated safely: $current_tag -> $target"
