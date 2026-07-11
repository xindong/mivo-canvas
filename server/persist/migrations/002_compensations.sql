-- server/persist/migrations/002_compensations.sql
-- P-6 saga 补偿意图表(share_link_compensations)。vanilla SQL DDL 草案:权威 Kysely 迁移在
-- server/persist/migrations.ts 的 '2026_07_12_003_share_link_compensations'(app 启动 migrateToLatest 跑);
-- 本文件是 T1.3 风格纯 SQL 参考,供 runbook/手工 apply 用,DDL 与 migrations.ts 003 一致。
--
-- 设计:无 revision(补偿意图是 saga 协调器权威写,非 CRDT LWW);attempt_count/last_error/last_attempted_at
-- 是"可观察状态"——saga 非黑盒,可查可调试。op/status 用 CHECK 强制枚举。FK 同权限两表:project_id → projects(id)。
-- 独立 migration:001/002 已 applied 的库不会重跑(改既有 migration 不生效),新表必须新 migration 才能建。
-- IF NOT EXISTS → 可重放。生产实操由 lead 走 runbook(docs/runbook/t1.1-pg-provisioning.md)。

BEGIN;

CREATE TABLE IF NOT EXISTS share_link_compensations (
  id                text        PRIMARY KEY,                     -- surrogate uuid(应用层生成)
  project_id        text        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  op                text        NOT NULL CHECK (op IN ('restore', 'delete')),
  status            text        NOT NULL CHECK (status IN ('pending', 'done')),
  attempt_count     integer     NOT NULL DEFAULT 0,
  last_error        text,
  last_attempted_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- findPendingCompensation / recordCompensation 走此复合索引(project_id + op + status)。
CREATE INDEX IF NOT EXISTS idx_compensations_project_op ON share_link_compensations (project_id, op);

COMMIT;
