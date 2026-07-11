#!/usr/bin/env bash
# ops/postgres/test-asset-verify.sh — F4 asset snapshot verify 单元测试(无 docker/PG)。
# source asset-verify.sh,造合成 tar(内容寻址 .bin + .meta.json),覆盖 6 场景。
# 成功标准:全 PASS,FAIL=0;任一 case 该 fail 却 exit 0 / 该 ok 却 exit 1 → 非 0 退出。
# 跑法:bash ops/postgres/test-asset-verify.sh
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091  # 动态路径;已显式 source
. "$dir/asset-verify.sh"

PASS=0; FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sha() {
  local content="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$content" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$content" | shasum -a 256 | awk '{print $1}'
  fi
}

make_blob() {
  # $1=root $2=hex(hash) $3=content
  local root="$1" hex="$2" content="$3"
  local shard="${hex:0:2}"
  mkdir -p "$root/$shard"
  printf '%s' "$content" > "$root/$shard/$hex.bin"
  printf '{"contentHash":"%s","mimeType":"image/png"}' "$hex" > "$root/$shard/$hex.meta.json"
}

echo "=== F4 asset-verify unit tests ==="

# Case 1: valid snapshot (2 blobs, sha+meta ok) → exit 0
{
  root="$WORK/case1/assets"; mkdir -p "$root"
  H1="$(sha 'aaa')"; make_blob "$root" "$H1" 'aaa'
  H2="$(sha 'bbb')"; make_blob "$root" "$H2" 'bbb'
  snap="$WORK/case1.tar.gz"; tar -czf "$snap" -C "$WORK/case1" assets
  if verify_asset_snapshot "$snap" "" >/tmp/av1.out 2>&1; then
    ok "case1 valid snapshot (2 blobs) → exit 0"
  else
    bad "case1 valid snapshot should pass"; cat /tmp/av1.out
  fi
}

# Case 2: corrupt tar (not gzip) → exit 1
{
  printf 'not-a-tar-garbage' > "$WORK/corrupt.tar.gz"
  if ! verify_asset_snapshot "$WORK/corrupt.tar.gz" "" >/tmp/av2.out 2>&1; then
    ok "case2 corrupt tar → exit 1"
  else
    bad "case2 corrupt tar should fail"; cat /tmp/av2.out
  fi
}

# Case 3: hash mismatch (blob content != filename) → exit 1
{
  root="$WORK/case3/assets"; mkdir -p "$root"
  badhex="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  make_blob "$root" "$badhex" 'mismatched-content'
  snap="$WORK/case3.tar.gz"; tar -czf "$snap" -C "$WORK/case3" assets
  if ! verify_asset_snapshot "$snap" "" >/tmp/av3.out 2>&1; then
    ok "case3 hash mismatch (content != filename) → exit 1"
  else
    bad "case3 hash mismatch should fail"; cat /tmp/av3.out
  fi
}

# Case 4: missing .meta.json → exit 1
{
  root="$WORK/case4/assets"; mkdir -p "$root"
  H="$(sha 'meta-missing')"; shard="${H:0:2}"; mkdir -p "$root/$shard"
  printf '%s' 'meta-missing' > "$root/$shard/$H.bin"  # 故意无 .meta.json
  snap="$WORK/case4.tar.gz"; tar -czf "$snap" -C "$WORK/case4" assets
  if ! verify_asset_snapshot "$snap" "" >/tmp/av4.out 2>&1; then
    ok "case4 missing metadata → exit 1"
  else
    bad "case4 missing metadata should fail"; cat /tmp/av4.out
  fi
}

# Case 5: manifest blob count mismatch → exit 1
{
  root="$WORK/case5/assets"; mkdir -p "$root"
  H="$(sha 'count-test')"; make_blob "$root" "$H" 'count-test'
  snap="$WORK/case5.tar.gz"; tar -czf "$snap" -C "$WORK/case5" assets
  printf '{"assetBlobCount": 99}' > "$WORK/case5.manifest.json"
  if ! verify_asset_snapshot "$snap" "$WORK/case5.manifest.json" >/tmp/av5.out 2>&1; then
    ok "case5 manifest blob count mismatch (snap=1 vs manifest=99) → exit 1"
  else
    bad "case5 count mismatch should fail"; cat /tmp/av5.out
  fi
}

# Case 6: manifest blob count match → exit 0
{
  root="$WORK/case6/assets"; mkdir -p "$root"
  H="$(sha 'count-ok')"; make_blob "$root" "$H" 'count-ok'
  snap="$WORK/case6.tar.gz"; tar -czf "$snap" -C "$WORK/case6" assets
  printf '{"assetBlobCount": 1}' > "$WORK/case6.manifest.json"
  if verify_asset_snapshot "$snap" "$WORK/case6.manifest.json" >/tmp/av6.out 2>&1; then
    ok "case6 manifest blob count match (1==1) → exit 0"
  else
    bad "case6 count match should pass"; cat /tmp/av6.out
  fi
}

# Case 7: no snapshot file → exit 1
{
  if ! verify_asset_snapshot "$WORK/nonexistent.tar.gz" "" >/tmp/av7.out 2>&1; then
    ok "case7 no snapshot file → exit 1"
  else
    bad "case7 missing snapshot should fail"; cat /tmp/av7.out
  fi
}

echo "----------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
