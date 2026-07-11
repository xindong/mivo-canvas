-- server/persist/migrations/001_permissions.sql
-- T1.4 权限层:project_members + share_links 两张表(PG DDL)。
-- 权威:docs/decisions/permission-schema.md + platform §13.5 + soft-delete-semantics.md(FX-7)。
--
-- 独立 migration 文件(boundary 2:T1.3 PG worker 可在其迁移 runner 里 apply;
-- 本文件是 vanilla SQL DDL,不绑 kysely JS 迁移格式——T1.3 worker 落 PG 时按其迁移
-- runner 约定包装/apply,DDL 不变)。
--
-- 信封列风格对齐 T1.2a envelope(id/created_at/updated_at + 域字段),但权限表**不带 revision**
-- (成员资格/分享是 owner 权威写,非 CRDT LWW 合并;§13.5 "仅 owner 可邀请")。
-- share_links 的"软删"用 revoked_at(FX-7 §2:revoke ≈ 软删),不用 is_deleted。
--
-- 前置依赖:projects 表(T1.3 persist backend PG 落地后存在;project_id FK 引用 projects.id)。
-- 本迁移在 projects 表迁移之后 apply。

BEGIN;

-- ── project_members:成员资格(owner/editor/viewer)──────────────────────────────
-- 一个 user 在一个 project 里恰有一个 role(UNIQUE(project_id, user_id))。
-- owner 可由 projects.ownerId 派生(actor===ownerId → owner),也可显式存 'owner' 行(冗余但便于
-- 统一查询);实施取"派生优先 + 显式行兜底"(见 permission-schema.md §3)。
CREATE TABLE IF NOT EXISTS project_members (
  id           text        PRIMARY KEY,                      -- surrogate uuid(应用层生成)
  project_id   text        NOT NULL,                         -- FK → projects.id(T1.3 落地后)
  user_id      text        NOT NULL,                         -- maker user id(= SSO username,DP-4)
  role         text        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_members_project_user_unique UNIQUE (project_id, user_id)
);

-- 列表"我被分享的项目"(按 user_id 反查)
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members (user_id);
-- 列表"某 project 的全部成员"(按 project_id 正查)
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members (project_id);

-- 注:成员移除 = 硬删行(project_members 不软删;FX-7 软删只到 project/canvas/chat-collection/
-- share_link,不到 member)。owner 转移/移除见 permission-schema.md §4(仅 owner 可管理成员)。

-- ── share_links:分享链接(token 驱动,permission ≤ edit,不授 owner)──────────────
-- token 密码学随机(不可枚举,32 bytes base64url ≈ 43 chars);revoked_at = FX-7 revoke 软删标记。
CREATE TABLE IF NOT EXISTS share_links (
  id           text        PRIMARY KEY,                      -- surrogate uuid
  token        text        NOT NULL UNIQUE,                  -- 密码学随机,不可枚举
  project_id   text        NOT NULL,                         -- FK → projects.id
  permission   text        NOT NULL CHECK (permission IN ('view', 'edit')),  -- ≤ editor,永不 owner
  created_by   text        NOT NULL,                         -- 创建者 user id(须为 project owner)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,                                   -- NULL=活;非空=revoke(FX-7 软删,30 天后 purge)
  expires_at   timestamptz                                    -- 可选过期(NULL=不过期)
);

-- 公开访问入口按 token 查(GE /api/share/:token 走此索引)
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_token ON share_links (token);
-- 列表"某 project 的全部分享链接"(owner 管理用)
CREATE INDEX IF NOT EXISTS idx_share_links_project_id ON share_links (project_id);

COMMIT;
