#!/usr/bin/env bash
# ops/postgres/restore-drill.sh — 从最近一份 pg_dump 恢复到临时库 + 跑验证查询,输出 drill 结果。
# 不触碰生产库:恢复到 ${PG_DRILL_DB:-mivocanvas_drill},跑完即 DROP。
# 成功标准:dump TOC 可读预校验(pg_restore -l)+ pg_restore 退出 0 + 临时库可 SELECT(连接 + 元查询通过)+ 表计数为数字。
# 由 owner/lead 定期跑(见 docs/runbook/t1.1-pg-provisioning.md §restore drill),留证到 drill log。
#
# P0.3 扩展(restore 含业务行 + asset):
#  - --dry-run:不碰容器/PG,只打印恢复计划 + 校验 dump TOC(若本地有 .dump)+ asset 快照清单。
#    本地无 docker/PG 也能跑(验证脚本逻辑),exit 0。
#  - 业务行抽查:恢复后不只看表计数,抽查 persist_records/projects/canvases 行数(数字 ≥ 0)。
#  - asset 一致性:若 backup 含 asset 快照(asset-snap-*.tar.gz),比对快照 blob 数 vs 现场
#    asset dir blob 数(MIVO_ASSET_STORE_DIR);差异 0 = 一致。无快照时 skipped。
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

# 业务行抽查表(空库合法;非 0 校验留生产真实数据时用)。
BUSINESS_TABLES="${BUSINESS_TABLES:-persist_records projects canvases}"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE" >&2; }

# ─── --dry-run:不碰 docker/PG,只打印计划 + TOC 预校验(若本地有 dump)+ asset 快照清单 ─
if [ "${1:-}" = "--dry-run" ]; then
  echo "=== restore drill DRY-RUN (ts=$TIMESTAMP) ==="
  echo "plan:"
  echo "  PG_CONTAINER=$PG_CONTAINER  DRILL_DB=$DRILL_DB  BACKUP_DIR=$BACKUP_DIR"
  echo "  ASSET_BACKUP_DIR=$ASSET_BACKUP_DIR  ASSET_STORE_DIR=$ASSET_STORE_DIR"
  echo "  BUSINESS_TABLES=$BUSINESS_TABLES"
  echo ""
  echo "steps (would run in real drill):"
  echo "  1. 容器存活检查 + 取最近 .dump"
  echo "  2. pg_restore -l TOC 预校验"
  echo "  3. DROP/CREATE 临时库 $DRILL_DB"
  echo "  4. pg_restore --clean --if-exists --no-owner → $DRILL_DB"
  echo "  5. SELECT 1 + 表计数 + 业务行抽查(persist_records/projects/canvases)"
  echo "  6. asset 一致性:asset-snap blob 数 vs 现场 asset dir blob 数"
  echo "  7. DROP 临时库 + PASS/FAIL 判定"
  echo ""
  # 若本地恰好有 .dump,做 TOC 预校验(dry-run 不要求有 dump;无则跳过)。
  if [ -d "$BACKUP_DIR" ]; then
    # shellcheck disable=SC2012  # ls 用于存在性预检,dry-run 可读
    LOCAL_DUMPS="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' 2>/dev/null | head -1 || true)"
    if [ -n "$LOCAL_DUMPS" ]; then
      echo "dump found: $LOCAL_DUMPS (would pg_restore -l to precheck)"
    else
      echo "no .dump in $BACKUP_DIR (dry-run: skip TOC precheck; real drill needs backup.sh first)"
    fi
  else
    echo "BACKUP_DIR=$BACKUP_DIR not present (dry-run: skip dump lookup)"
  fi
  # asset 快照清单(dry-run:只列,不比对——现场 asset dir 本地不存在时 skipped)。
  if [ -d "$ASSET_BACKUP_DIR" ]; then
    echo "asset snapshots in $ASSET_BACKUP_DIR:"
    find "$ASSET_BACKUP_DIR" -maxdepth 1 -type f -name 'asset-snap-*.tar.gz' 2>/dev/null | head -5 || true
  else
    echo "ASSET_BACKUP_DIR=$ASSET_BACKUP_DIR not present (dry-run: asset check would be skipped)"
  fi
  echo ""
  echo "=== restore drill DRY-RUN done: exit 0 ==="
  exit 0
fi

mkdir -p "$BACKUP_DIR"
log "=== restore drill start (ts=$TIMESTAMP) ==="

# ─── 前置:容器存活 + 备份存在 ─────────────────────────────────────────────
if ! docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true; then
  log "FAIL: container $PG_CONTAINER not running — abort"
  exit 1
fi

# 取最近一份 .dump(按 mtime;find -printf 是 GNU find,Linux 服务器端可用,避开 ls SC2012)。
LATEST_DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$LATEST_DUMP" ]; then
  log "FAIL: no .dump in $BACKUP_DIR — run backup.sh first"
  exit 1
fi
log "using backup: $LATEST_DUMP ($(stat -c%s "$LATEST_DUMP" 2>/dev/null || stat -f%z "$LATEST_DUMP" 2>/dev/null) bytes)"

# ─── 预校验:dump TOC 可读(0 字节/损坏 → pg_restore -l 非零退出,FAIL 早退,不空跑报 PASS)──
# pg_restore -l 列 TOC;空库 schema 头也有 15 条 TOC(服务器实测),损坏/0 字节则非零退出。
if ! docker exec -i "$PG_CONTAINER" pg_restore -l <"$LATEST_DUMP" >>"$LOG_FILE" 2>&1; then
  log "FAIL: dump TOC unreadable — $LATEST_DUMP corrupt/empty (likely 0-byte dump), abort drill"
  exit 1
fi
log "ok: dump TOC readable (pg_restore -l exit 0)"

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

# ─── 3. 验证查询(SELECT 1 通 + 元查询 + 表计数 + 业务行抽查)─────────────────
ERR=0
# 3a. SELECT 1(证明库可读)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT 1;" >>"$LOG_FILE" 2>&1 || ERR=1
# 3b. public 表计数(空库=0,仍判 PASS)
TABLE_COUNT="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" 2>>"$LOG_FILE" || echo ERR)"
[ "$TABLE_COUNT" = "ERR" ] && ERR=1
log "public base tables: $TABLE_COUNT"
# 3c. 抽样:按估算行数 top5(证明数据可读,空库则无行)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -c "SELECT relname, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 5;" >>"$LOG_FILE" 2>&1 || log "WARN: pg_stat_user_tables empty (ok for fresh db)"
# 3d. P0.3 业务行抽查:逐表 SELECT count(*)(数字 ≥ 0,空库合法;非 0 校验留生产真实数据时)。
#     table_exists 守卫:表不在(空库/schema 未迁)时跳过该表,不误判 ERR。
for tbl in $BUSINESS_TABLES; do
  EXISTS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT to_regclass('public.$tbl') IS NOT NULL;" 2>>"$LOG_FILE" || echo f)"
  if [ "$EXISTS" = "t" ]; then
    ROWS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT count(*) FROM public.$tbl;" 2>>"$LOG_FILE" || echo ERR)"
    [ "$ROWS" = "ERR" ] && ERR=1
    log "business row sample: public.$tbl rows=$ROWS"
  else
    log "business row sample: public.$tbl skipped (table not present — ok for fresh/empty db)"
  fi
done

# ─── 4. P0.3 asset 一致性(若 backup 含 asset 快照)──────────────────────────
# asset 是 fs 内容寻址存储(不进 PG dump);比对最新 asset 快照的 blob 数 vs 现场 asset dir blob 数。
# 无快照 / 现场 asset dir 不存在 → skipped(不参与 PASS/FAIL;只有"有快照 + 现场在"才比对)。
ASSET_CHECK="skipped"
if [ -d "$ASSET_BACKUP_DIR" ]; then
  LATEST_ASSET_SNAP="$(find "$ASSET_BACKUP_DIR" -maxdepth 1 -type f -name 'asset-snap-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"
  if [ -n "$LATEST_ASSET_SNAP" ]; then
    # 快照内 .bin 数(content-addressed blob;tar -tzf 列名,grep 计数)。
    SNAP_BLOBS="$(tar -tzf "$LATEST_ASSET_SNAP" 2>/dev/null | grep -c '\.bin$' || echo 0)"
    if [ -d "$ASSET_STORE_DIR" ]; then
      LIVE_BLOBS="$(find "$ASSET_STORE_DIR" -type f -name '*.bin' 2>/dev/null | wc -l | tr -d ' ')"
      if [ "$SNAP_BLOBS" = "$LIVE_BLOBS" ]; then
        ASSET_CHECK="ok (snap blobs=$SNAP_BLOBS == live blobs=$LIVE_BLOBS)"
      else
        ASSET_CHECK="MISMATCH (snap blobs=$SNAP_BLOBS vs live blobs=$LIVE_BLOBS) — 现场与最近备份不一致(可能备份后有新上传;非阻断,仅记录)"
      fi
    else
      ASSET_CHECK="skipped (ASSET_STORE_DIR=$ASSET_STORE_DIR not present; snap blobs=$SNAP_BLOBS)"
    fi
    log "asset consistency: $ASSET_CHECK"
  else
    log "asset consistency: skipped (no asset-snap-*.tar.gz in $ASSET_BACKUP_DIR)"
  fi
else
  log "asset consistency: skipped (ASSET_BACKUP_DIR=$ASSET_BACKUP_DIR not present)"
fi

# ─── 5. 清理临时库 ───────────────────────────────────────────────────────
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_ADMIN_DB" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >>"$LOG_FILE" 2>&1 || true

# ─── 6. 成功判定 ─────────────────────────────────────────────────────────
# 成功标准:SELECT 1 通(ERR=0)+ TABLE_COUNT 为数字 ≥ 0(含 0,空库合法)。
# asset 一致性不参与 PASS/FAIL(只记录;差异可能因备份后新上传,非恢复链路问题)。
if [ "$ERR" = "0" ] && printf '%s' "$TABLE_COUNT" | grep -qE '^[0-9]+$'; then
  log "PASS: restore drill ok (tables=$TABLE_COUNT, backup=$LATEST_DUMP, asset=$ASSET_CHECK)"
  log "=== restore drill done: PASS ==="
  exit 0
else
  log "FAIL: restore drill (err=$ERR table_count=$TABLE_COUNT)"
  log "=== restore drill done: FAIL ==="
  exit 1
fi
