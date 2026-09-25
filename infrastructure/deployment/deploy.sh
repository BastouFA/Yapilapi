#!/usr/bin/env bash
# Deploy a tagged image set to a single Docker host over SSH. Used by .github/workflows/deploy.yml.
# Required env: DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY_FILE, TAG. Optional: REGISTRY, DEPLOY_DIR.
set -euo pipefail
: "${DEPLOY_HOST:?DEPLOY_HOST is not configured for this environment}"
: "${DEPLOY_USER:?}" "${DEPLOY_SSH_KEY_FILE:?}" "${TAG:?}"
DIR="${DEPLOY_DIR:-/opt/yapilapi}"
SSH=(ssh -i "$DEPLOY_SSH_KEY_FILE" -o StrictHostKeyChecking=yes "$DEPLOY_USER@$DEPLOY_HOST")
scp -i "$DEPLOY_SSH_KEY_FILE" infrastructure/deployment/compose.prod.yml "$DEPLOY_USER@$DEPLOY_HOST:$DIR/compose.yml"
"${SSH[@]}" "cd $DIR && export TAG=$TAG REGISTRY=${REGISTRY:-ghcr.io/yapilapi} \
  && docker compose -f compose.yml pull \
  && docker compose -f compose.yml --profile ops run --rm migrate \
  && docker compose -f compose.yml up -d --remove-orphans"
# Post-deploy smoke check through the public URL (set SMOKE_URL); a failure exits non-zero so the job is red.
if [ -n "${SMOKE_URL:-}" ]; then
  for i in $(seq 1 30); do
    if curl -fsS "$SMOKE_URL/health/ready" >/dev/null; then echo "ready"; exit 0; fi
    sleep 5
  done
  echo "smoke check failed: $SMOKE_URL/health/ready" >&2; exit 1
fi
