#!/usr/bin/env bash
# ops/postgres/asset-verify.sh — F4 返修:asset snapshot 内容校验 lib(sourceable,无副作用)。
# 被 restore-drill.sh source;也供 ops/postgres/test-asset-verify.sh 单测(无 docker/PG)。
#
# asset 是 fs 内容寻址存储(不进 PG dump):<root>/<hash[0:2]>/<hash>.bin + <hash>.meta.json。
# 内容寻址不变量:文件名 = sha256(bytes) hex64。本 lib 真解压 snapshot → 逐 .bin 算 sha256 比对文件名
# + 检查 .meta.json 配对 + 与 manifest 的 assetBlobCount 比对。任一不符 → return 1(restore-drill 据此阻断 PASS)。
#
# 设计为**无 set -e 副作用**(sourced;不在 source 时执行主体),函数内部全部用 guard(`|| true`/`if`),
# 避免被宿主脚本的 `set -euo pipefail` 误杀导致单 blob 失败直接 abort drill。

# 计算 file 的 sha256 hex(portable:sha256sum / shasum -a 256;失败返空串而非非零,防 set -e 误杀)。
compute_sha256() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" 2>/dev/null | awk '{print $1}' || true
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" 2>/dev/null | awk '{print $1}' || true
  else
    echo ""
  fi
}

# 读 manifest JSON 字段(jq 优先;无 jq 或读失败 → "-1" 表"未知,跳过比对")。
# $1=manifest 路径,$2=jq path(如 '.assetBlobCount' 或 '.tables.persist_records')。
manifest_field() {
  local manifest="$1" path="$2"
  if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then echo -1; return; fi
  if command -v jq >/dev/null 2>&1; then
    jq -r "${path} // \"-1\"" "$manifest" 2>/dev/null || echo -1
  else
    echo -1  # 无 jq → 视为未知,不阻断(不假绿:返 -1,调用方判 != 实际 即 mismatch,但 -1 被显式跳过)
  fi
}

# F4:校验 asset snapshot tar。
#   $1 = snap 文件(.tar.gz)
#   $2 = manifest 路径(可选;传 "" 或缺省 → 跳过 manifest blob count 比对)
#   stdout = 人类可读 detail 行(每行一个 finding 或 ok 总结)
#   return 0 = ok;1 = fail(损坏 tar / 哈希不匹配 / 缺 metadata / blob 数 mismatch)
verify_asset_snapshot() {
  local snap="$1" manifest="${2:-}"
  if [ -z "$snap" ] || [ ! -f "$snap" ]; then
    echo "fail-no-snapshot: snap not found ($snap)"
    return 1
  fi
  local tmp; tmp="$(mktemp -d 2>/dev/null || mktemp -d -t assetverify)"
  local blob_count=0 hash_mismatch=0 meta_missing=0 mc_mismatch=0
  if ! tar -xzf "$snap" -C "$tmp" 2>/dev/null; then
    echo "fail-corrupt-tar: tar -xzf $snap non-zero (snapshot 损坏/非 gzip)"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  # 内容寻址:逐 .bin 算 sha256 比对文件名 + 检查 .meta.json 配对。
  local binf bname actual metaf
  while IFS= read -r -d '' binf; do
    blob_count=$((blob_count + 1))
    bname="$(basename "$binf" .bin)"
    actual="$(compute_sha256 "$binf")"
    if [ -z "$actual" ] || [ "$actual" != "$bname" ]; then
      hash_mismatch=$((hash_mismatch + 1))
      echo "fail-hash-mismatch: $bname (content sha256=${actual:-<unavailable>} != filename) — 内容损坏"
    fi
    metaf="$(dirname "$binf")/$bname.meta.json"
    if [ ! -f "$metaf" ]; then
      meta_missing=$((meta_missing + 1))
      echo "fail-missing-meta: $bname has no paired .meta.json — metadata 丢失"
    fi
  done < <(find "$tmp" -type f -name '*.bin' -print0 2>/dev/null)
  # manifest assetBlobCount 比对(若有 manifest 且 jq 可读)。
  local manifest_blobs="-1"
  if [ -n "$manifest" ] && [ -f "$manifest" ]; then
    manifest_blobs="$(manifest_field "$manifest" '.assetBlobCount')"
    if [ "$manifest_blobs" != "-1" ] && [ "$manifest_blobs" != "$blob_count" ]; then
      mc_mismatch=1
      echo "fail-blob-count: manifest assetBlobCount=$manifest_blobs vs snapshot=$blob_count — 快照不完整"
    fi
  fi
  rm -rf "$tmp" 2>/dev/null || true
  if [ "$hash_mismatch" -gt 0 ] || [ "$meta_missing" -gt 0 ] || [ "$mc_mismatch" -gt 0 ]; then
    echo "fail-summary: blobs=$blob_count hashMismatch=$hash_mismatch metaMissing=$meta_missing countMismatch=$mc_mismatch"
    return 1
  fi
  echo "ok: blobs=$blob_count sha256-verified metadata-paired manifest-blobs=${manifest_blobs:--1}"
  return 0
}
