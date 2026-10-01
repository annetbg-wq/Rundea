#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
REPO_DIR="${2:-/opt/rundea-staging-src}"
[[ "${EUID}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -n "$ENV_FILE" && "$ENV_FILE" = /* && -f "$ENV_FILE" ]] || {
  echo "usage: $0 /absolute/path/to/staging.env [/opt/rundea-staging-src]" >&2
  exit 2
}

for command in git docker curl flock systemctl install; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

install -d -m 0700 /etc/rundea
if [[ ! -d "$REPO_DIR/.git" ]]; then
  rm -rf "$REPO_DIR"
  git clone --quiet https://github.com/annetbg-wq/Rundea.git "$REPO_DIR"
else
  git -C "$REPO_DIR" remote get-url origin | grep -Eq '^https://github\.com/annetbg-wq/Rundea(\.git)?$' || {
    echo "existing repository has an unexpected origin" >&2
    exit 1
  }
fi
git -C "$REPO_DIR" fetch --quiet --prune origin main
git -C "$REPO_DIR" checkout --quiet --detach origin/main

install -m 0755 "$REPO_DIR/infra/live/STAGING_AUTOUPDATE.sh" /usr/local/sbin/rundea-staging-autoupdate
{
  printf 'RUNDEA_STAGING_ENV_FILE=%q\n' "$ENV_FILE"
  printf 'RUNDEA_STAGING_REPO_DIR=%q\n' "$REPO_DIR"
} >/etc/rundea/staging-autoupdate.env
chmod 0600 /etc/rundea/staging-autoupdate.env

cat >/etc/systemd/system/rundea-staging-autoupdate.service <<'UNIT'
[Unit]
Description=Rundea staging safe immutable autodeploy
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/rundea-staging-autoupdate
UNIT

cat >/etc/systemd/system/rundea-staging-autoupdate.timer <<'UNIT'
[Unit]
Description=Check for verified Rundea staging images

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now rundea-staging-autoupdate.timer
systemctl start rundea-staging-autoupdate.service

echo "Rundea staging autodeploy installed. Future main images are checked every ~5 minutes with health-gated rollback."
