#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" ]]; then
  echo "usage: $0 /absolute/path/to/staging.env" >&2
  exit 2
fi
[[ ${EUID} -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "environment file not found: $ENV_FILE" >&2; exit 2; }
for command in docker awk mktemp chmod mv rm; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

CADDY_IMAGE="caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d"

printf 'Choose a Rundea web password (minimum 16 characters): '
IFS= read -r -s password
printf '\nRepeat the password: '
IFS= read -r -s confirmation
printf '\n'

if [[ "$password" != "$confirmation" ]]; then
  unset password confirmation
  echo "passwords do not match" >&2
  exit 1
fi
if (( ${#password} < 16 )); then
  unset password confirmation
  echo "password must contain at least 16 characters" >&2
  exit 1
fi

hash="$(docker run --rm "$CADDY_IMAGE" caddy hash-password --plaintext "$password")"
unset password confirmation
[[ "$hash" == \$2* ]] || { echo "Caddy did not return a bcrypt password hash" >&2; exit 1; }

tmp="$(mktemp)"
cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

awk '!/^RUNDEA_WEB_PASSWORD_HASH=/' "$ENV_FILE" >"$tmp"
printf "RUNDEA_WEB_PASSWORD_HASH='%s'\n" "$hash" >>"$tmp"
unset hash
chmod --reference="$ENV_FILE" "$tmp"
mv "$tmp" "$ENV_FILE"
trap - EXIT

echo "Rundea web password configured for username rundea."
