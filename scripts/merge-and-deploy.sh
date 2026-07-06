#!/usr/bin/env bash
# One-shot ship: merge an approved+green PR on xindong/mivo-canvas, then
# deploy main to the L20-1 BFF host in a single command.
#
# Usage: MIVO_DEPLOY_HOST=<host> MIVO_DEPLOY_USER=<user> scripts/merge-and-deploy.sh <PR_NUMBER>
#
# Requires locally: gh (authenticated, with merge rights on this repo) and
# ssh access to the deploy host as your own user (matches the deploy.sh
# owner on the server). Host/user are required env vars on purpose — this
# repo is public, so the deploy host address must not be hardcoded/committed.
set -euo pipefail

PR="${1:?Usage: scripts/merge-and-deploy.sh <PR_NUMBER>}"
DEPLOY_HOST="${MIVO_DEPLOY_HOST:?请设置 MIVO_DEPLOY_HOST 为部署机地址（仓库是公开的，不写进代码库）}"
DEPLOY_USER="${MIVO_DEPLOY_USER:?请设置 MIVO_DEPLOY_USER 为部署机上的账号名}"

echo "[ship] merging PR #${PR}"
gh pr merge "${PR}" --repo xindong/mivo-canvas --squash --delete-branch

echo "[ship] deploying main on ${DEPLOY_USER}@${DEPLOY_HOST}"
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" '/AIGC_Group/mivo-canvas/deploy.sh'

echo '[ship] done'
