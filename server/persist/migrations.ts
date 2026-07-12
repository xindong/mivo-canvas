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

// T1.4 权限层 schema(project_members + share_links)。独立第二个 migration,排在 initial 之后(字典序 002)。
// 权威:docs/decisions/permission-schema.md;DDL 权威为本文件 PERMISSIONS_SCHEMA(Kysely runner apply,原 001_permissions.sql vanilla 草案已删)。
// 设计:权限表不带 revision(成员资格/分享是 owner 权威写,非 CRDT LWW);share_links 软删用 revoked_at(FX-7)。
// FK:project_id REFERENCES projects(id) ON DELETE CASCADE(project purge → members/links 清;projects 表由 001 建,
// 本迁移在 001 之后 apply,FK 目标存在)。IF NOT EXISTS + migrator kysely_migration 追踪表 → 已建库重放安全。
const PERMISSIONS_SCHEMA = sql`
-- 成员资格(owner/editor/viewer)。一个 user 在一个 project 恰一 role(UNIQUE(project_id,user_id))。
CREATE TABLE IF NOT EXISTS project_members (
  id           TEXT        PRIMARY KEY,                      -- surrogate uuid(应用层生成)
  project_id   TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,                         -- maker user id(= SSO username,DP-4)
  role         TEXT        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_members_project_user_unique UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members (user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members (project_id);

-- 分享链接(token 驱动,permission ≤ edit,不授 owner)。revoked_at = FX-7 revoke 软删标记(30 天后 purge)。
CREATE TABLE IF NOT EXISTS share_links (
  id           TEXT        PRIMARY KEY,                      -- surrogate uuid
  token        TEXT        NOT NULL UNIQUE,                  -- 密码学随机,不可枚举
  project_id   TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  permission   TEXT        NOT NULL CHECK (permission IN ('view', 'edit')),
  created_by   TEXT        NOT NULL,                         -- 创建者 user id(须为 project owner)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,                                   -- NULL=活;非空=revoke(FX-7 软删)
  expires_at   TIMESTAMPTZ                                    -- 可选过期(NULL=不过期)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_token ON share_links (token);
CREATE INDEX IF NOT EXISTS idx_share_links_project_id ON share_links (project_id);
`

const DROP_PERMISSIONS_SCHEMA = sql`
DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS project_members;
`
// DP-6R chat per-user 重拆(2026-07-12):无 schema 变更,无数据搬迁——cutover checkpoint + 文档语义。
// 现状(重拆前):chat-message.owner_id = canvas owner(共享 collection),成员 GET 读全部 → Gate2 启用即隐私违约。
// 重拆后:chat-message.owner_id = actor(写入者本人,per-actor 私有),PK=(actor,'chat-message',messageId)。
//   - chat-collection 仍 per-canvas under canvas owner(随 canvas 原子创建/软删/恢复),不含 per-actor 状态。
//   - chat-message 写入不 bump 共享 canvas contentVersion(chat per-user,非共享画布内容)。
//   - 旧 owner chat(owner_id=canvasOwner)无需搬迁:owner 的 actor === canvasOwner → owner GET 仍见;成员不获复制。
//     Gate2 生产未启用前无成员 chat,故无数据移动;dev/staging 若有成员 chat under canvasOwner,重拆后归 owner。
//   - 匿名 share-link 访客(actor=null)chat 读写一律 401 require-login。
// 本 migration 仅落 COMMENT 标注语义(可重放);G3 export/ingest/verify 的 chat per-actor 校验脚本待 cutover 实现。
//
// P1-3 fail-closed audit 要求(lead+sol 共识,2026-07-12):migration 003 "零搬迁"论证只在 **legacy chat owner
// === 当时 canvas owner** 时成立。cutover 前(及 G2.2 fingerprint→SSO username 换键前)必须跑 fail-closed 审计:
//   遍历所有 legacy chat-message 行,断言 row.owner_id === 该 row.canvas_id 在当时的 canvas owner(由 canvases 表
//   owner_id 给出)。**任何不一致行 = no-go**(不得静默 carry over;要么归属正确(归 owner),要么隔离人工裁决),
//   否则重拆后该行的 owner_id 既非 canvasOwner 又非真实 actor → owner 自己看不到、actor 也看不到 → 数据孤儿 +
//   隐私边界破损。审计脚本与 G2.2 换键迁移同批实现(见 docs/runbook/t1.6-cutover-runbook.md §G2.2)。
const CHAT_PER_ACTOR_COMMENT = sql`
COMMENT ON TABLE persist_records IS 'DP-5 信封列 + payload jsonb. DP-6R(2026-07-12): chat-message.owner_id = actor(写入者本人, per-actor 私有, PK=(actor,chat-message,messageId)); chat-collection 仍 per-canvas under canvas owner. 匿名访客 chat 读写 401 require-login. P1-3 fail-closed audit: cutover/G2.2 换键前必须断言所有 legacy chat-message.owner_id === 当时 canvas owner, 异常行 no-go(不得静默 carry over, 防数据孤儿 + 隐私边界破损).';
`

const CHAT_PER_ACTOR_COMMENT_DROP = sql`
COMMENT ON TABLE persist_records IS NULL;
`

// DP-6R P1-2(2026-07-12):per-actor×canvas chat collection 独立乐观锁 cursor(orderRevision)。
// chat reorder 同事务 compare(base !== current → 409)+ bump;与共享 canvas contentVersion 解耦
// (node 写 bump 共享 cv 不触此 cursor → node 写不使 chat reorder 误 409)。A/B 不同 actor 各自独立行,互不冲突。
// PK=(actor_id, canvas_id);revision 缺省 0(行不存在即视作 0,首条 reorder INSERT)。可重放(IF NOT EXISTS)。
const CHAT_ORDER_REVISIONS_SCHEMA = sql`
CREATE TABLE IF NOT EXISTS chat_order_revisions (
  actor_id   TEXT        NOT NULL,
  canvas_id  TEXT        NOT NULL,
  revision   BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, canvas_id)
);
`

const CHAT_ORDER_REVISIONS_SCHEMA_DROP = sql`
DROP TABLE IF EXISTS chat_order_revisions;
`

// P-6 saga 补偿意图表(share_link_compensations)。migration key 排在 DP-6R chat 之后(字典序 005):
// lead 拍板(2026-07-12 更新)——DP-6R 占 003_chat_per_actor + 004_chat_order_revisions,本分支 005(key+registry
// 同步),避免 Kysely 字典序 "share 先 chat 后"导致 migration 顺序冲突(share-先路径因改名后不存在,无需支持)。
// FK 同权限两表:project_id → projects(id) ON DELETE CASCADE(project purge → 补偿意图清)。
// 无 revision(owner 权威写,非 CRDT LWW)。attempt_count/last_error/last_attempted_at 是"可观察状态"(saga 非黑盒)。
//
// 返修 P1-1/P1-2/P1-3/P2-1(2026-07-12 双审 REQUIRES_CHANGES):
//  - generation:project 级单调递增的"desired-state 代际";新 transition record 时 bump,旧 pending 对立 op
//    被 supersede(sweep/attempt 据最新 generation 决断,防 restore-fail→delete 后旧 restore 晚到重开链接)。
//  - claimed_at/claimed_until:attempt 租约(P2-1);并发 attempt 原子 claim,loser 返 already-claimed。
//  - status 新增 'superseded':被对立 op 的新代际取代(保留行做可观察历史,不再被 sweep/attempt 处理)。
//  - partial unique index UNIQUE(project_id,op) WHERE status='pending'(P1-3):并发首建恰一条 pending +
//    ON CONFLICT;done/superseded 不占槽,下一生命周期可再建。
//  - cascade_revoked_at(share_links ALTER):区分"级联 revoke"(project 软删级联)vs"手工 revoke"(用户主动吊销);
//    restore 补偿只 un-revoke cascade 标记的链接,手工 revoked 链接永不动(防误恢复)。
const COMPENSATIONS_SCHEMA = sql`
CREATE TABLE IF NOT EXISTS share_link_compensations (
  id                TEXT        PRIMARY KEY,                     -- surrogate uuid(应用层生成)
  project_id        TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  op                TEXT        NOT NULL CHECK (op IN ('restore', 'delete')),
  status            TEXT        NOT NULL CHECK (status IN ('pending', 'done', 'superseded')),
  generation        INTEGER     NOT NULL DEFAULT 1,             -- project 级 desired-state 代际(单调递增)
  attempt_count     INTEGER     NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_attempted_at TIMESTAMPTZ,
  claimed_at        TIMESTAMPTZ,                                 -- P2-1 attempt 租约起点(null=未被 claim)
  claimed_until     TIMESTAMPTZ,                                 -- 租约到期(过期可被重新 claim)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compensations_project_op ON share_link_compensations (project_id, op);
-- P1-3:并发首建恰一条 pending(部分唯一索引;done/superseded 不占槽)。
CREATE UNIQUE INDEX IF NOT EXISTS uq_compensations_pending_project_op
  ON share_link_compensations (project_id, op) WHERE status = 'pending';

-- P1-1 marker:级联 revoke 标记。revokeAllForProject(project 软删级联)置非空;unRevokeAllForProject(restore 级联)
-- 仅恢复此标记非空且 30 天窗内的链接并清空标记;手工 revokeShareLink 不置此列 → restore 补偿永不动手工吊销。
-- ADD COLUMN IF NOT EXISTS 幂等(002 已 applied 的库 ALTER 加列;fresh 库 002 建表后 005 补列,同效)。
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS cascade_revoked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_share_links_cascade_project
  ON share_links (project_id) WHERE cascade_revoked_at IS NOT NULL;
`
const DROP_COMPENSATIONS_SCHEMA = sql`
DROP INDEX IF EXISTS idx_share_links_cascade_project;
DROP INDEX IF EXISTS uq_compensations_pending_project_op;
DROP INDEX IF EXISTS idx_compensations_project_op;
DROP TABLE IF EXISTS share_link_compensations;
-- 不 DROP cascade_revoked_at 列:share_links 表归 002 拥有,down 只清本 migration 加的索引/表,列随表 DROP 自然消失。
`

// R3-F2 migration 006:sweep 超限放弃不再伪装成 done——新增 'failed' 终态(dead-letter,可告警的未收敛事实)。
// 005 的 CHECK 只允许 pending/done/superseded;006 ALTER CONSTRAINT 加 'failed'(005 字节不变,新加 006)。
// 'failed' 不占 partial unique index 槽(WHERE status='pending'),下一生命周期 primary 仍可 record 新 pending →
// 故障解除后存在自动重开路径(新 POST/DELETE → record → sweep done)。
// 字典序 006 > 005,与 DP-6R 003/004 无冲突(合并后 001<002<003<004<005<006 单调)。
const COMPENSATIONS_FAILED_STATUS = sql`
ALTER TABLE share_link_compensations DROP CONSTRAINT IF EXISTS share_link_compensations_status_check;
ALTER TABLE share_link_compensations ADD CONSTRAINT share_link_compensations_status_check
  CHECK (status IN ('pending', 'done', 'superseded', 'failed'));
`
const DROP_COMPENSATIONS_FAILED_STATUS = sql`
-- down:回滚 CHECK 到 005 原态(不含 'failed')。前提:无 'failed' 行(否则 ALTER 失败,提示先清理 dead-letter)。
ALTER TABLE share_link_compensations DROP CONSTRAINT IF EXISTS share_link_compensations_status_check;
ALTER TABLE share_link_compensations ADD CONSTRAINT share_link_compensations_status_check
  CHECK (status IN ('pending', 'done', 'superseded'));
`

// R3-F4 migration 007:claim fencing token。lease 过期后第二 worker 可重新 claim,若 done UPDATE 无 ownership
// 校验,两者都会 completed + attemptCount 失真。claim_token(random UUID)随 claim 写入;side effect 前预校验
// 仍为当前 owner;done UPDATE WHERE claim_token=ours → 仅当前 owner 能 mark done,loser 返 stale-claim。
// 005 字节不变,新加 007;字典序 007 > 006 > 005,与 DP-6R 003/004 无冲突。
const COMPENSATIONS_CLAIM_TOKEN = sql`
ALTER TABLE share_link_compensations ADD COLUMN IF NOT EXISTS claim_token TEXT;
`
const DROP_COMPENSATIONS_CLAIM_TOKEN = sql`
ALTER TABLE share_link_compensations DROP COLUMN IF EXISTS claim_token;
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
  '2026_07_11_002_permissions_schema': {
    async up(db): Promise<void> {
      await PERMISSIONS_SCHEMA.execute(db)
    },
    async down(db): Promise<void> {
      await DROP_PERMISSIONS_SCHEMA.execute(db)
    },
  },
  '2026_07_12_003_chat_per_actor': {
    async up(db): Promise<void> {
      await CHAT_PER_ACTOR_COMMENT.execute(db)
    },
    async down(db): Promise<void> {
      await CHAT_PER_ACTOR_COMMENT_DROP.execute(db)
    },
  },
  '2026_07_12_004_chat_order_revisions': {
    async up(db): Promise<void> {
      await CHAT_ORDER_REVISIONS_SCHEMA.execute(db)
    },
    async down(db): Promise<void> {
      await CHAT_ORDER_REVISIONS_SCHEMA_DROP.execute(db)
    },
  },
  '2026_07_12_005_share_link_compensations': {
    async up(db): Promise<void> {
      await COMPENSATIONS_SCHEMA.execute(db)
    },
    async down(db): Promise<void> {
      await DROP_COMPENSATIONS_SCHEMA.execute(db)
    },
  },
  '2026_07_12_006_compensation_failed_status': {
    async up(db): Promise<void> {
      await COMPENSATIONS_FAILED_STATUS.execute(db)
    },
    async down(db): Promise<void> {
      await DROP_COMPENSATIONS_FAILED_STATUS.execute(db)
    },
  },
  '2026_07_12_007_compensation_claim_token': {
    async up(db): Promise<void> {
      await COMPENSATIONS_CLAIM_TOKEN.execute(db)
    },
    async down(db): Promise<void> {
      await DROP_COMPENSATIONS_CLAIM_TOKEN.execute(db)
    },
  },
}

export const MIGRATION_NAMES = Object.keys(migrations).sort()
