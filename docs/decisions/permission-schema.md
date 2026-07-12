# T1.4 权限层 schema:project_members / share_links

> 状态:**定稿(T1.4,2026-07-11)**。
> 权威:platform §13.5(归属模型)、`docs/decisions/dp4-identity-alignment.md`(身份载体)、`docs/decisions/soft-delete-semantics.md`(FX-7 share_link 恢复)、`docs/decisions/record-schema.md`(T1.2a 信封列风格)、`shared/persist-contract.ts`(#194 wire 契约,boundary 3 不改)。
> DDL:由 Kysely runner apply(`server/persist/migrations.ts` PERMISSIONS_SCHEMA,migration `2026_07_11_002_permissions_schema`);PG 实现在 `server/persist/pgPermissionBackend.ts`。

## 0. 边界回顾(来自 lead 任务包)

1. **不改 #194 契约**(`shared/persist-contract.ts`):权限表**不是** `PersistType` envelope record;`project_members`/`share_links` 是独立的权限层资源,不入 envelope persist backend,不进 `Project`/`CanvasMeta` wire shape。
2. **authz 检查点扩展**:权限是在 `canAccessProject`/`canAccessCanvas` 检查点上**扩展**(加 memberRole + sharePermission + per-action),不改 #194 wire 契约。
3. **实现先落内存后端**:#194 的 `InMemoryPersistBackend` 不动(boundary 2:T1.3 worker 可能碰 PG backend 文件);本层用**独立** `InMemoryPermissionBackend`(`server/lib/permissions.ts`),PG 落地由 T1.3 worker 把 DDL apply 到 PG + 实现 PG 版本。
4. **UI 不做**(boundary 4):本 PR 只做服务端 + API;邀请/分享面板 UI 报 lead 另派。

## 1. 表设计

### 1.1 project_members

| 列 | 类型 | 语义 | 约束 |
|---|---|---|---|
| `id` | text | surrogate uuid(应用层生成) | PK |
| `project_id` | text | 所属 project | FK → projects.id;INDEX |
| `user_id` | text | 成员 maker user id(= SSO `username`,DP-4) | INDEX;UNIQUE(project_id,user_id) |
| `role` | text | 成员角色 | CHECK IN ('owner','editor','viewer') |
| `created_at` | timestamptz | 创建时间 | NOT NULL DEFAULT now() |
| `updated_at` | timestamptz | 更新时间(改 role) | NOT NULL DEFAULT now() |

- **无 revision**:成员资格是 owner 权威写(§13.5 "仅 owner 可邀请"),非 CRDT LWW 合并。
- **无 is_deleted**:成员移除 = 硬删行(FX-7 软删不到 member;§5 矩阵未列 member 软删)。
- **UNIQUE(project_id,user_id)**:一个 user 在一个 project 里恰有一个 role;改 role = UPDATE(不是 INSERT 第二条)。

### 1.2 share_links

| 列 | 类型 | 语义 | 约束 |
|---|---|---|---|
| `id` | text | surrogate uuid | PK |
| `token` | text | 分享 token(密码学随机,不可枚举) | UNIQUE;INDEX |
| `project_id` | text | 被分享的 project | FK → projects.id;INDEX |
| `permission` | text | 链接权限 | CHECK IN ('view','edit');**≤ editor,永不 owner** |
| `created_by` | text | 创建者 user id(须为 project owner) | NOT NULL |
| `created_at` | timestamptz | 创建时间 | NOT NULL DEFAULT now() |
| `updated_at` | timestamptz | 更新时间 | NOT NULL DEFAULT now() |
| `revoked_at` | timestamptz NULL | revoke 标记(FX-7 软删);NULL=活 | — |
| `expires_at` | timestamptz NULL | 可选过期;NULL=不过期 | — |

- **token 不可枚举**:`crypto.randomBytes(32).toString('base64url')`(256-bit,~43 chars);不按递增 id,不按时间戳,防猜测。
- **permission ≤ editor**:`view` → 只读;`edit` → 读写;**永不授 owner**(不能 manage member / delete project / move canvas,见 §3)。
- **revoked_at = FX-7 软删**:revoke 后 `GET /api/share/:token` → 410 gone;30 天保留期内可 un-revoke(清 `revoked_at`);期满 purge(FX-7 §5.9/§5.10)。**本 PR 实现 revoke/un-revoke + 410;purge 30 天定时由 FX-7 落地**(见 §6 未验证项)。
- **无 user_id 绑定**:分享链接 token 驱动,不绑被分享人(任何持 token 者 = view/edit);§13.5 "分享链接"两种分享之一(另一种是邀请指定人,走 project_members)。

## 2. 角色与权限矩阵(§13.5 + FX-7 §5.12)

`AuthzAction`(#194 已有):`read` | `write` | `move`。T1.4 新增 `manage`(成员/分享管理 + delete project/canvas,仅 owner)。

| 角色/载体 | read (GET) | write (PATCH/POST child/DELETE node/POST chat) | move (PUT canvas projectId) | manage (invite/remove member, create/revoke share-link, delete project/canvas) |
|---|---|---|---|---|
| **owner** | ✅ | ✅ | ✅ | ✅ |
| **editor** | ✅ | ✅ | ❌(403) | ❌(403) |
| **viewer** | ✅ | ❌(403) | ❌(403) | ❌(403) |
| **share link `view`** | ✅ | ❌(403) | ❌(403) | ❌(403) |
| **share link `edit`** | ✅ | ✅ | ❌(403) | ❌(403) |
| **非成员 / 无 token** | ❌(404 unknown-*) | ❌(404) | ❌(404) | ❌(404) |

**404 vs 403 语义(boundary 3:不改 #194 wire 契约)**:
- **非成员 / 无分享 token** → 404 `unknown-project`/`unknown-canvas`(**与 #194 一致,无存在泄漏**)。此类 actor 根本不知道资源存在。
- **成员越权**(editor manage/delete,viewer write/move/delete)→ **403 `{ error: 'forbidden' }`**(server-local body,**不**加进 `shared/persist-contract.ts` 的 `ApiErrorBody`,保 #194 契约不变;R-4)。成员已能 GET(知资源存在),404 会误导;403 正确(FX-7 §5.12 "editor 调 deleteProject 返回 403")。
- **分享越权**(view token write,edit token manage/move/delete)→ 403(同上;持 token 者已能 GET,知资源存在)。
- **revoked share token** → 410 gone(FX-7 §5.9;非 404,因 token 是公开入口,410 明确"曾存在已吊销")。
- **未知/不存在 share token** → 404(无存在泄漏,与 #194 一致;不暴露"此 token 从未存在"vs"已吊销"的区别——但 revoked 用 410 区分活/吊销,未知 token 用 404,见 §4 token 解析)。

## 3. owner 派生 vs 显式 member 行

`projects.ownerId`(#194 envelope `Project.ownerId`)是 owner 的**唯一真相源**。`project_members` 的 `owner` 行是冗余兜底:

- **派生优先**:`canAccessProject` 先判 `actor === project.ownerId` → owner(无需 member 行)。保证 T1.3 owner===actor 自归属路径(指纹 fallback)零变化——**不要求** owner 必有 member 行。
- **显式行兜底**:若 `project_members` 有 `(project_id, actor, 'owner')` 行,也认 owner(便于"列表成员含 owner"场景)。
- **editor/viewer** 必须有显式 member 行(邀请写入)。

→ 本 PR **不**在 `POST /api/projects` 创建项目时自动插 owner member 行(派生已够);`GET /api/projects/:id/members` 列成员时**合成** owner 行(从 `project.ownerId` 派生 + 实际 member 行)。

## 4. 分享 token 解析(share link access path)

```
GET /api/share/:token   (公开入口,无需鉴权)
  → resolveShareLinkByToken(token)
    → token 不存在           → 404 {error:'unknown-share-token'}   (无存在泄漏)
    → token revoked_at 非空    → 410 {error:'gone', reason:'revoked'}  (FX-7 §5.9)
    → token expires_at 过期   → 410 {error:'gone', reason:'expired'}
    → token 活                → 返 project meta + canvas 列表(read)
                               (edit token 同样返 read 视图;写动作走带 token 的 /api/projects|canvas 路由)
```

带 token 写访问:`PATCH /api/projects/:id`、`PATCH /api/canvas/:id/...`、`POST /api/canvas/:id/chat` 等带 `x-mivo-share-token` header(或 `?share=` query)。route 解析 token → sharePermission(view/edit)→ canAccess* 判 write/edit。view token write → 403。

**token 信任**:token 是 bearer 凭证,任何人持 token 可访问——故 token 必须密码学随机不可枚举,且 owner 可 revoke 吊销。生产 HTTPS 传输;token 不进 server 日志(对齐 keys.ts "raw key 永不落日志"惯例)。

## 5. in-memory vs PG 落地(boundary 2)

| 层 | 本 PR(T1.4) | T1.3 worker(PG 落地) |
|---|---|---|
| `InMemoryPermissionBackend` | ✅ `server/lib/permissions.ts` 实现 + 全链路测试 | — |
| PG DDL | ✅ `server/persist/migrations.ts` PERMISSIONS_SCHEMA(Kysely migration,原 `001_permissions.sql` vanilla 草案已删,runner 不加载外部 SQL) | apply DDL + 实现 `PgPermissionBackend`(同 `PersistBackend` PG swap 模式) |
| `PersistBackend`(#194 envelope) | **不动**(boundary 2) | PG swap `InMemoryPersistBackend` → PG |
| 路由 | `canAccess*` 扩展 + member/share 路由,接 `PermissionBackend` 接口 | 路由不动,swap 注入的 backend 实现即可 |

`PermissionBackend` 接口(`server/lib/permissions.ts`)定义同 `PersistBackend` 的 in-memory + 接口模式;PG 实现由 T1.3 worker 补(同 `InMemoryPersistBackend` ↔ PG 的对偶)。

## 6. 未验证项 + 风险(报 lead)

| ID | 项 | 说明 |
|---|---|---|
| P-1 | **share_link purge 30 天定时未实现** | FX-7 §5.10 "保留期满才可 purge(30 天)";本 PR 实现 revoke(un-revoke + 410),**不**实现 30 天 purge 定时(属 FX-7 落地)。内存后端无 purge,重启清空。 |
| P-2 | **owner 转移未实现** | "改 project.ownerId"(转 owner 给他人)+ 同步 member 行,本 PR 不做(§13.5 第一版"仅 owner 可邀请",不涉及转移)。 |
| P-3 | **邀请接受流程未实现** | 本 PR `POST /api/projects/:id/members` 由 owner 直接添加成员(无需被邀请人接受);§13.5 第一版"仅 owner 可邀请"语义。邀请链接/接受 UI(boundary 4)另派。 |
| P-4 | **member 上限未设** | 未限单 project member 数(DoS 面:owner 脚本批量加成员);第一版单用户 owner 信任,暂不设上限。生产前 review 再评估 rate-limit。 |
| P-5 | **403 body 未进 shared 契约** | 见 DP-4 R-4;客户端 PersistAdapter 当前不触发 403(owner-only),editor/viewer UI 未建。 |
| P-6 | **跨后端级联非原子 + 重试不收敛(已知 tradeoff)** | DELETE project 的 `softDeleteProjectTree`(PersistBackend)+ `revokeAllForProject`(PermissionBackend)非同一事务(详见 §7);第二步失败 → 500,project 已软删但 share_links 未 revoke(部分提交)。**重试不补齐第二步**:DELETE 重试命中 `!got.record.isDeleted` 短路返 204、POST 重试命中 `result.kind !== 'restored'` 返 200,均跳过级联。DELETE 侧靠 410 兜底 + restore 自愈(revoke 未落地则 un-revoke 无事可做);RESTORE 侧有缺口(链接残留 revoked,须人工 un-revoke/对账)。生产前 review saga/补偿事务让两侧幂等收敛。 |

## 7. 与 FX-7 软删语义的对齐

| FX-7 实体 | T1.4 处理 |
|---|---|
| project soft delete 级联 share_links | ✅ **已实现(route 层,非 backend 内)**:`DELETE /api/projects/:id` 在 `backend.softDeleteProjectTree(...)` 成功后 `await permissions.revokeAllForProject(id)`(`server/routes/projects.ts:282-284`);`POST` 命中 deleted → `ensureCreate` 返 `restored` 后 `await permissions.unRevokeAllForProject(id)`(`projects.ts:153-155`)。**未改 `softDeleteProjectTree` 本身**(boundary 2/3 仍守);级联在 route handler 串两步,非 persist backend 内,故跨后端非原子(见下方 tradeoff,P-6)。 |
| share_link revoke(`revoked_at`) | ✅ 本 PR 实现(revoke + un-revoke + 410)。 |
| share_link purge 30 天 | ❌ FX-7 落地(P-1)。 |
| 权限矩阵(§5.12) | ✅ 本 PR 实现(§2 矩阵)。 |

→ **级联已实现(本 PR route 层),tradeoff 如下(P-6)**:`softDeleteProjectTree`(PersistBackend)与 `revokeAllForProject`/`unRevokeAllForProject`(PermissionBackend)是**两个后端、非同一事务**。route handler 串行 `await`,无 try/catch:第一步 project 软删/restore 提交后,第二步若抛错,route 返 **500(fail-visibly,Hono 默认 onError)**,此时 project 状态已落、share_links 级联未完成(**部分提交**)。**重试不补齐第二步**(Greptile 审查亦指出):DELETE 重试命中 `if (!got.record.isDeleted)` 短路(project 已软删)→ 跳过 `revokeAllForProject`,返 204;POST 重试命中 `result.kind !== 'restored'`(project 已 live)→ 跳过 `unRevokeAllForProject`,返 200。故 500 后状态可能**持久不收敛**,非"重发即补齐"。**对外安全性分两侧**:① **DELETE 侧**(revoke 失败)——project 软删后 `GET /api/share/:token` 在 token 仍活时还过 `backend.get(project).isDeleted` 检查 → **410 gone reason:project-deleted**(`server/routes/shareLinks.ts:227-230`)兜底,持 token 者读不到 project;且若 project 后被 restore,因 revoke 从未落地,un-revoke 无事可做,链接随 restore 自然回到活态(**自愈**)。② **RESTORE 侧**(un-revoke 失败)——**有收敛缺口**:share_links 残留 revoked,project 已 live 但链接仍返 410(reason:revoked),重试 POST 不触发 un-revoke;须 owner 手动 `POST /:id/share-links/:linkId/restore` 逐条 un-revoke,或跑对账补偿流(list share_links → 对齐 revoked 状态与 project liveness)。**不美化**:跨后端级联非原子,500 后 DELETE 侧靠 410 + restore 自愈兜底,RESTORE 侧靠人工/对账补偿,均非单事务回滚;以 #201 终审实测行为为准。P-6 建议生产前 review 是否上 saga/补偿事务使两侧幂等收敛。
