# 软删语义定稿（FX-7）

> 状态：**草案 / 待 lead 确认 DP-3**（DP-3 = 删画布是否级联软删对话；本文件给推荐，标"待 lead 确认"）。
> 日期：2026-07-10。
> 定位：架构迁移 P1 的语义权威——T1.3（4 API）/ T1.4（权限）/ FX-7 实施前，"project delete vs canvas delete"的级联范围、恢复行为、保留期、purge 与 asset refcount 回收全部在此一张表定死。没有这张表，后端删除路径会各写各的语义。
> 上游真相源：`docs/decisions/platform-architecture-2026-07-07.md`（§6/§13.1/§13.5）、`docs/decisions/record-schema.md`（#174，DP-5/DP-6/DP-8/§5/§6 矛盾 3）、`docs/plan/arch-migration-execution-plan.md`（§3 DP-3、§4 FX-7 行）。
> 源码事实源（现状逐条抄核，非凭记忆）：`src/store/projectsSlice.ts`、`src/store/documentSlice.ts`、`src/store/nodeMutationSlice.ts`、`src/store/chatStore.ts`、`src/lib/assetUrlLease.ts`、`src/lib/assetStorage.ts`、`server/lib/assets.ts`、`server/routes/local-assets.ts`，及表征测试 `src/store/projectsSlice.test.ts`（#164）、`src/store/chatHydration.characterization.test.ts`（#167）。
>
> **术语**：soft delete = 标 `is_deleted=true`（record 级信封列，DP-5 已定），逻辑不可见、可 restore；restore = `is_deleted=false` 复活；purge = 物理删除 record 行（不可恢复）；hard delete = 当前现状，直接从 store/集合移除，无 `is_deleted` 标记。refcount = 活引用计数（非软删的引用才计）。

---

## 0. 摘要（lead 一眼看完）

- **现状一句话**：当前仓库删除语义 = **全硬删 + 级联回落混合**，**零软删基础设施**（0 个 `deleted`/`deletedAt`/`trashed`/`purge`/`tombstone`/`softDelete` 字段或函数，全仓 grep 已证）。asset 仅客户端有 blob URL 的 refcount lease（管内存不管存储），服务端无 asset 删除路由、无内容寻址。
- **目标一句话**：record 级 `is_deleted` 信封列（DP-5 已定）做软删基础设施；本表定**哪些实体软删、级联到谁、保留期、purge 判定**。粒度原则：**软删只到 canvas/project/chat-collection 粒度，不到单 node**（单 node 删仍硬删 + undo 栈恢复，避免 CRDT tombstone 膨胀）。
- **DP-3 推荐结论（待 lead 确认）**：**删画布级联软删对话**（chat collection 随 canvas 一起 `is_deleted=true`，可一起 restore）。理由见 §3。**与 `chatHydration.characterization.test.ts:380` 现状表征直接冲突**（该测试自标"现状（DP-3）"钉死"deleteCanvas 不级联清 chat"）→ 迁移时**须同步迁移表征**。
- **最大现状冲突**：`deleteProject` 现状是"硬删 project + canvas 回落 standalone"（`projectsSlice.ts:66-100`，#164 钉死）；若目标改为"级联软删 canvases"，#164 的 standalone 回落断言须改。见 §6/§7。

---

## 1. 实体与 scope 归属（对齐 platform §13.1/§13.5）

| 实体 | scope | 服务端表/集合（目标） | 现状存放处 | 软删字段（目标） |
|---|---|---|---|---|
| **project** | document | `projects(id, ownerId, ...)` | 客户端 `projectsSlice.projects` 数组（`projectsSlice.ts:33`） | `is_deleted`/`deleted_at` 信封列 |
| **canvas** | document | `canvases(id, projectId, ownerId, ...)` records 扁平化 | 客户端 `canvases` map（`documentSlice.ts`） | `is_deleted`/`deleted_at` |
| **node** | document | node record（`id/canvas_id/type/revision/scope/is_deleted/...`，DP-5） | `canvases[c].nodes[]`（`documentSlice.ts`） | `is_deleted`（**但单 node 删不软删，见 §2 注**） |
| **chat collection** | document（per-canvas） | `chat_messages` 集合，键 = canvasId（DP-6/record-schema §5） | `chatStore.messagesByScene[sceneId]`（`chatStore.ts:86`） | collection 级 `is_deleted`/`deleted_at` |
| **asset** | asset（内容寻址） | `assets(content_hash, bytes, refcount)` | 客户端 IDB（`assetStorage.ts`）+ blob URL lease（`assetUrlLease.ts`） | 无 `is_deleted`（**refcount 驱动物理删，见 §4**） |
| **share_link** | document（派生） | `share_links(token, projectId, permission, ...)`（platform §13.5，T1.4 新建） | **未实现**（T1.4 待建） | `revoked_at`（语义≈软删，见 §2） |
| **task** | session/编排 | 服务端 tasks registry（DP-8/FX-2 per-user），**document record 无 tasks 字段** | `CanvasDocument.tasks[]`（过渡，迁后删字段） | **不软删**（运行态，过期/取消即终态，见 §2） |

> scope 来源：platform §13.1（document/user/session/presence 四层 + asset 独立域）。归属模型（§13.5）：`projects(ownerId)` + `project_members(role)` + `share_links(token, permission)`，owner/editor/viewer 三角色，chat per-canvas 随画布分享对成员可见。task 归属见 record-schema §4.3（DP-8 已拍：迁服务端 registry，document record 无 tasks 字段）。

---

## 2. 软删语义总表（需求 1：实体 × 操作矩阵）

每格 = **级联到谁 / 可否恢复 / 保留期建议 / UI 可见性**。

| 实体 | soft delete | restore | purge（物理删） |
|---|---|---|---|
| **project** | **级联**：`is_deleted=true` 作用于 project + 其下所有 canvas（含其 chat collection）+ share_links（项目级链接）。**不级联**到其他 project 的 canvas。可恢复。保留期 **30 天**。UI：侧栏项目列表隐藏，进"已删除"区可见。 | project 及级联实体一并 `is_deleted=false` 复活。**原子**：要么全恢复要么全不恢复。 | 30 天保留期满 / 用户手动"永久删除"。purge project → 级联 purge 其 canvas（→ node 硬删 → asset refcount 减，见 §4）+ chat collection + share_links。不可恢复。 |
| **canvas** | **级联（DP-3 推荐，待 lead 确认）**：`is_deleted=true` 作用于 canvas + 其 **chat collection**（DP-6 随 canvas 生命周期）+ 其下 node 的 UI 可见性（node record 不单独软删，canvas 软删即整画布不可见）。**不级联**到 project（project 保留）。可恢复。保留期 30 天。UI：画布切换器/侧栏隐藏，"已删除"区可见。 | canvas + 其 chat collection 一并复活。原子。 | purge canvas → 其下 node 全部硬删（asset refcount 减）+ chat collection 物理删 + canvas record 物理删。不可恢复。 |
| **node（单节点删）** | **不软删**（保持硬删 + undo 栈恢复）。理由：单 node 软删会在 CRDT 产生 tombstone，千节点画布膨胀；undo 栈已是单节点误删的恢复路径。UI：删即不可见，undo 可恢复（session 级，跨设备不同步，platform §13.1 session 域）。 | 走 undo 栈（`historyPast`/`historyFuture`，`documentSlice.ts`），非软删 restore。 | undo 栈耗尽即不可恢复（已是现状，`nodeMutationSlice.ts:300` 硬删）。**注意**：被硬删 node 引用的 asset → refcount 减（见 §4）。 |
| **chat collection**（整 canvas 对话） | **被动级联**：不单独软删，随 canvas soft delete 一起 `is_deleted=true`（DP-3）。单独"清空对话"动作（`clearScene`）= 硬清空消息内容，**不**软删 collection（见 §6）。UI：随 canvas 隐藏。 | 随 canvas restore。 | 随 canvas purge 物理删。 |
| **chat message（单条）** | **不软删**（硬删/编辑替换）。`serverTaskId`/`sourceDeleted` 已持久化（`chatStore.ts:41/61`）供归因，非软删标志。UI：删即移除。 | 无（undo 栈或重新生成）。 | 删即终态。 |
| **asset** | **不软删**（无 `is_deleted`）。refcount 驱动：节点引用存在则 asset 活。UI：通过节点引用间接可见。 | N/A（refcount>0 即活，无需 restore）。 | refcount=0 + 宽限期（建议 **7 天**）→ 物理删 bytes。见 §4。 |
| **share_link** | **revoke**（`revoked_at`，语义≈软删）：token 失效，不可访问。保留期 30 天（审计）。UI：分享管理列表隐藏 revoked。 | 可 un-revoke（清 `revoked_at`），30 天内。 | 30 天保留期满物理删 link record。 |
| **task** | **不软删**（运行态）。cancel/expire/complete 即终态。UI：任务卡随状态更新。 | N/A。 | registry TTL 过期自动清理（FX-2 per-user 隔离）；僵尸卡回落见 FX-3（`settleExpiredChatMessages` 服务端复跑）。 |

**表注**：
- "可恢复"= soft delete 后 restore 能复活；purge 后不可恢复。
- 保留期均为**建议默认**，可配置；最终值 lead 拍。
- "级联"= soft delete 一次操作触发多个实体 `is_deleted=true`；"被动级联"= 该实体自己不发起软删，由父实体级联带出。
- node/chat message 单条不软删的决策见 §3 旁注与 §8。

---

## 3. DP-3 拍板建议（需求 2：删画布是否级联软删对话）

**待 lead 确认。** 本节给推荐 + 选项 + 理由 + 影响面。

| 决策点 | 选项 | 推荐 | 理由 | 影响面 |
|---|---|---|---|---|
| 删画布是否级联软删对话（DP-3） | (a) 级联软删：canvas `is_deleted=true` → 其 chat collection 同 `is_deleted=true`，一起可 restore **(b) 不级联：canvas 软删但对话独立存活（现状语义） (c) 级联硬删：canvas 软删 + 对话直接物理删 | **(a) 级联软删** | ① DP-6（record-schema §5）已定方向："chat 随文档域走 `/api/canvas` 子资源，messagesByScene 键随 canvas 生命周期"——chat 生命周期**已绑死 canvas**，canvas 软删时 chat 不级联 = 对话悬空成孤儿。② platform §13.5："chat per-canvas，随画布分享对成员可见"——canvas 软删但对话仍 live，成员会看到无画布对应的孤儿对话，UI/权限语义错乱。③ FX-7 本就是"误删可恢复"语义，对话是画布语境的核心组成，分开恢复会造成"画布回来了但对话没了"的半残态。④ (c) 硬删违背软删可恢复目标，排除。 | **与 `chatHydration.characterization.test.ts:380` 直接冲突**（该测试钉死"deleteCanvas 不级联清 chatStore.messagesByScene"，断言 `messagesByScene['doomed'].toHaveLength(1)`，注释自标"现状（DP-3）"）。落地 (a) **须同步迁移该表征**：断言从"对话仍在"改为"对话 collection `is_deleted=true`（软删隐藏，purge 前可 restore）"。属 §7 碰撞点 #C2。 |

> **旁注（单 node / 单 chat message 不软删的决策）**：软删粒度到 canvas/project/chat-collection，**不到单 node、不到单 chat message**。理由：① 单 node 软删在 CRDT（Yjs）产生 tombstone，千节点画布 tombstone 膨胀拖垮合并；② 单 node 误删的恢复路径已是 undo 栈（`historyPast`/`historyFuture`，session 域，platform §13.1 明列 session 不同步），够用；③ 单 chat message 删即编辑语义，不需要 trash bin。这条与 DP-3 正交（DP-3 是 collection 级，不是 message 级），记录在此避免实施时把软删下沉到 node/message 粒度。

---

## 4. asset refcount 回收（需求 3：内容寻址 purge 判定）

> 现状缺口：platform §13.5 B5 列"服务端资产 GC/配额"为未消化 B 类缺口；record-schema §6 矛盾 3 标 asset 现 url 非 assetId，内容寻址在 T1.5 落地。本节定 T1.5 后的 refcount 语义。

### 4.1 现状（抄核）
- **客户端 blob URL refcount**（`src/lib/assetUrlLease.ts:1-137`）：`acquireAssetUrl(assetUrl)` → 多消费者共享一个 blob URL，`refCount += 1`；`release()` → `refCount -= 1`；`refCount=0` → `URL.revokeObjectURL`（**只回收 blob URL 内存，不删 IDB 里的 asset bytes**）。非 `mivo-asset:` 的 pass-through URL 无 refcount。
- **客户端 asset 存储**（`src/lib/assetStorage.ts`）：`saveGeneratedAsset`/`saveImportedAsset` → IDB，**无删除函数**，无 refcount，bytes 永驻（靠浏览器 evict 或手动 clear）。
- **服务端**（`server/lib/assets.ts`、`server/routes/local-assets.ts`）：`readLocalAssets()` 本地目录浏览，**无删除路由，无内容寻址，无 GC**。

### 4.2 目标 refcount 语义（T1.5 内容寻址后）
- **asset 标识**：`assetId = content_hash`（内容寻址）。node.asset.assetId 指向 content_hash（record-schema §2.4/§3.5：T1.5 后 asset.url → assetId）。
- **refcount 定义**：`refcount(content_hash) = count(活 node.asset.assetId == content_hash)`，跨**所有** canvas（含其他 project 的 canvas）。活 = 该 node record 未被 purge（**软删的 node 仍计 refcount**——软删可恢复，asset 必须留）。
- **何时减**：
  - node 被**硬删**（单 node 删 `nodeMutationSlice.ts:300`，或其 canvas 被 purge 时的级联硬删）→ 该 node 的 assetId 引用移除 → refcount -= 1。
  - node.asset 字段变更（换图）→ 旧 assetId refcount -= 1，新 assetId refcount += 1。
  - **软删 canvas 不减**：canvas `is_deleted=true` 时其 node 仍在，refcount 不变（restore 要用）。
- **何时加**：
  - 新建/导入 asset → content_hash 入库，refcount=1（若 content_hash 已存在则复用 bytes，refcount += 1，**去重**）。
  - 节点引用已有 asset → refcount += 1。
- **归零后物理删判定**：
  - `refcount == 0` → 进入**宽限期 7 天**（覆盖单 node 误删的 undo 窗口 + canvas 误删 restore 窗口）。
  - 宽限期内 refcount 回升（undo / restore）→ 取消物理删。
  - 宽限期满且仍 `refcount == 0` → 物理删 asset bytes + 记录行。
- **配额**（B5）：per-user asset 存储配额；超额时优先驱逐 `refcount==0` 且超宽限期的 asset，仍不足则拒绝新上传（不删活引用）。配额阈值与驱逐策略 T1.5/T1.4 细化，本文件只定"refcount==0 + 宽限期 = 可驱逐"。

### 4.3 客户端 lease 与服务端 GC 的边界
- 客户端 `assetUrlLease`（blob URL refcount）**保留不动**（platform §13.2/§13.3：lease 原样）——它管的是"同一 asset 在多个渲染消费者间共享一个 blob URL"的内存回收，与服务端 bytes 的 refcount 是**两层**：lease=内存 URL 生命周期，服务端 refcount=bytes 生命周期。
- T1.5 后客户端 `saveGeneratedAsset` 改为 `POST /api/assets` 拿 assetId（record-schema §2.4 过渡注记），`resolveAssetUrl` 改为 `GET /api/assets/:id`；lease 复用（platform §13.2 明列）。

---

## 5. purge 验收标准（需求 4：可测试条款，留给实施 PR 用）

> 以下为 FX-7 实施 PR / T1.3/T1.4 实施 PR 的可验收条款。每条应能写成一个测试断言。

1. **soft delete 不物理删**：`deleteProject(p)` 后，`projects` 表 `p.is_deleted=true`，`p` 行仍在；其 canvas `is_deleted=true` 且行仍在；chat collection 行仍在。断言：DB 查 `is_deleted=true` 的 project/canvas/chat 仍存在。
2. **restore 原子性**：`restoreProject(p)` 后，p + 其所有 canvas + 其 chat collection 全部 `is_deleted=false`；不存在"project 恢复了但某 canvas 仍软删"的中间态（事务回滚）。断言：restore 后无 `is_deleted=true` 的级联残留。
3. **级联范围正确（DP-3 落地后）**：`deleteCanvas(c)` → `c.is_deleted=true` 且 `c` 的 chat collection `is_deleted=true`；**不**影响其他 canvas / project。断言：同 project 其他 canvas `is_deleted` 不变。
4. **purge 不可恢复**：`purgeProject(p)`（保留期满）后，p + 其 canvas + chat collection + share_links 物理删，DB 查无行；asset refcount 按其 node 引用减少。断言：purge 后 restore 接口返回 not-found。
5. **asset refcount 减正确**：node 硬删后，其 assetId 的 refcount -= 1；同一 asset 被 2 个 node 引用时，删 1 个 node 后 refcount=1（asset 仍在），再删另 1 个 refcount=0（进入宽限期）。断言：refcount 计数与活引用数一致。
6. **软删 node 仍计 refcount**：canvas 软删（其 node 未 purge）后，其 node 引用的 asset refcount**不减**；canvas restore 后 refcount 不变。断言：软删 canvas 前后 asset refcount 相等。
7. **asset 归零宽限期**：refcount=0 后立即查 asset bytes 仍在（宽限期内）；模拟时间推进过宽限期后 bytes 物理删。断言：宽限期内 `GET /api/assets/:id` 200，期满后 404。
8. **asset 去重**：两次上传相同内容 → 同一 content_hash，bytes 只存一份，refcount=2。断言：存储层 content_hash 唯一。
9. **share_link revoke**：revoke link 后 `revoked_at` 非空，`GET /share/:token` 返回 410（gone）；un-revoke（宽限期内）恢复 200。断言：revoked token 不可访问。
10. **保留期满才可 purge**：soft delete 后未满保留期，`purge` 接口拒绝（409）；满保留期可 purge。断言：保留期内 purge 返回 409。
11. **UI 可见性**：soft delete 后，项目列表/画布切换器默认查询 `WHERE is_deleted=false`，软删实体不出现在默认视图；"已删除"区查询 `is_deleted=true`。
12. **权限**：只有 owner 可 soft delete / restore / purge project 与 canvas；editor 可删 node（非软删）；viewer 不可删。断言：editor 调 `deleteProject` 返回 403。

---

## 6. 现状 vs 目标差异表（需求 6：现在代码实际怎么删 vs 目标语义）

| 实体 | 现状（file:line + 实际行为） | 目标语义（本文件） | 差异/迁移动作 |
|---|---|---|---|
| **project delete** | `projectsSlice.ts:66-100`：硬删 project 记录（`projects.filter(p=>p.id!==id)`），所属 canvas **回落 standalone**（`projectId→undefined`，canvas body 不删，`updatedAt` 不动）。#164 钉死（`projectsSlice.test.ts:142-197`："cascades: fall back to standalone"、"does not delete the canvases themselves"）。 | soft delete project + **级联 soft delete 其 canvas**（不再回落 standalone）+ 级联 share_links。 | **行为变**：从"回落 standalone"→"级联软删 canvas"。**冲突 #164**（standalone 回落断言须改）。迁移：`deleteProject` 改 `is_deleted=true` 级联，不再 `projectId→undefined`。 |
| **canvas delete** | `documentSlice.ts:123-161`：硬删 canvas（`delete remainingCanvases[targetId]`），guard ≥1 canvas，active→first-survivor 回落（`canvasIds.find(id=>id!==targetId)`）。 | soft delete canvas + 级联 soft delete 其 chat collection（DP-3）。guard ≥1 canvas 保留。 | **行为变**：硬删→软删；**新增 chat 级联**（现状无）。first-survivor 回落逻辑可保留（active canvas 软删后切下一个活 canvas）。 |
| **canvas delete → chat** | **无级联**：`chatHydration.characterization.test.ts:380` 钉死"deleteCanvas 不级联清 chatStore.messagesByScene（跨 store 无订阅）"，`messagesByScene['doomed']` 保留。 | 级联 soft delete chat collection（DP-3 推荐）。 | **行为变 + 表征冲突**（§7 #C2）。迁移：canvas 软删时同步 `is_deleted=true` chat collection。 |
| **node delete** | `nodeMutationSlice.ts:300-317`：硬删 node + 级联 section children + 级联 edges（`from/to` 涉及被删 node）。`deleteSelectedNodes` :318-344 同。undo 栈可恢复。 | **保持硬删 + undo**（不软删单 node）。asset refcount 减。 | **行为不变**（删法不变），**新增**：硬删时其 asset refcount -= 1（T1.5 后）。 |
| **chat clearScene** | `chatStore.ts:105`（类型签名）`clearScene(sceneId)`：`messagesByScene[sceneId]=[]`（key 残留，内容硬清空；行为由 #167 `chatHydration.characterization.test.ts:370` 表征钉死）。 | "清空对话"= 硬清空消息内容，**不**软删 collection（collection 软删只随 canvas 级联）。 | **行为不变**：clearScene 语义保留（硬清空内容，非软删）。collection 软删是另一条路径（随 canvas）。 |
| **chat message 单条** | 硬删/编辑替换，无 `deletedAt`。`serverTaskId`/`sourceDeleted` 持久化（`chatStore.ts:41/61`，`sourceDeleted` 是 mask-edit 归因 `maskEditGeneration.ts:260/441`，非软删标志）。 | 不软删（保持）。 | **不变**。 |
| **asset** | 客户端 blob URL refcount lease（`assetUrlLease.ts:1-137`，管内存）；IDB bytes 永驻无 GC（`assetStorage.ts`）；服务端无删除/无内容寻址（`server/lib/assets.ts`）。 | 服务端内容寻址 refcount + 归零 7 天宽限物理删（§4）。 | **新增整套**：T1.5 建 asset content_hash + refcount + GC。客户端 lease 保留不动。 |
| **share_link** | **未实现**（T1.4 待建）。 | revoke（`revoked_at`）+ 30 天 + purge。 | **新增**（T1.4）。 |
| **task** | `CanvasDocument.tasks[]`（过渡），无删除 slice。DP-8 拍迁服务端 registry。 | 不软删，registry TTL 过期清理（FX-2/FX-3）。 | document record 删 tasks 字段（DP-8）；registry GC 走 TTL。 |
| **soft-delete 基础设施** | **0**（全仓无 `deleted`/`deletedAt`/`trashed`/`purge`/`tombstone`/`softDelete`）。 | record 级 `is_deleted`/`deleted_at` 信封列（DP-5）。 | **新增**：信封列已在 DP-5 定；本表定语义。 |

---

## 7. 与表征测试的碰撞点（需求 5：凡与现状表征冲突处标"迁移时须同步迁移表征"）

> 硬约束（plan §2/§7 + record-schema §7）：**表征测试先行、迁移后一字不改**——但"一字不改"指断言语义不改；**数据来源/触发行为变了**的，须同步迁移表征（断言数不减、内容语义不改，只改数据来源/级联行为）。下表凡标 ⚠️ 的点，迁移 PR 须在说明里列"表征同步迁移"并附前后跑通证据。

| # | 表征测试 | file:line | 现状断言（钉死） | 目标语义冲突 | 迁移动作 |
|---|---|---|---|---|---|
| **C1** | #164 `projectsSlice.characterization.test.ts` + `projectsSlice.test.ts` | `projectsSlice.test.ts:149-166,180-190` | "deleteProject cascades: canvases fall back to standalone (projectId undefined)" + "does not delete the canvases themselves" | 目标：deleteProject 级联 soft delete canvases（不再回落 standalone） | ⚠️ **迁移时须同步迁移表征**：断言从"canvases projectId→undefined 且 body 保留"改为"canvases `is_deleted=true`（随 project 软删）"；断言数不减。`updatedAt` 不 bump 的断言保留（软删不改 content，仍不 bump `updated_at`，但可写 `deleted_at`）。 |
| **C2** | #167 `chatHydration.characterization.test.ts` | `:380` "canvasStore.deleteCanvas 不级联清 chatStore.messagesByScene（跨 store 无订阅）"，`:399-400` 断言 `messagesByScene['doomed'].toHaveLength(1)`，注释自标"现状（DP-3）" | 目标（DP-3 推荐）：deleteCanvas 级联 soft delete chat collection | ⚠️ **迁移时须同步迁移表征**：断言从"对话仍在（length 1）"改为"chat collection `is_deleted=true`（软删隐藏，purge 前可 restore）"。注释"现状（DP-3）"改为"DP-3 已定：级联软删"。**依赖 lead 确认 DP-3 选 (a)**。 |
| **C3** | #167 `chatHydration.characterization.test.ts` | `:370` "clearScene 之后 sceneId key 仍存在于 messagesByScene（残留）" | clearScene 硬清空内容，key 残留 | **不冲突**：clearScene 语义保留（硬清空，非软删 collection） | 无须迁移。但实施时须区分 clearScene（硬清空）vs canvas soft delete（collection 软删）两条路径，不要把 clearScene 改成软删。 |
| **C4** | #168 `canvasActionModel.characterization.test.ts` | record-schema §7 标 baseline 315 expect/203 tests | deleteNode 走硬删 + undo；status/anchor 相关 | deleteNode 保持硬删（不软删单 node）→ **不冲突** | 无须迁移（node 删法不变）。asset refcount 减是新增副作用，表征不覆盖 refcount，不触发断言变化。 |
| **C5** | #164 deleteProject no-dangling 回落 | `projectsSlice.test.ts:142-197` 全段 | deleteProject 硬删 project + standalone 回落 + updatedAt 不 bump + 不删 canvas body + no-op on missing | 同 C1 | ⚠️ 同 C1，须同步迁移。 |

> **总结**：⚠️ 碰撞点 = **C1/C5（deleteProject 回落→级联软删）+ C2（deleteCanvas 不级联 chat→级联软删，依赖 DP-3）**。C3/C4 不冲突。迁移这些表征的前提是 lead 确认 DP-3 选 (a) 且 deleteProject 改级联软删。

---

## 8. 发现的矛盾与遗留问题（计划 vs 源码；本文件记录，不改源码/计划）

> 边界：只记录，不自行改。需 lead 裁决的标"待 lead 裁决"。

1. **DP-3 现状表征 vs 目标级联软删**（§7 C2）：`chatHydration.characterization.test.ts:380` 钉死"deleteCanvas 不级联 chat"且注释自标"现状（DP-3）"——即测试作者知道这是 DP-3 待定点，先钉了现状。本文件推荐选 (a) 级联软删，**与该表征冲突**。→ **待 lead 确认 DP-3**；确认 (a) 后 C2 迁移才动。
2. **deleteProject 回落 standalone vs 目标级联软删**（§7 C1/C5）：#164 钉死"回落 standalone"语义。目标若改"级联软删 canvas"，与 #164 冲突。→ **待 lead 裁决**：deleteProject 是 (a) 级联软删其 canvas（本文件推荐，UX 一致 + 整项目可恢复），还是 (b) 保留 standalone 回落（canvas 不随 project 软删，独立存活）。选 (b) 则不冲突 #164，但会产生"项目软删了、画布还在 standalone 列表"的孤儿 UI。本文件**推荐 (a)**，但标为待确认——因为它改 #164 钉死行为。
3. **软删粒度到不到单 node**：record-schema DP-5 信封列 `is_deleted` 是 record 级，理论上每个 node record 都能软删。但本文件定"单 node 不软删（硬删+undo）"。→ **不冲突**（设计选择，非源码矛盾）：理由是 CRDT tombstone 膨胀 + undo 栈已够。实施时若发现 undo 栈跨设备不同步导致用户误删无法恢复，可重审"单 node 软删"——但那会牵动 CRDT 映射（record-schema §1/§3），不在 FX-7 范围。**记录备查**。
4. **task 软删 vs document record 无 tasks 字段**：DP-8 拍 document record 无 tasks 字段（迁服务端 registry）。本文件定 task 不软删（registry TTL）。→ **不冲突**，但实施时注意：当前 `CanvasDocument.tasks[]` 删除路径（无 slice，靠 compactDocumentForPersist `cloneTasks` record-schema §4.3）在 document record 删 tasks 字段后消失，task 生命周期完全归 registry，FX-2/FX-3 承接。
5. **share_link 软删与 revoke 术语**：本文件把 share_link 的"软删"叫 revoke（`revoked_at`）。→ **不冲突**，术语对齐 T1.4 表设计时统一。
6. **asset 宽限期 7 天 vs canvas 保留期 30 天的耦合**：canvas 软删 30 天内可 restore，其间其 node 引用的 asset refcount 不减（软删 node 仍计引用）。canvas purge 后 node 硬删 → asset refcount 减 → 可能进 7 天宽限。→ **不冲突**，但实施时 asset GC 调度须在 canvas purge 之后触发，不能在 canvas soft delete 时就减 refcount。**记录为实施顺序约束**。

---

## 9. 落地清单（供 T1.3/T1.4/FX-7 实施 PR 引用）

- **T1.3（4 API）**：`/api/canvas` 子资源 chat（DP-6）须实现"随 canvas soft delete 级联 chat collection soft delete"（DP-3 选 (a) 后）；`/api/projects` `DELETE` 改 soft delete + 级联；`/api/user-state` 不涉及软删。
- **T1.4（权限）**：`projects`/`project_members`/`share_links` 表加 `is_deleted`/`deleted_at`/`revoked_at`；owner/editor/viewer 删除权限（§5 验收 12）。
- **T1.5（资产）**：asset content_hash + refcount + 7 天宽限 GC（§4）。
- **FX-7 实施 PR**：本表落代码 + 同步迁移表征 C1/C2/C5（DP-3 确认后）。
- **FX-2/FX-3**：tasks registry TTL GC + 僵尸卡回落（不软删）。

> 本文件不改源码、不改 plan/record-schema/platform-architecture；矛盾记录在 §8，待 lead 裁决。
