#!/usr/bin/env bash
# ops/postgres/backup.sh — MivoCanvas PG 备份:pg_dump(主,一致)+ 数据目录快照(灾备全量)。
# 由 cron 以 yanjian 身份每日跑(见 docs/runbook/t1.1-pg-provisioning.md §cron 挂载)。
# 失败非零退出 + 日志(backup.log),供监控/告警判断。
# 保留策略:日备滚动 7 份 + 周备(每周日)4 份(脚本头可调)。
#
# 前置:docker 可用、mivo-postgres 容器 running、BACKUP_DIR 可写。
# 环境变量(可由 ops/postgres/.env 覆盖,默认值见下)。

set -euo pipefail

# ─── 参数(可按服务器实际调)────────────────────────────────────────────────
PG_CONTAINER="${PG_CONTAINER:-mivo-postgres}"
PG_USER="${POSTGRES_USER:-mivo}"
PG_DB="${POSTGRES_DB:-mivocanvas}"
DATA_DIR="${PG_DATA_DIR:-/AIGC_Group/mivo-canvas-data}"   # pg 数据目录的父目录(tar 快照用)
BACKUP_DIR="${PG_BACKUP_DIR:-/AIGC_Group/mivo-canvas-data/backups}"
RETENTION_DAILY="${RETENTION_DAILY:-7}"     # 日备保留天数(滚动)
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"   # 周备保留份数(×7 天)
LOG_FILE="${PG_BACKUP_LOG:-/AIGC_Group/mivo-canvas-data/backups/backup.log}"
# P0.3 asset dir 快照(可选):ASSET_BACKUP_DIR 设了才产 asset 快照(默认空=跳过,向后兼容)。
# 开启:ASSET_BACKUP_DIR=/AIGC_Group/mivo-canvas-data/asset-backups ./ops/postgres/backup.sh
# asset dir = 服务端 blob 存储(MIVO_ASSET_STORE_DIR,内容寻址,fs 后端,不进 PG dump)。
ASSET_BACKUP_DIR="${ASSET_BACKUP_DIR:-}"   # 空=不产 asset 快照
ASSET_STORE_DIR="${MIVO_ASSET_STORE_DIR:-/AIGC_Group/mivo-canvas-data/assets}"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE" >&2; }

# F4/R2-2:source asset-verify.sh(无 set 副作用的函数 lib;count_copy_rows 用于 dump-consistent 计数)。
# shellcheck disable=SC1091  # 动态路径 $(dirname "$0")/asset-verify.sh;shellcheck 不跟随,已显式 source
. "$(dirname "$0")/asset-verify.sh"

# R2-2:dump-consistent 行数(从 dump 快照导出,非 live DB 查 → 杜绝 dump/计数分时取的并发写 race)。
# backup 时 pg_dump 是 MVCC 一致快照;旧实现 live count(*) 在 dump 完成后才查,并发写会让 live ≠ dump
# → restore-drill 把好恢复判 mismatch。改从 dump 自身导出:pg_restore --data-only --table 重取 COPY 数据计行。
# 表在 dump TOC 中缺(pre-schema 未建表)→ dump_row_count 返 -1(非 0;区分"空表"与"表不存在" → 供 preSchema 矩阵)。
# DUMP_FILE 在 pg_dump 后(set 见下);write_manifest 调用时已就绪。
dump_has_table() {
  local tbl="$1"
  docker exec -i "$PG_CONTAINER" pg_restore -l < "$DUMP_FILE" 2>/dev/null | grep -q "TABLE DATA public $tbl "
}
dump_row_count() {
  local tbl="$1"
  if ! dump_has_table "$tbl"; then echo -1; return; fi
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" --data-only --table="public.$tbl" < "$DUMP_FILE" 2>/dev/null | count_copy_rows
}

# F3+R2-2:写同批 manifest sidecar(<dump-basename>.manifest.json;restore-drill 按此名找)。
# 含 dump 名 + 三核心表行数(dump-consistent)+ preSchema + assetSnap + assetBlobCount(同批 dump/snapshot 配对凭证)。
# preSchema=true ⇔ 三核心表全缺(dump TOC 无任一)→ restore-drill 据此 + ALLOW_EMPTY_SCHEMA 放行 pre-schema。
write_manifest() {
  local manifest="$BACKUP_DIR/$PG_DB-$TIMESTAMP.manifest.json"
  local pr_rows pj_rows cv_rows
  pr_rows="$(dump_row_count persist_records)"
  pj_rows="$(dump_row_count projects)"
  cv_rows="$(dump_row_count canvases)"
  local preschema="false"
  if [ "$pr_rows" = "-1" ] && [ "$pj_rows" = "-1" ] && [ "$cv_rows" = "-1" ]; then
    preschema="true"
  fi
  local asset_snap_field="null" asset_blob_field="null"
  if [ -n "${ASSET_SNAP:-}" ] && [ -f "${ASSET_SNAP:-}" ]; then
    asset_snap_field="\"$(basename "$ASSET_SNAP")\""
    asset_blob_field="${ASSET_BLOB_COUNT:-0}"
  fi
  cat > "$manifest" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "pgDb": "$PG_DB",
  "dump": "$(basename "$DUMP_FILE")",
  "preSchema": $preschema,
  "tables": {
    "persist_records": $pr_rows,
    "projects": $pj_rows,
    "canvases": $cv_rows
  },
  "assetSnap": $asset_snap_field,
  "assetBlobCount": $asset_blob_field
}
EOF
  log "ok: manifest → $manifest (persist_records=$pr_rows projects=$pj_rows canvases=$cv_rows preSchema=$preschema assetSnap=${ASSET_SNAP:-none})"
}

# ─── 前置 ────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DAY_OF_WEEK="$(date +%u)"   # 1=Mon … 7=Sun

# R2-3:asset 服务开启(MIVO_ENABLE_ASSET_SERVICE=1)⇒ 备份必须配置(ASSET_BACKUP_DIR 非空)。
# 生产 ecosystem 固定 MIVO_ENABLE_ASSET_SERVICE=1;若 cron 裸跑 backup.sh 不设 ASSET_BACKUP_DIR,
# 旧实现产出"只含 PG dump 不含 asset 快照"的备份还报成功 = 部署假闭环(灾备恢复时 asset dir 缺失)。
# 现改 hard gate:服务开⇒备份必配;不配则 fail visibly exit 1(fail-fast 在 docker 之前,不 ship 不完整的备份)。
if [ "${MIVO_ENABLE_ASSET_SERVICE:-0}" = "1" ] && [ -z "$ASSET_BACKUP_DIR" ]; then
  log "FAIL: MIVO_ENABLE_ASSET_SERVICE=1(asset 服务开)但 ASSET_BACKUP_DIR 未设置 — 备份链假闭环(asset 快照必缺)。"
  log "      解法:ASSET_BACKUP_DIR=/AIGC_Group/mivo-canvas-data/asset-backups ./ops/postgres/backup.sh"
  log "      (或在 cron 环境导出 ASSET_BACKUP_DIR;见 docs/runbook/p0.3-runtime-hardening.md §5.1 + t1.1 runbook §cron)"
  exit 1
fi

# 容器存活检查(不盲目 docker exec,先确认在跑)。
if ! docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null | grep -q true; then
  log "FAIL: container $PG_CONTAINER not running — abort"
  exit 1
fi

log "=== backup start (db=$PG_DB user=$PG_USER container=$PG_CONTAINER) ==="

# ─── 1. pg_dump(自定义格式 -Fc:支持并行恢复 + 选择性恢复 + 压缩)────────────
DUMP_FILE="$BACKUP_DIR/$PG_DB-$TIMESTAMP.dump"
# docker exec 走 local socket,镜像默认 trust(免密,见 compose 注释)。
# 不用 --file=-:`-Fc --file=-` + docker exec stdout 重定向组合下落地 0 字节(服务器实测);
# pg_dump -Fc 默认写 stdout,直接重定向即可(服务器实测空库 schema 头 825 字节,pg_restore -l 15 条 TOC)。
if ! docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc >"$DUMP_FILE" 2>>"$LOG_FILE"; then
  log "FAIL: pg_dump → $DUMP_FILE"
  rm -f "$DUMP_FILE"
  exit 1
fi
DUMP_SIZE="$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE" 2>/dev/null || echo 0)"
# 非空校验(fail visibly):pg_dump -Fc 空库 schema 头都有 800+ 字节,≤ 阈值 = 损坏/空壳 → FAIL + 删 + 非零退出。
# 修此前的静默失败 bug:只报 size 当成功,0 字节 dump 被当 ok。
DUMP_MIN_BYTES="${DUMP_MIN_BYTES:-100}"
if [ "$DUMP_SIZE" -le "$DUMP_MIN_BYTES" ]; then
  log "FAIL: pg_dump produced $DUMP_SIZE bytes (≤ ${DUMP_MIN_BYTES} threshold) — dump corrupt/empty, removing $DUMP_FILE"
  rm -f "$DUMP_FILE"
  exit 1
fi
log "ok: pg_dump → $DUMP_FILE ($DUMP_SIZE bytes)"

# 周备(每周日复制一份到 weekly/,独立保留 RETENTION_WEEKLY 份)
if [ "$DAY_OF_WEEK" = "7" ]; then
  mkdir -p "$BACKUP_DIR/weekly"
  cp "$DUMP_FILE" "$BACKUP_DIR/weekly/$PG_DB-weekly-$(date +%Y%m%d).dump"
  log "ok: weekly copy → weekly/"
fi

# ─── 2. 数据目录快照(tar.gz 整个 pg 目录,灾备全量;文件级,非块级)──────────
# 先 CHECKPOINT 让 PG 把脏页刷盘(降低 crash-consistent 风险;非 PITR 替代品)。
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "CHECKPOINT;" >>"$LOG_FILE" 2>&1 || log "WARN: CHECKPOINT failed (continuing)"
SNAPSHOT_FILE="$BACKUP_DIR/pg-data-$TIMESTAMP.tar.gz"
# 快照失败不阻断主流程(pg_dump 已是主备份),记 WARN,如实不假成功。
# 典型原因:PG 数据目录由容器内 postgres 用户持有(mode 0700),宿主侧 tar 以 yanjian 身份读不了;
# 快照为可选/需 root(见 runbook §8),不阻断主备份。
if ! tar -czf "$SNAPSHOT_FILE" -C "$DATA_DIR" pg 2>>"$LOG_FILE"; then
  log "WARN: pg-data snapshot failed (non-blocking; pg_dump is primary). Likely host tar cannot read PG data dir (owned by container postgres uid, mode 0700) — needs sudo or run as postgres; see runbook §8"
  rm -f "$SNAPSHOT_FILE"
else
  SNAP_SIZE="$(stat -c%s "$SNAPSHOT_FILE" 2>/dev/null || stat -f%z "$SNAPSHOT_FILE" 2>/dev/null || echo 0)"
  log "ok: pg-data snapshot → $SNAPSHOT_FILE ($SNAP_SIZE bytes)"
fi

# ─── 2.5 asset dir 快照(F4 返修:asset backup 开启时为 hard gate)──────────────────
# asset 是 fs 内容寻址存储(不进 PG dump);PG dump 不含 blob。灾备恢复时 asset dir 须单独
# 从本快照解压(见 runbook §5.3)。ASSET_BACKUP_DIR 设了才产;**F4:开启时 snapshot 必须成功**
# (旧实现失败仅 WARN 非阻断 → 灾备不完整,ship 一个 asset 侧缺失的 dump;现改 hard gate)。
ASSET_SNAP=""
ASSET_BLOB_COUNT=""
if [ -n "$ASSET_BACKUP_DIR" ]; then
  mkdir -p "$ASSET_BACKUP_DIR"
  if [ ! -d "$ASSET_STORE_DIR" ]; then
    log "FAIL: asset backup enabled (ASSET_BACKUP_DIR set) but ASSET_STORE_DIR=$ASSET_STORE_DIR 不存在 — 配置错误(asset service 应有此目录)"
    exit 1
  fi
  ASSET_SNAP="$ASSET_BACKUP_DIR/asset-snap-$TIMESTAMP.tar.gz"
  ASSET_PARENT="$(dirname "$ASSET_STORE_DIR")"
  ASSET_BASE="$(basename "$ASSET_STORE_DIR")"
  if ! tar -czf "$ASSET_SNAP" -C "$ASSET_PARENT" "$ASSET_BASE" 2>>"$LOG_FILE"; then
    log "FAIL: asset snapshot failed (F4 hard gate — asset backup enabled ⇒ snapshot must succeed)"
    rm -f "$ASSET_SNAP"
    ASSET_SNAP=""
    exit 1
  fi
  ASSET_SNAP_SIZE="$(stat -c%s "$ASSET_SNAP" 2>/dev/null || stat -f%z "$ASSET_SNAP" 2>/dev/null || echo 0)"
  ASSET_BLOB_COUNT="$(find "$ASSET_STORE_DIR" -type f -name '*.bin' 2>/dev/null | wc -l | tr -d ' ')"
  log "ok: asset snapshot → $ASSET_SNAP ($ASSET_SNAP_SIZE bytes, $ASSET_BLOB_COUNT blobs)"
fi

# F3:写 manifest sidecar(dump + 三核心表行数 + assetSnap/blobCount 同批配对凭证)。
write_manifest

# ─── 3. 滚动清理(日备/快照按天,周备按份数)────────────────────────────────
# 日备 .dump:删早于 RETENTION_DAILY 天的
find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PG_DB-*.dump" -mtime +"$RETENTION_DAILY" -delete 2>>"$LOG_FILE" || true
# F3:manifest sidecar 同步滚动(与 .dump 同生命周期)
find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PG_DB-*.manifest.json" -mtime +"$RETENTION_DAILY" -delete 2>>"$LOG_FILE" || true
# 快照 .tar.gz:同样按 RETENTION_DAILY 滚
find "$BACKUP_DIR" -maxdepth 1 -type f -name "pg-data-*.tar.gz" -mtime +"$RETENTION_DAILY" -delete 2>>"$LOG_FILE" || true
# 周备:按 RETENTION_WEEKLY × 7 天滚
find "$BACKUP_DIR/weekly" -maxdepth 1 -type f -name "$PG_DB-weekly-*.dump" -mtime +"$((RETENTION_WEEKLY * 7))" -delete 2>>"$LOG_FILE" || true
# P0.3 asset 快照:同样按 RETENTION_DAILY 滚(仅 ASSET_BACKUP_DIR 设了才有这些文件)
if [ -n "$ASSET_BACKUP_DIR" ]; then
  find "$ASSET_BACKUP_DIR" -maxdepth 1 -type f -name "asset-snap-*.tar.gz" -mtime +"$RETENTION_DAILY" -delete 2>>"$LOG_FILE" || true
fi
log "ok: retention applied (daily=${RETENTION_DAILY}d weekly=${RETENTION_WEEKLY}×7d)"

log "=== backup done ==="
