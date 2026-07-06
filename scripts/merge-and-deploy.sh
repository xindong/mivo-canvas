#!/usr/bin/env bash
# One-shot ship: merge an approved+green PR on xindong/mivo-canvas, then
# deploy main to the L20-1 BFF host in a single command.
#
# Usage: scripts/merge-and-deploy.sh <PR_NUMBER>
#
# Requires locally: gh (authenticated, with merge rights on this repo) and
# ssh access to the deploy host as your own user (matches the deploy.sh
# owner on the server).
set -euo pipefail

PR="${1:?Usage: scripts/merge-and-deploy.sh <PR_NUMBER>}"
DEPLOY_HOST="${MIVO_DEPLOY_HOST:-49.234.14.155}"
DEPLOY_USER="${MIVO_DEPLOY_USER:-$(whoami)}"

echo "[ship] merging PR #${PR}"
gh pr merge "${PR}" --repo xindong/mivo-canvas --squash --delete-branch

echo "[ship] deploying main on ${DEPLOY_USER}@${DEPLOY_HOST}"
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" '/AIGC_Group/mivo-canvas/deploy.sh'

echo '[ship] done'
