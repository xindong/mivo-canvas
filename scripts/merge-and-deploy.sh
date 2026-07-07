#!/usr/bin/env bash
# Deploy main to the L20-1 BFF host. If a PR number is given, merge it first;
# if omitted, assumes main is already up to date on GitHub and just deploys.
#
# Usage:
#   MIVO_DEPLOY_HOST=<host> MIVO_DEPLOY_USER=<user> scripts/merge-and-deploy.sh [PR_NUMBER]
#
# Requires locally: gh (authenticated, with merge rights on this repo, only
# needed when PR_NUMBER is given) and ssh access to the deploy host as your
# own user (matches the deploy.sh owner on the server). Host/user are
# required env vars on purpose — this repo is public, so the deploy host
# address must not be hardcoded/committed.
set -euo pipefail

PR="${1:-}"
DEPLOY_HOST="${MIVO_DEPLOY_HOST:?请设置 MIVO_DEPLOY_HOST 为部署机地址（仓库是公开的，不写进代码库）}"
DEPLOY_USER="${MIVO_DEPLOY_USER:?请设置 MIVO_DEPLOY_USER 为部署机上的账号名}"

if [[ -n "${PR}" ]]; then
  echo "[ship] merging PR #${PR}"
  gh pr merge "${PR}" --repo xindong/mivo-canvas --squash --delete-branch
fi

echo "[ship] deploying main on ${DEPLOY_USER}@${DEPLOY_HOST}"
ssh "${DEPLOY_USER}@${DEPLOY_HOST}" '/AIGC_Group/mivo-canvas/deploy.sh'

echo '[ship] done'
