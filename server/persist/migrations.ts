// server/persist/migrations.ts
// T1.3 PG backend schema migrations(Kysely Migration,可重放)。权威:docs/decisions/api-surface.md 附录 A(SQL 草案)+ docs/decisions/pg-backend-schema.md(实施定稿)。
//
// 设计要点(与附录 A 草案对齐 + 实施去重,见 pg-backend-schema.md §1):
//  - persist_records:单一真相源,全 record 信封列 + payload jsonb(DP-5)。PK=(owner_id,type,id),owner-scoped。
//  - projects/canvases:**瘦全局唯一索引表**(id PK + owner_id + is_deleted + timestamps)。
//    附录 A 草案这两表含 payload JSONB 列;实施去重——payload 留 persist_records 单一真相,这两表退化为
//    全局唯一索引(id→owner→is_deleted),减少双写同步面。语义不变:project/canvas id 全局唯一(跨 owner
//    同 id → 409);授权 seam getProjectOwner/getCanvasOwner 经此查归属;软删保留占位(purge 才释放 id 槽)。
//  - idempotency_index:UNIQUE(owner_id,method,resource_kind,key)复合 + fingerprint + envelope ref(返修 #10)。
//  - 乐观并发:UPDATE persist_records SET revision=revision+1 ... WHERE owner_id=$ AND type=$ AND id=$ AND revision=$client;
//    行影响 0 → 409 revision-conflict(#4/#5)。existing 缺 If-Match 由 route 决 428(#4)。
//
// 可重放:每个 CREATE 带 IF NOT EXISTS;migrator 自带 kysely_migration 追踪表,migrateToLatest 幂等。
// 生产实操由 lead 走 runbook(docs/runbook/t1.1-pg-provisioning.md);测试用 runMigrations() 对 fresh DB 跑。

import type { Migration } from 'kysely/migration'
import { sql } from 'kysely'

const INITIAL_SCHEMA = sql`
-- DP-5 信封列 + payload jsonb + order_key(#6)。owner_id 资源归属(过渡 mivo-key 指纹;T1.4 maker user id)。
CREATE TABLE IF NOT EXISTS persist_records (
  id          TEXT        NOT NULL,
  owner_id    TEXT        NOT NULL,
  canvas_id   TEXT        NULL,
  type        TEXT        NOT NULL,                   -- 'project'|'canvas'|'chat-collection'|'node'|'edge'|'anchor'|'chat-message'|'user-state'
  scope       TEXT        NOT NULL,                  -- 'document'|'user'
  revision    INTEGER     NOT NULL DEFAULT 0,         -- envelope 唯一真相(#5)
  order_key   DOUBLE PRECISION NOT NULL DEFAULT 0,    -- 稳定排序(#6)
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,    -- 仅 canvas/project/chat-collection 软删(#2)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB       NOT NULL,                   -- 整存 record 体(canvas meta 含 contentVersion #5)
  PRIMARY KEY (owner_id, type, id)
);

-- project 全局唯一(#1):瘦索引表(id→owner→is_deleted)。payload 留 persist_records,本表只钉全局归属。
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT        PRIMARY KEY,                -- 全局唯一(#1)
  owner_id    TEXT        NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- F4:canvas 全局唯一(与 project 同模式)。瘦索引表;canvas meta payload 留 persist_records(type='canvas')。
CREATE TABLE IF NOT EXISTS canvases (
  id          TEXT        PRIMARY KEY,                -- 全局唯一(F4)
  owner_id    TEXT        NOT NULL,
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,    -- 软删保留占位(purge 才释放全局 id 槽)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- listByCanvas / listByOwner 走此部分索引(仅 live 记录;软删不进索引,列表默认不返)。
CREATE INDEX IF NOT EXISTS idx_persist_canvas ON persist_records (owner_id, canvas_id, type) WHERE is_deleted = FALSE;
-- listByCanvas ORDER BY order_key(#6)走此复合索引。
CREATE INDEX IF NOT EXISTS idx_persist_order ON persist_records (owner_id, canvas_id, type, order_key) WHERE is_deleted = FALSE;

-- 幂等(#10):独立表 + UNIQUE 复合 key(owner+method+resourceKind+key,跨 type 不串)+ fingerprint + envelope ref。
CREATE TABLE IF NOT EXISTS idempotency_index (
  owner_id        TEXT        NOT NULL,
  method          TEXT        NOT NULL,
  resource_kind   TEXT        NOT NULL,
  key             TEXT        NOT NULL,
  fingerprint     TEXT        NOT NULL,               -- sha256 body(#10)
  envelope_owner  TEXT        NOT NULL,
  envelope_type   TEXT        NOT NULL,
  envelope_id     TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, method, resource_kind, key)      -- 复合 key 跨 type 不串(#10)
);
`

const DROP_SCHEMA = sql`
DROP TABLE IF EXISTS idempotency_index;
DROP TABLE IF EXISTS canvases;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS persist_records;
`

/** migrations 以 ISO 日期前缀排序;migrator 按 key 字典序应用。 */
export const migrations: Record<string, Migration> = {
  '2026_07_11_001_initial_persist_schema': {
    async up(db): Promise<void> {
      await INITIAL_SCHEMA.execute(db)
    },
    async down(db): Promise<void> {
      await DROP_SCHEMA.execute(db)
    },
  },
}

export const MIGRATION_NAMES = Object.keys(migrations).sort()
