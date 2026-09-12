#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
if [[ -z "$ENV_FILE" ]]; then
  echo "usage: $0 /absolute/path/to/staging.env" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "staging environment file not found: $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${RUNDEA_IMAGE_TAG:?RUNDEA_IMAGE_TAG is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${RUNDEA_CONTROL_TOKEN:?RUNDEA_CONTROL_TOKEN is required}"
: "${RUNDEA_MASTER_KEY:?RUNDEA_MASTER_KEY is required}"

if [[ ! "$RUNDEA_IMAGE_TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "RUNDEA_IMAGE_TAG must be an exact 40-character Git commit SHA" >&2
  exit 2
fi

COMPOSE_FILE="$(cd "$(dirname "$0")" && pwd)/docker-compose.staging.yml"
docker compose -f "$COMPOSE_FILE" pull api edge postgres
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

docker compose -f "$COMPOSE_FILE" ps
