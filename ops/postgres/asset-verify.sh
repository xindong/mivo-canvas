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

# 文件大小(portable:GNU stat -c%s / BSD stat -f%z;失败返空串)。
stat_size() {
  local f="$1"
  stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo ""
}

# R2-3:metadata **内容**校验(旧实现只查 -f:sol3 造"hash 对但 .meta.json 内容为垃圾"tar → rc=0)。
# 校验:.meta.json 可解析为 JSON + 必要字段(contentHash/mimeType/sizeBytes) + contentHash==文件名==实 sha256
#       + sizeBytes==实大小。任一不符 → return 1(详细 reason 进 stdout)。
# $1=meta 路径 $2=文件名 hex(bname) $3=实 sha256 $4=实大小。
validate_meta() {
  local meta="$1" bname="$2" actual_hash="$3" actual_size="$4"
  if ! command -v jq >/dev/null 2>&1; then
    echo "fail-meta-no-jq: $bname — 无 jq 无法校验 metadata 内容(拒绝假绿:不跳过)"
    return 1
  fi
  local meta_json
  if ! meta_json="$(jq -e '.' "$meta" 2>/dev/null)"; then
    echo "fail-meta-malformed: $bname — .meta.json 非合法 JSON"
    return 1
  fi
  local mh mm ms
  mh="$(jq -r '.contentHash // empty' 2>/dev/null <<<"$meta_json")"
  mm="$(jq -r '.mimeType // empty' 2>/dev/null <<<"$meta_json")"
  ms="$(jq -r '.sizeBytes // empty' 2>/dev/null <<<"$meta_json")"
  if [ -z "$mh" ] || [ -z "$mm" ] || [ -z "$ms" ]; then
    echo "fail-meta-schema: $bname — 缺必要字段 contentHash/mimeType/sizeBytes(得 contentHash/mimeType/sizeBytes)"
    return 1
  fi
  if [ "$mh" != "$bname" ] || [ "$mh" != "$actual_hash" ]; then
    echo "fail-meta-hash: $bname — meta contentHash=$mh != filename/actual=$actual_hash"
    return 1
  fi
  if [ "$ms" != "$actual_size" ]; then
    echo "fail-meta-size: $bname — meta sizeBytes=$ms != actual=$actual_size"
    return 1
  fi
  return 0
}

# 读 manifest JSON 字段(jq 优先;无 jq 或读失败 → "-1" 表"未知,跳过比对")。
# $1=manifest 路径,$2=jq path(如 '.assetBlobCount' 或 '.tables.persist_records')。
# R2-2:**字段缺失**与**manifest 解析失败**是两件事:字段缺失(合法 JSON,key 缺)→ -1 跳过比对 OK;
#       manifest 解析失败(无 jq / 坏 JSON)→ 见 manifest_parse_status,restore-drill 据此 hard fail。
manifest_field() {
  local manifest="$1" path="$2"
  if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then echo -1; return; fi
  if command -v jq >/dev/null 2>&1; then
    jq -r "${path} // \"-1\"" "$manifest" 2>/dev/null || echo -1
  else
    echo -1  # 无 jq → 视为未知,不阻断(不假绿:返 -1,调用方判 != 实际 即 mismatch,但 -1 被显式跳过)
  fi
}

# R2-2:manifest 解析状态(区分"无 manifest"与"解析失败",后者 hard fail)。echo: absent / present / no-jq / malformed。
# - absent: 无文件(旧备份无 manifest;F3 行数比对 WARN 跳过)。
# - present: jq 在 + JSON 合法(字段缺失由 manifest_field 返 -1,调用方按矩阵处置)。
# - no-jq: 文件存在但环境无 jq(无法校验内容 → restore-drill hard fail,不假绿跳过)。
# - malformed: 文件存在 + jq 在 + 非 JSON(hard fail)。
manifest_parse_status() {
  local manifest="$1"
  if [ -z "$manifest" ] || [ ! -f "$manifest" ]; then echo absent; return; fi
  if ! command -v jq >/dev/null 2>&1; then echo no-jq; return; fi
  if jq -e '.' "$manifest" >/dev/null 2>&1; then echo present; else echo malformed; return; fi
}

# R2-2 矩阵:决定三核心表缺失的处置。echo: pass / warn / fail。
# $1=CORE_MISSING(0..3) $2=ALLOW_EMPTY_SCHEMA(0/1) $3=MANIFEST_PRESCHEMA("true"/空)
# 不变量:
#   - 0 缺失 → pass(全在)。
#   - >0 缺失 + ALLOW_EMPTY≠1 → fail(生产禁用 ALLOW_EMPTY,任何缺失必 fail)。
#   - ALLOW_EMPTY=1 **只许**三核心表全缺(3)+ manifest 明示 pre-schema(true)→ warn(legit pre-schema)。
#   - 部分缺(1/2)→ fail(即使 ALLOW_EMPTY=1;旧实现部分缺也放行 = bug)。
#   - 全缺(3)+ manifest 未明示 pre-schema → fail(manifest 期望存在却缺 = restore 损失,非 pre-schema)。
decide_core_missing() {
  local missing="$1" allow="$2" preschema="${3:-}"
  if [ "$missing" = "0" ]; then echo pass; return; fi
  if [ "$allow" != "1" ]; then echo fail; return; fi
  # ALLOW_EMPTY=1:只许全缺 + manifest 明示 pre-schema
  if [ "$missing" = "3" ] && [ "$preschema" = "true" ]; then echo warn; return; fi
  echo fail
}

# R2-2:从 pg_restore --data-only --table 的文本输出(stdin)计 COPY 数据行数(纯函数,portable awk)。
# 输入形如:行 `COPY public.tbl (cols) FROM stdin;` 之后每行一条数据,直到 `\.`;awk 计两行间数据行。
# 文本 COPY 格式把数据内换行转义为 `\n` 字面 → 一行一条,行计数可靠(无需 docker/PG,可单测)。
count_copy_rows() { awk 'BEGIN{r=0;c=0} /^COPY /{c=1;next} c && /^\\\.$/{c=0;next} c{r++} END{print r+0}'; }

# F4+R2-3:校验 asset snapshot tar。
#   $1 = snap 文件(.tar.gz)
#   $2 = manifest 路径(可选;传 "" 或缺省 → 跳过 manifest blob count 比对)
#   stdout = 人类可读 detail 行(每行一个 finding 或 ok 总结)
#   return 0 = ok;1 = fail(损坏 tar / 哈希不匹配 / 缺 metadata / metadata 内容坏 / blob 数 mismatch)
verify_asset_snapshot() {
  local snap="$1" manifest="${2:-}"
  if [ -z "$snap" ] || [ ! -f "$snap" ]; then
    echo "fail-no-snapshot: snap not found ($snap)"
    return 1
  fi
  local tmp; tmp="$(mktemp -d 2>/dev/null || mktemp -d -t assetverify)"
  local blob_count=0 hash_mismatch=0 meta_missing=0 meta_bad=0 mc_mismatch=0
  if ! tar -xzf "$snap" -C "$tmp" 2>/dev/null; then
    echo "fail-corrupt-tar: tar -xzf $snap non-zero (snapshot 损坏/非 gzip)"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  # 内容寻址:逐 .bin 算 sha256 比对文件名 + 检查 .meta.json 配对 + R2-3 metadata 内容校验。
  local binf bname actual metaf actual_size meta_err
  while IFS= read -r -d '' binf; do
    blob_count=$((blob_count + 1))
    bname="$(basename "$binf" .bin)"
    actual="$(compute_sha256 "$binf")"
    if [ -z "$actual" ] || [ "$actual" != "$bname" ]; then
      hash_mismatch=$((hash_mismatch + 1))
      echo "fail-hash-mismatch: $bname (content sha256=${actual:-<unavailable>} != filename) — 内容损坏"
    fi
    actual_size="$(stat_size "$binf")"
    metaf="$(dirname "$binf")/$bname.meta.json"
    if [ ! -f "$metaf" ]; then
      meta_missing=$((meta_missing + 1))
      echo "fail-missing-meta: $bname has no paired .meta.json — metadata 丢失"
    else
      # R2-3:metadata 存在还要验内容(hash 对但 .meta.json 内容为垃圾 → 旧实现 rc=0,现 fail)。
      meta_err="$(validate_meta "$metaf" "$bname" "$actual" "$actual_size")" || true
      if [ -n "$meta_err" ]; then
        meta_bad=$((meta_bad + 1))
        echo "$meta_err"
      fi
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
  if [ "$hash_mismatch" -gt 0 ] || [ "$meta_missing" -gt 0 ] || [ "$meta_bad" -gt 0 ] || [ "$mc_mismatch" -gt 0 ]; then
    echo "fail-summary: blobs=$blob_count hashMismatch=$hash_mismatch metaMissing=$meta_missing metaBad=$meta_bad countMismatch=$mc_mismatch"
    return 1
  fi
  echo "ok: blobs=$blob_count sha256-verified metadata-content-verified manifest-blobs=${manifest_blobs:--1}"
  return 0
}
