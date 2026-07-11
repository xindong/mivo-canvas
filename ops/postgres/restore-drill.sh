#!/usr/bin/env bash
# ops/postgres/restore-drill.sh — 从最近一份 pg_dump 恢复到临时库 + 跑验证查询,输出 drill 结果。
# 不触碰生产库:恢复到 ${PG_DRILL_DB:-mivocanvas_drill},跑完即 DROP。
# 成功标准:dump TOC 可读预校验(pg_restore -l)+ pg_restore 退出 0 + 临时库可 SELECT(连接 + 元查询通过)+ 表计数为数字。
# 由 owner/lead 定期跑(见 docs/runbook/t1.1-pg-provisioning.md §restore drill),留证到 drill log。
#
# 注:空库(BFF schema 未迁移前)表计数=0 仍判 PASS(恢复链路本身通);schema 落地后,
# 在 §扩展 处加业务表断言(见 runbook)。

set -euo pipefail

# ─── 参数 ────────────────────────────────────────────────────────────────
PG_CONTAINER="${PG_CONTAINER:-mivo-postgres}"
PG_USER="${POSTGRES_USER:-mivo}"
PG_ADMIN_DB="${POSTGRES_DB:-mivocanvas}"     # 用来 CREATE/DROP 临时库的连接库
DRILL_DB="${PG_DRILL_DB:-mivocanvas_drill}"
BACKUP_DIR="${PG_BACKUP_DIR:-/AIGC_Group/mivo-canvas-data/backups}"
LOG_FILE="${PG_DRILL_LOG:-/AIGC_Group/mivo-canvas-data/backups/restore-drill.log}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE" >&2; }

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

# ─── 3. 验证查询(SELECT 1 通 + 元查询 + 表计数 + 抽样行数)─────────────────────
ERR=0
# 3a. SELECT 1(证明库可读)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT 1;" >>"$LOG_FILE" 2>&1 || ERR=1
# 3b. public 表计数(空库=0,仍判 PASS)
TABLE_COUNT="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" 2>>"$LOG_FILE" || echo ERR)"
[ "$TABLE_COUNT" = "ERR" ] && ERR=1
log "public base tables: $TABLE_COUNT"
# 3c. 抽样:按估算行数 top5(证明数据可读,空库则无行)
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DRILL_DB" -c "SELECT relname, n_live_tup AS approx_rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 5;" >>"$LOG_FILE" 2>&1 || log "WARN: pg_stat_user_tables empty (ok for fresh db)"

# ─── 4. 清理临时库 ───────────────────────────────────────────────────────
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_ADMIN_DB" -c "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >>"$LOG_FILE" 2>&1 || true

# ─── 5. 成功判定 ─────────────────────────────────────────────────────────
# 成功标准:SELECT 1 通(ERR=0)+ TABLE_COUNT 为数字 ≥ 0(含 0,空库合法)。
if [ "$ERR" = "0" ] && printf '%s' "$TABLE_COUNT" | grep -qE '^[0-9]+$'; then
  log "PASS: restore drill ok (tables=$TABLE_COUNT, backup=$LATEST_DUMP)"
  log "=== restore drill done: PASS ==="
  exit 0
else
  log "FAIL: restore drill (err=$ERR table_count=$TABLE_COUNT)"
  log "=== restore drill done: FAIL ==="
  exit 1
fi
