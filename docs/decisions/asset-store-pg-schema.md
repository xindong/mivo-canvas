# Asset Store PG Schema 草案 (T1.5 → T1.1 swap-in)

> 状态:**草案 (2026-07-11)** — 为 T1.1 PG 后端 swap-in 预备的 SQL 草案,非实现。
> 范围:`server/lib/assetStore.ts` 的 fs 后端(`createFsAssetBackend`)在 T1.1 落地 PG 后
> 由一个 PG 后端替换;服务层(`createAssetStore`,reference 逻辑)不变。本草案把 fs 后端
> 的数据模型(`.bin` + `.meta.json` + `.uploaders` + 引用表)映射到 PG 表,供 T1.1 实现时
> 逐字段核对。
> 上游真相源:`server/lib/assetStore.ts`(P1-B/P2-C/P2-D/P2-E/P2-F/P3-G 第三轮修复后)、
> `docs/decisions/soft-delete-semantics.md` §4(grace + purge)。

## 0. 数据模型映射(fs → PG)

| fs 文件 / 内存结构 | PG 表 | 说明 |
|---|---|---|
| `<hash>.bin` | `asset_bytes` | 内容寻址字节;`content_hash` 主键 |
| `<hash>.meta.json` | `assets` | 资产 record(mimeType/sizeBytes/ownerFp/grace 时间戳) |
| `<hash>.uploaders`(每行一个 ownerFp) | `asset_uploaders` | 上传者登记(P2-E — 独立结构,UNIQUE(asset_id, owner_fp)) |
| `references[]`(record 内嵌) | `asset_references` | 引用表(P1.2 — refcount = 派生 COUNT,非存储计数器) |

## 1. SQL 草案

```sql
-- 内容寻址字节(assetId = sha256(canonical bytes) hex64)。fs 的 <hash>.bin。
-- 严格 content-addressed:相同 canonical bytes → 相同 content_hash → 单物理副本(dedup)。
CREATE TABLE asset_bytes (
  content_hash CHAR(64) PRIMARY KEY,            -- lowercase sha256 hex64
  bytes        BYTEA      NOT NULL,
  size_bytes   BIGINT     NOT NULL,             -- bytes.length,用于 P1.9 cheap size check
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资产 record。fs 的 <hash>.meta.json。
-- owner_fp = 首次上传者(P1.5 归属打标 + 配额归属);上传者全集在 asset_uploaders。
CREATE TABLE assets (
  content_hash     CHAR(64) PRIMARY KEY REFERENCES asset_bytes(content_hash) ON DELETE CASCADE,
  mime_type        TEXT     NOT NULL,
  size_bytes       BIGINT   NOT NULL,           -- 镜像 asset_bytes.size_bytes(record 内冗余,GET 走 record 不读 bytes)
  original_name    TEXT     NOT NULL,
  owner_fp         CHAR(16) NOT NULL,           -- FX-2 fingerprintOfPlatformKey,16 hex 分片路由键
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ref_zero_at TIMESTAMPTZ,                 -- refcount 0 → grace 起点;refs>0 → NULL(取消)
);
CREATE INDEX assets_owner_fp_idx ON assets(owner_fp);          -- ownerBytes(配额)求和
CREATE INDEX assets_purge_idx ON assets(last_ref_zero_at) WHERE last_ref_zero_at IS NOT NULL;  -- runPurgeSweep

-- 上传者登记(P2-E — 独立结构,不在 record JSON 上,无界集合不撑大 record)。
-- fs 的 <hash>.uploaders(每行一个 ownerFp,append-only 幂等)。
-- UNIQUE(asset_id, owner_fp) = fs registerUploader 的幂等去重(重复登记 = no-op)。
CREATE TABLE asset_uploaders (
  asset_id   CHAR(64) NOT NULL REFERENCES assets(content_hash) ON DELETE CASCADE,
  owner_fp   CHAR(16) NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, owner_fp)              -- 幂等:重复 INSERT 同对 (asset_id, owner_fp) 不增行
);
CREATE INDEX asset_uploaders_owner_fp_idx ON asset_uploaders(owner_fp);

-- 引用表(P1.2 — refcount = COUNT(*) 派生,非存储计数器,无 drift)。
-- attach/detach 是幂等 + owner-checked 的行级操作。
CREATE TABLE asset_references (
  asset_id   CHAR(64) NOT NULL REFERENCES assets(content_hash) ON DELETE CASCADE,
  node_id    TEXT    NOT NULL,
  owner_fp   CHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, node_id)               -- 幂等 attach:重复 (asset_id, node_id) = no-op
);
CREATE INDEX asset_references_owner_fp_idx ON asset_references(owner_fp);
```

## 2. 原子性映射(P1.1 / P1-B / P2-C)

fs 后端的 per-hash in-process mutex → PG 的行级锁 + 事务:

| fs 原语(hash-locked) | PG 实现 |
|---|---|
| `uploadIfAbsent` / `admitUpload` | 单事务:`SELECT ... FOR UPDATE` on `assets`(content_hash) 或 advisory lock;bytes INSERT IF NOT EXISTS + record INSERT IF NOT EXISTS + uploader INSERT(dedup→仅登记不收费;NEW→配额 gate 先于写) |
| `deleteIfStillEligible`(P1-B) | 事务内:先 `DELETE FROM assets WHERE content_hash=H AND <eligible re-check>`(record 不可见)→ 再 `DELETE FROM asset_bytes`(orphan bytes 可接受,绝无 record-no-bytes);`ON DELETE CASCADE` 清 asset_uploaders / asset_references |
| `attachRef` / `detachRef` | `INSERT ... ON CONFLICT DO NOTHING`(幂等 attach)/ `DELETE ... RETURNING`(owner-checked detach) |
| `cleanOrphanTemps`(P2-D) | PG 无 tmp 层;no-op |

## 3. 配额与驱逐(P1.4 / P2-C / P2-F)

- `ownerBytes(ownerFp)` = `SELECT COALESCE(SUM(size_bytes),0) FROM assets WHERE owner_fp = $1`。
- `admitUpload`(P2-C hash-locked admission):dedup(record 已存)→ 仅 `INSERT INTO asset_uploaders`(0 新字节,不计费);NEW → 配额 gate 先于写(`used + size <= quota` 才 INSERT bytes + record + uploader)。
- 慢路径(P2-F):超额 NEW → `runPurgeSweep` 定向本 owner(`DELETE ... WHERE owner_fp=$1 AND <eligible>`)→ 重算 used → 仍超才 413。

## 4. cron 注记(P2-F)

`runPurgeSweep` 是可调用入口;建议 T1.1 落地后用 pg_cron 或外部 cron 周期触发(例如每 1h)
扫 `assets_purge_idx` 中 `last_ref_zero_at + 7d < now()` 且 refcount==0 的资产物理删除,
回收磁盘。配额慢路径已内联定向 purge,cron 是兜底回收。

## 5. 验收清单(T1.1 实现时逐条核对)

- [ ] `asset_bytes.content_hash` = sha256(canonical bytes) hex64,与 fs 一致。
- [ ] `asset_uploaders` 有 `PRIMARY KEY (asset_id, owner_fp)`(幂等登记,P2-E 不裁剪不丢 entitlement)。
- [ ] `asset_references` 有 `PRIMARY KEY (asset_id, node_id)`(幂等 attach,P1.2 无 drift)。
- [ ] `deleteIfStillEligible` 先删 record(meta 不可见)再删 bytes(P1-B),事务内 `ON DELETE CASCADE` 清从表。
- [ ] `admitUpload` 配额 gate 在写之前(P2-C);dedup 不计费。
- [ ] 慢路径(P2-F)定向 purge 本 owner eligible 资产后重算 used。
- [ ] 路径穿越:`content_hash` CHAR(64) + 应用层 `ASSET_ID_RE` 校验(fs 侧 `assertValidAssetId` 在 PG 侧保留)。
