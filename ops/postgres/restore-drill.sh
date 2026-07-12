#!/usr/bin/env bash
# ops/postgres/restore-drill.sh — 从最近一份 pg_dump 恢复到临时库 + 跑验证查询,输出 drill 结果。
# 不触碰生产库:恢复到 ${PG_DRILL_DB:-mivocanvas_drill},跑完即 DROP。
#
# P0.3 返修(F3/F4/F8)硬闸门:
#  - F3:三核心表(persist_records/projects/canvases)存在性 hard gate(migrations 必建表缺失 → FAIL);
#        backup manifest 逐表行数比对(dump 一致快照,restore 后行数应等);ALLOW_EMPTY_SCHEMA=1 显式开关(pre-schema 用,生产禁用)。
#  - F4:asset snapshot 真解压 + sha256 vs 文件名 + .meta.json 配对 + manifest blob 数比对(见 asset-verify.sh);
#        asset backup 开启时为 hard gate(无 snapshot/损坏 tar/哈希不匹配/缺 metadata → FAIL)。
#  - F8:`--dry-run` 有 dump 真跑 pg_restore -l(TOC 校验);无 dump → FAIL(不许假绿);`--plan-only` 才允许无 dump 成功。
#
# 与 server/routes/projects.ts 的 restore saga 补偿无关(另一 worker 负责;本脚本不动 BFF restore 逻辑)。

set -euo pipefail

# ─── 参数 ────────────────────────────────────────────────────────────────
PG_CONTAINER="${PG_CONTAINER:-mivo-postgres}"
PG_USER="${POSTGRES_USER:-mivo}"
PG_ADMIN_DB="${POSTGRES_DB:-mivocanvas}"     # 用来 CREATE/DROP 临时库的连接库
DRILL_DB="${PG_DRILL_DB:-mivocanvas_drill}"
BACKUP_DIR="${PG_BACKUP_DIR:-/AIGC_Group/mivo-canvas-data/backups}"
LOG_FILE="${PG_DRILL_LOG:-/AIGC_Group/mivo-canvas-data/backups/restore-drill.log}"
# P0.3 asset 一致性比对:
ASSET_BACKUP_DIR="${ASSET_BACKUP_DIR:-/AIGC_Group/mivo-canvas-data/asset-backups}"
ASSET_STORE_DIR="${MIVO_ASSET_STORE_DIR:-/AIGC_Group/mivo-canvas-data/assets}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# F3:三核心表(migrations 001 必建);存在性 hard gate。生产禁用 ALLOW_EMPTY_SCHEMA。
CORE_TABLES="${CORE_TABLES:-persist_records projects canvases}"
ALLOW_EMPTY_SCHEMA="${ALLOW_EMPTY_SCHEMA:-0}"

# F4:source asset 校验 lib(无 set 副作用;函数内部 guard 防 set -e 误杀)。
# shellcheck disable=SC1091  # 动态路径 $(dirname "$0")/asset-verify.sh;shellcheck 不跟随,已显式 source
. "$(dirname "$0")/asset-verify.sh"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE" >&2; }

# 取最新 .dump(按 mtime 降序)。ls -t 跨 GNU/BSD 可用;find -printf 仅 GNU 服务器端亦可用但不可移植。
# shellcheck disable=SC2012  # ls -t 用于按 mtime 取最新,dump 文件名无特殊字符(timestamp)。
# R2-6:无匹配时 ls 非零,在 `set -euo pipefail` 下经 `LATEST_DUMP="$(latest_dump)"` 命令替换直接杀脚本,
#       导致 :87-90(dry-run)/ :114-117(主路径)的"无 dump → FAIL exit 1"显式诊断分支永不执行。
#       `|| true` 把空结果正常化为空串(函数恒 exit 0),让调用方 -z 检查走显式 FAIL 分支(fail visibly,非静默退)。
latest_dump() { ls -t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true; }

# F8:跑 pg_restore -l 校验 TOC。容器在跑→docker exec;否则本地 pg_restore;都没有→无法校验(非零,不许假绿)。
run_pg_restore_list() {
  local dump="$1"
  if docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true; then
    docker exec -i "$PG_CONTAINER" pg_restore -l <"$dump"
  elif command -v pg_restore >/dev/null 2>&1; then
    pg_restore -l "$dump"
  else
    echo "cannot validate TOC: no docker container '$PG_CONTAINER' running and no local pg_restore binary" >&2
    return 1
  fi
}

# ─── --plan-only:只打印计划,不碰 docker/PG/dump,exit 0(F8:无 dump 亦成功,纯脚本逻辑校验用)──
if [ "${1:-}" = "--plan-only" ]; then
  echo "=== restore drill PLAN-ONLY (ts=$TIMESTAMP) ==="
  echo "plan:"
  echo "  PG_CONTAINER=$PG_CONTAINER  DRILL_DB=$DRILL_DB  BACKUP_DIR=$BACKUP_DIR"
  echo "  ASSET_BACKUP_DIR=$ASSET_BACKUP_DIR  ASSET_STORE_DIR=$ASSET_STORE_DIR"
  echo "  CORE_TABLES=$CORE_TABLES  ALLOW_EMPTY_SCHEMA=$ALLOW_EMPTY_SCHEMA"
  echo ""
  echo "steps (would run in real drill):"
  echo "  1. 容器存活检查 + 取最近 .dump"
  echo "  2. pg_restore -l TOC 预校验"
  echo "  3. DROP/CREATE 临时库 $DRILL_DB"
  echo "  4. pg_restore --clean --if-exists --no-owner → $DRILL_DB"
  echo "  5. F3: 三核心表存在性 hard gate + manifest 逐表行数比对"
  echo "  6. F4: asset snapshot 真解压 + sha256 + metadata + manifest blob 数比对"
  echo "  7. DROP 临时库 + PASS/FAIL 判定"
  echo ""
  echo "=== plan-only done: exit 0 (no dump/TOC validation) ==="
  exit 0
fi

# ─── --dry-run:F8 返修 — 有 dump 真跑 pg_restore -l(TOC 校验);无 dump → FAIL ──────────────
if [ "${1:-}" = "--dry-run" ]; then
  echo "=== restore drill DRY-RUN (ts=$TIMESTAMP) ==="
  echo "plan: (see --plan-only for full plan)"
  echo "  PG_CONTAINER=$PG_CONTAINER  BACKUP_DIR=$BACKUP_DIR"
  if [ -d "$BACKUP_DIR" ]; then
    LOCAL_DUMPS="$(latest_dump)"
  else
    LOCAL_DUMPS=""
    echo "BACKUP_DIR=$BACKUP_DIR not present"
  fi
  if [ -z "$LOCAL_DUMPS" ]; then
    echo "FAIL: no .dump in ${BACKUP_DIR:-<unset>} — dry-run must validate TOC; use --plan-only for plan-only"
    echo "=== dry-run done: FAIL (exit 1) ==="
    exit 1
  fi
  echo "dump found: $LOCAL_DUMPS — running pg_restore -l (real TOC precheck)..."
  if run_pg_restore_list "$LOCAL_DUMPS" >>"$LOG_FILE" 2>&1; then
    echo "ok: dump TOC readable (pg_restore -l exit 0)"
    echo "=== dry-run done: exit 0 ==="
    exit 0
  else
    echo "FAIL: dump TOC unreadable — $LOCAL_DUMPS corrupt/empty (pg_restore -l non-zero)"
    echo "=== dry-run done: FAIL (exit 1) ==="
    exit 1
  fi
fi

mkdir -p "$BACKUP_DIR"
log "=== restore drill start (ts=$TIMESTAMP) ==="

# ─── 前置:容器存活 + 备份存在 ─────────────────────────────────────────────
if ! docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true; then
  log "FAIL: container $PG_CONTAINER not running — abort"
  exit 1
fi

LATEST_DUMP="$(latest_dump)"
if [ -z "$LATEST_DUMP" ]; then
  log "FAIL: no .dump in $BACKUP_DIR — run backup.sh first"
  exit 1
fi
log "using backup: $LATEST_DUMP ($(stat -c%s "$LATEST_DUMP" 2>/dev/null || stat -f%z "$LATEST_DUMP" 2>/dev/null) bytes)"

# ─── 预校验:dump TOC 可读(F8:真跑 pg_restore -l,0 字节/损坏 → 非零退出,FAIL 早退,不空跑报 PASS)──
if ! run_pg_restore_list "$LATEST_DUMP" >>"$LOG_FILE" 2>&1; then
  log "FAIL: dump TOC unreadable — $LATEST_DUMP corrupt/empty (pg_restore -l non-zero), abort drill"
  exit 1
fi
log "ok: dump TOC readable (pg_restore -l exit 0)"

# F3/F4 manifest:同批 sidecar(<dump-basename>.manifest.json;backup.sh 写)。
# R2-2:manifest 解析失败(no-jq / 坏 JSON)→ hard fail,不再当 -1 跳过(防部分缺表放行 / 假绿)。
MANIFEST="${LATEST_DUMP%.dump}.manifest.json"
MANIFEST_STATUS="$(manifest_parse_status "$MANIFEST")"
MANIFEST_PRESCHEMA=""
# P03-R3-1:ERR_MANIFEST init-once(manifest 解析失败标志),仅在下方 case 块置 1(no-jq/malformed)。
# 不再在恢复后重置(旧 :169 `ERR_MANIFEST=0` 清零了此信号 → 坏 manifest 仍 PASS 的假绿)。
# 最终判定由 decide_drill_outcome 把 ERR_MANIFEST 并入 ERR(单一真相源,见 asset-verify.sh)。
ERR_MANIFEST=0
case "$MANIFEST_STATUS" in
  absent)
    log "WARN: no manifest for $LATEST_DUMP (旧备份无 manifest,F3 行数比对跳过;新 backup.sh 会产 manifest)"
    ;;
  present)
    log "manifest found: $MANIFEST"
    MANIFEST_PRESCHEMA="$(manifest_field "$MANIFEST" '.preSchema')"
    # manifest_field 返 -1 表示字段缺(preSchema 未声明);规整为空串便于 decide_core_missing 判定。
    [ "$MANIFEST_PRESCHEMA" = "-1" ] && MANIFEST_PRESCHEMA=""
    ;;
  no-jq)
    log "FAIL: manifest $MANIFEST present but no jq to parse — 无法校验内容,hard fail(不假绿跳过)"
    ERR_MANIFEST=1
    ;;
  malformed)
    log "FAIL: manifest $MANIFEST present but malformed JSON — hard fail(不假绿跳过)"
    ERR_MANIFEST=1
    ;;
esac

# ─── 1. 重建临时库(确保干净,不污染生产)──────────────────────────────────
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_ADMIN_DB" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >>"$LOG_FILE" 2>&1
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_ADMIN_DB" -c "CREATE DATABASE \"$DRILL_DB\";" >>"$LOG_FILE" 2>&1

# ─── 2. 恢复(--clean --if-exists 幂等;--no-owner 避免 owner 漂移)────────────
if ! docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$DRILL_DB" --no-owner --clean --if-exists <"$LATEST_DUMP" >>"$LOG_FILE" 2>&1; then
  log "FAIL: pg_restore to $DRILL_DB"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_ADMIN_DB" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >>"$LOG_FILE" 2>&1 || true
  exit 1
fi
log "ok: pg_restore → $DRILL_DB"

# ─── 3. F3:三核心表存在性 hard gate + manifest 逐表行数比对 ──────────────────
ERR=0
# P03-R3-1:不再在此重置 ERR_MANIFEST(旧 `ERR_MANIFEST=0` 清零了 manifest case 块设置的
# 解析失败信号 → 坏 manifest/no-jq 仍 PASS)。ERR_MANIFEST 已在 manifest case 前 init-once,
# 由 decide_drill_outcome 在最终判定时并入 ERR(见下方)。
CORE_MISSING=0
# 3a. SELECT 1(证明库可读)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT 1;" >>"$LOG_FILE" 2>&1 || ERR=1
# 3b. public 表计数(诊断用,空库=0;PASS 判定改由核心表 hard gate 决定)
TABLE_COUNT="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" 2>>"$LOG_FILE" || echo ERR)"
[ "$TABLE_COUNT" = "ERR" ] && ERR=1
log "public base tables: $TABLE_COUNT"
# 3c. 估算行数 top5(证明数据可读,空库则无行)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -c "SELECT relname, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 5;" >>"$LOG_FILE" 2>&1 || log "WARN: pg_stat_user_tables empty (ok for fresh db)"
# 3d. F3 核心:三表存在性 hard gate + manifest 行数比对。
# R2-2:manifest 解析失败已 hard fail(manifest_parse_status);此处只在 present 时比对(字段缺→-1 跳过)。
for tbl in $CORE_TABLES; do
  EXISTS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT to_regclass('public.$tbl') IS NOT NULL;" 2>>"$LOG_FILE" || echo f)"
  if [ "$EXISTS" != "t" ]; then
    log "FAIL: core table public.$tbl MISSING post-restore (migrations 必建表缺失 = restore/schema 不完整)"
    CORE_MISSING=$((CORE_MISSING + 1))
    continue
  fi
  RESTORED="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT count(*) FROM public.$tbl;" 2>>"$LOG_FILE" || echo ERR)"
  [ "$RESTORED" = "ERR" ] && ERR=1
  if [ "$MANIFEST_STATUS" = "present" ]; then
    MANIFEST_V="$(manifest_field "$MANIFEST" ".tables.$tbl")"
    if [ "$MANIFEST_V" = "-1" ]; then
      log "public.$tbl rows=$RESTORED (manifest dump-counts 无此字段:表在 dump 中缺 → pre-schema?见 decide_core_missing)"
    elif [ "$RESTORED" != "$MANIFEST_V" ]; then
      log "FAIL: public.$tbl row count mismatch (manifest=$MANIFEST_V vs restored=$RESTORED) — restore 损失数据 / dump-counts race"
      ERR=1
    else
      log "ok: public.$tbl rows match (manifest=$MANIFEST_V restored=$RESTORED)"
    fi
  else
    log "public.$tbl rows=$RESTORED (manifest $MANIFEST_STATUS,跳过比对)"
  fi
done
# R2-2 矩阵:三核心表缺失处置(allow0/1 × 全缺/部分缺 + manifest preSchema 声明)。
# ALLOW_EMPTY_SCHEMA=1 只许"三核心表全缺 + manifest 明示 pre-schema";部分缺 / 全缺未声明 → FAIL。
CORE_OUTCOME="$(decide_core_missing "$CORE_MISSING" "$ALLOW_EMPTY_SCHEMA" "$MANIFEST_PRESCHEMA")"
case "$CORE_OUTCOME" in
  pass) log "ok: 三核心表全在(coreMissing=0)" ;;
  warn) log "WARN: ALLOW_EMPTY_SCHEMA=1 + 三核心表全缺 + manifest 明示 pre-schema — pre-schema 模式通过(生产禁用此开关)" ;;
  fail)
    log "FAIL: $CORE_MISSING 核心表缺失,处置=fail(部分缺 / 全缺但 manifest 未明示 pre-schema / ALLOW_EMPTY≠1)"
    ERR=1
    ;;
esac
# P03-R3-1:manifest 解析失败的 ERR 合并收敛进 decide_drill_outcome(单一真相源),
# 不再在此手动 `if ERR_MANIFEST=1; then ERR=1`(旧 :169 清零 bug 已修,此处合并是冗余重复)。

# ─── 4. F4:asset snapshot 真解压 + sha256 + metadata + manifest blob 数比对 ──────
# asset backup 开启(ASSET_BACKUP_DIR 设且存在)→ hard gate;关 → skipped(不阻断)。
ASSET_CHECK="skipped"
if [ -n "${ASSET_BACKUP_DIR:-}" ]; then
  if [ ! -d "$ASSET_BACKUP_DIR" ]; then
    log "FAIL: ASSET_BACKUP_DIR=$ASSET_BACKUP_DIR set but not present — 配置错误"
    ERR=1; ASSET_CHECK="fail-no-backup-dir"
  else
    # 找与 dump 同批的 asset snapshot(优先 manifest 的 assetSnap 字段;否则同时间戳兜底)。
    ASSET_SNAP=""
    if [ "$MANIFEST_STATUS" = "present" ]; then
      SNAP_FIELD="$(manifest_field "$MANIFEST" '.assetSnap')"
      if [ -n "$SNAP_FIELD" ] && [ "$SNAP_FIELD" != "-1" ] && [ "$SNAP_FIELD" != "null" ]; then
        ASSET_SNAP="$ASSET_BACKUP_DIR/$SNAP_FIELD"
      fi
    fi
    if [ -z "$ASSET_SNAP" ] || [ ! -f "$ASSET_SNAP" ]; then
      DUMP_BASE="$(basename "$LATEST_DUMP" .dump)"   # e.g. mivocanvas-20260712-050000
      SNAP_TS="${DUMP_BASE#*-}"                       # 20260712-050000
      [ -f "$ASSET_BACKUP_DIR/asset-snap-$SNAP_TS.tar.gz" ] && ASSET_SNAP="$ASSET_BACKUP_DIR/asset-snap-$SNAP_TS.tar.gz"
    fi
    if [ -z "$ASSET_SNAP" ] || [ ! -f "$ASSET_SNAP" ]; then
      log "FAIL: asset backup enabled but no snapshot paired with dump $LATEST_DUMP — 灾备不完整"
      ERR=1; ASSET_CHECK="fail-no-snapshot"
    else
      if AV_OUT="$(verify_asset_snapshot "$ASSET_SNAP" "$MANIFEST" 2>&1)"; then
        ASSET_CHECK="ok: $(printf '%s' "$AV_OUT" | tail -1)"
        log "asset drill: $ASSET_CHECK"
      else
        ERR=1; ASSET_CHECK="fail"
        printf '%s\n' "$AV_OUT" | tee -a "$LOG_FILE" >&2
        log "asset drill: FAIL (verify_asset_snapshot non-zero — 见上方 detail)"
      fi
    fi
  fi
else
  log "asset drill: skipped (ASSET_BACKUP_DIR unset — asset backup off)"
fi

# ─── 5. 清理临时库 ───────────────────────────────────────────────────────
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_ADMIN_DB" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >>"$LOG_FILE" 2>&1 || true

# ─── 6. 成功判定(F3/F4 硬闸门)─────────────────────────────────────────────
# P03-R3-1:最终判定收敛到 decide_drill_outcome(单一真相源,见 asset-verify.sh)。
#   ERR=累积错(核心表行数 mismatch / asset 失败 / SELECT 失败等);
#   ERR_MANIFEST=manifest 解析失败(no-jq/malformed)→ 函数内并入 ERR hard fail,**即使核心表全在也 FAIL**
#     (旧实现 ERR_MANIFEST=1 被 :169 清零 → 坏 manifest/no-jq 仍 PASS 的假绿,已修);
#   CORE_OUTCOME=decide_core_missing(pass/warn/fail)。
# PASS = decide_drill_outcome=pass(即 ERR=0 AND CORE_OUTCOME ∈ {pass,warn})。
DRILL_OUTCOME="$(decide_drill_outcome "$ERR" "$ERR_MANIFEST" "$CORE_OUTCOME")"
if [ "$DRILL_OUTCOME" = "pass" ]; then
  log "PASS: restore drill ok (core=$CORE_OUTCOME coreMissing=$CORE_MISSING, manifest=$MANIFEST_STATUS, preSchema=$MANIFEST_PRESCHEMA, errManifest=$ERR_MANIFEST, backup=$LATEST_DUMP, asset=$ASSET_CHECK)"
  log "=== restore drill done: PASS ==="
  exit 0
else
  log "FAIL: restore drill (err=$ERR coreOutcome=$CORE_OUTCOME coreMissing=$CORE_MISSING asset=$ASSET_CHECK manifest=$MANIFEST_STATUS preSchema=$MANIFEST_PRESCHEMA errManifest=$ERR_MANIFEST)"
  log "=== restore drill done: FAIL ==="
  exit 1
fi
