# 记忆层预留接缝文档（T2.4）

> 状态：**占位不实现**（seam-only）。本文件只把记忆层与目标架构的接缝写清楚，不写一行实现代码。
> 日期：2026-07-11。
> 范围：架构迁移 P2 条目 T2.4（`docs/plan/arch-migration-execution-plan.md` §4 P2 行：记忆层预留｜不变（占位不实现）｜验收=接缝文档化）。下一批 N3（plan §4「下一批」：N3 AI Agent 记忆，借鉴 maker agent_memory）真正实施时，以本文件为接缝起点拍决策。
> 上游真相源：
> - `docs/decisions/platform-architecture-2026-07-07.md`（§3 四总线、§6 CRDT-ready、§13 四层 scope + 共享/归属模型）
> - `docs/decisions/record-schema.md`（T1.2a record schema + CRDT 映射纪律）
> - `docs/decisions/kernel-dualtrack-contract.md`（§4.5 new-only 字段可重建性——已埋「记忆接缝索引」位）
> - `docs/plan/arch-migration-execution-plan.md`（§3 DP-6 chat 归属、T2.4 行）
> - `docs/plan/agent-composer-unknowns-map.md`（in-flight：四层记忆 + D4/D5 项目简报归属决策）——该文件尚未合入 main，作为同批 in-flight 计划参考，N3 动手前以合入版为准。
>
> 源码事实源（天然挂接点，**仅引用不新增代码**）：`shared/persist-contract.ts`、`src/kernel/docKernel.ts`、`src/kernel/sessionStore.ts`、`src/kernel/docKernelPersistAdapter.ts`、`server/routes/userState.ts`、`server/routes/canvas.ts`。

---

## 0. TL;DR（给 N3 的接缝结论）

1. **记忆层是独立域，不进 document 域**。判断依据见 §3。核心一条：记忆是 **per-user 派生内容**（D4 owner-独享），与 document 域「共享 + 节点级合并（同节点才冲突）」语义不兼容；混进 document record 会让两用户的记忆互相覆盖。
2. **记忆内容 = user 域用户数据**（per-user KV + LWW，不进 CRDT，对齐 platform §13.1 user 域）；**记忆接缝索引 = 可重建元数据**（kernel-dualtrack-contract §4.5 已埋位：从画布/聊天节点序列重算，不依赖 new 专属状态机）。
3. **挂接点不新建总线**。记忆层读 document+chat 变更走 DocKernel/SessionStore 读面 + 未来 command 流（T2.3 CanvasCommand，platform §6 称其为「未来协作同步单元」）；写走 `/api/user-state` 的 `memory:` 命名空间或独立 `/api/memory` 路由（N3 拍）。
4. **本阶段不做任何实现**：不新增 scope、不新增 namespace、不新增路由、不新增 record 类型、不接线 DocKernel。只在本文件指出天然挂接点的 file:line。

---

## 1. 记忆层在目标架构中的挂接点

### 1.1 架构定位（分层内核 + 四总线，platform §2/§3）

记忆层 **不是第五条总线**，也 **不是新插件**。它是 L2 编排层的一个**派生消费者 + per-user 写入器**：

- **读方向**：订阅 document 域 + chat collection 的变更，派生记忆（摘要/偏好/负反馈）。
- **写方向**：把派生结果写入 user 域（per-user KV），供同账号跨设备复用。
- **不进 L1 内核**：记忆不是文档真相源；L1 DocKernel（`src/kernel/docKernel.ts:20`）只持 nodes/edges/anchors + 画布元，不含记忆字段（record-schema §0 已钉 K40 字段清单无记忆项）。

四总线（platform §3：节点类型 / 能力 / 资产源 / skill）里记忆层**不向任何总线注册插件**。它消费的是内核写事件，不是总线插槽。

### 1.2 读哪些总线事件（其实是内核写事件，非总线）

记忆层关心的「事件源」与对应挂接点：

| 事件源 | 语义 | 天然挂接点（file:line，仅引用） | 当前是否有订阅口 |
|---|---|---|---|
| 节点 upsert/delete | 图片生成完成（generation 落字段 record-schema §3.7）、节点属性变更 | `src/kernel/docKernel.ts:86`（upsertNode）、`:93`（deleteNode）、`:128`（upsertAnchor） | ❌ 无事件发射；DocKernel 是同步 CRUD 面，无 observer/subscribe。**接缝=未来在写面加订阅口或改读 command 流**（见 §1.4） |
| 边 upsert/delete | 血缘关系变更（生成链路 sourceNodeId→result） | `src/kernel/docKernel.ts:107`（upsertEdge） | ❌ 同上 |
| chat 消息 append | 提示词/对话流（记忆的核心原料） | `server/routes/canvas.ts:537`（POST /api/canvas/:id/chat append）+ chat-message record（`:348` validType 含 'chat-message'） | ❌ 无事件发射；chat 走 PersistBackend 直写 |
| 选区/工具偏好 | user 域自身变更（记忆层不消费，但与个人级记忆同域） | `src/kernel/sessionStore.ts:14`（SessionStore.setSelection） | ❌ 同上 |

**结论**：现有代码无任何「总线订阅口 / 内核事件总线」。记忆层 N3 实施时，读面接缝有两种选择（N3 拍，见 §6 决策清单 D-mem-3）：
- **方案 A（轮询/快照差分）**：定期读 DocKernel `listNodes/listEdges/listAnchors`（`src/kernel/docKernel.ts:98/119/140`）+ chat listByCanvas（`server/routes/canvas.ts:513` GET .../chat），与记忆接缝索引比对算增量。零内核改动，但延迟取决于轮询周期。
- **方案 B（command 流订阅）**：订阅 T2.3 的 `CanvasCommand` JSON union（kernel-dualtrack-contract §6 new 出口）。command 是可序列化、可发服务端、CRDT 可映射的写意图流——platform §6 明确「command 就是未来的协作同步单元」。记忆层消费 command 流 = 天然事件源，且与未来协作复用同一通道。**推荐方向**（与 §6 D-mem-3 一致），但依赖 T2.3 先落地。

### 1.3 写到哪个域

**写到 user 域（per-user KV + LWW，不进 CRDT）**，不写 document 域。依据见 §3。

user 域现有承载：platform §13.1 user 域 = 「跨设备同步、按人隔离：简单 KV + LWW，不进 CRDT」；服务端接口 `/api/user-state`（`server/routes/userState.ts`，T1.3 前置已落地，per-owner KV 永不 share）。记忆内容落 user 域 = 与选区/相机/偏好同域同机制，零新基础设施。

### 1.4 与 chat collection（DP-6）的关系

DP-6（plan §3、record-schema §5）：**chat 随文档域走 `/api/canvas` 子资源（messagesByScene 键随 canvas 生命周期），独立集合存储，级联语义见 FX-7**。落地形态（已实证）：
- 服务端：`server/routes/canvas.ts:510-513`（GET .../chat per-canvas messages collection）+ `:537`（POST append）+ `:100` collectionLive 校验；chat-collection record + chat-message record 走 PersistBackend（`server/routes/canvas.ts:348` validType 含 'chat-message'）。
- 客户端：`src/store/chatStore.ts:86` messagesByScene 键 = sceneId = canvasId。

**记忆层与 chat 的关系**：
1. chat 是记忆的**原料**（提示词 + 生成结果 + 负反馈 rerun 信号 D1）。记忆层读 chat collection 派生记忆，**单向只读**，不回写 chat。
2. chat 在 **document 域**（~~per-canvas 共享，随画布分享对成员可见~~ → **DP-6R：per-actor 私有**（ownerId=actor），不随画布分享、成员互不可见；chat-collection 仅 per-canvas liveness under canvas owner；platform §13.5 已订正）；记忆在 **user 域**（per-user 独享，D4 owner-独享）。**两者不同域**——chat 是 per-actor 对话流，记忆是个人派生缓存。
3. **不混淆**：chat 消息本身不是记忆；记忆是对 chat + document 的派生摘要。unknowns-map D5 已倾向「mivo 简报为唯一权威、桥接注入 maker 会话，maker 侧只作工作缓存不回流」——同理，记忆是 mivo 侧派生的个人缓存，不污染共享 chat。

---

## 2. 数据归属与权限接缝

### 2.1 per-user? per-project? per-canvas? per-image?（四层记忆）

据 `docs/plan/agent-composer-unknowns-map.md`（in-flight）的自我画像段「配套图片/画布/项目/个人四层记忆」+ D1/D4 决策，记忆有四个层级，**全部 per-user**：

| 层级 | 归属粒度 | 依据 | 落法（N3 拍，本文件只钉归属） |
|---|---|---|---|
| 图片级 | per-user × per-node | D1「rerun 即对上一张的负反馈，静默记入图片级记忆」 | user 域 KV，键含 canvasId+nodeId |
| 画布级 | per-user × per-canvas | 锚点对话上下文（anchor dialogue，产品范式核心） | user 域 KV，键含 canvasId |
| 项目级 | per-user × per-project | D4「项目简报 v1 随项目走、owner 独享」 | user 域 KV，键含 projectId |
| 个人级 | per-user（跨项目） | 工具偏好/风格偏好（与现有 pref: namespace 同语义） | user 域 KV，跨项目 |

**统一约束**：四层皆 per-user，落 user 域。层级差异仅体现在 key namespace，不体现在 scope。

### 2.2 与 T1.4 权限层（owner/editor/viewer）的交互假设

T1.4 权限层（plan §4 T1.4 行 + platform §13.5）：`project_members(projectId, userId, role=owner/editor/viewer)` + `share_links(token, projectId, permission=view/edit)`；校验点全在 BFF 中间件。

记忆层与权限层的交互假设（N3 确认，本文件钉约束）：

1. **记忆永随 owner，不随成员 role 流转**。D4 已拍「项目简报 v1 随项目走、owner 独享，与现有 owner 隔离一致，零权限系统」。即：editor/viewer 对 owner 的记忆**不可见、不可编辑**。记忆不是协作共享物，是 owner 个人增效缓存。
2. **记忆写入只认 owner 身份**。走 `/api/user-state` 的 per-owner KV 语义（`server/routes/userState.ts` resolveActor + canAccessUserState：per-owner KV 永不 share，未授权 404）——记忆复用此语义，零新权限模型。
3. **记忆读取不影响 editor/viewer 的画布操作**。editor 改画布 → 触发 document 域变更 → owner 的记忆派生（若 owner 在线）更新；editor 自己的记忆是 editor 自己的 per-user KV。**每个用户各有一份记忆**，互不污染。
4. **未来「共享简报」是升级点，非本阶段**。unknowns-map D4 明确「项目共享功能上线时再升级权限模型」——届时共享记忆可能进 document 域或新 shared scope（见 §3 末尾 + §6 D-mem-6）。

**权限接缝的硬约束**：记忆层不得发明第二套身份（对齐 platform §13.5「人的标识一律用 maker user id，不发明第二套身份」）；记忆 KV 的 owner 隔离复用 `/api/user-state` 既有 owner seam（`server/routes/userState.ts` resolveActor），不另起 authz 路径。

---

## 3. CRDT-ready 兼容约束

### 3.1 判断：记忆层不进 document 域 → 不触发 T1.2a record schema 映射纪律

T1.2a record schema（`docs/decisions/record-schema.md`）的 CRDT 映射纪律只约束 **document 域 record**（NodeRecord/EdgeRecord/AnchorRecord + chat collection）：每 record 独立 id+revision、字段级 Y.Map/Y.Array 映射、节点级合并（同节点才冲突）。

记忆层 **不入 document 域**，故 **不触发** T1.2a 映射纪律。记忆走 user 域 = platform §13.1 「简单 KV + LWW，不进 CRDT」——与选区（DP-1，已迁 session/user 域，record-schema §4.1）、相机/偏好同机制。

### 3.2 不进 document 域的判断依据（四条）

1. **per-user 隔离 vs 共享节点级合并不兼容**。document 域的合并语义是「每 record 带 revision，服务端按节点粒度 merge，同节点才冲突」（platform §13.5 A2）。若把 per-user 记忆塞进 document record，两用户对同一节点/画布的记忆会在同节点冲突 → 一方覆盖另一方，违反 D4 owner-独享。
2. **派生内容 ≠ 源文档内容**。记忆是对 document+chat 的派生摘要（rerun 负反馈、项目简报、偏好），不是画布真相源。L1 DocKernel 是「唯一文档真相源」（`src/kernel/docKernel.ts:14`），记忆不是文档的一部分。
3. **kernel-dualtrack-contract §4.5 已埋位**。§4.5 new-only 字段分类表明列「记忆接缝索引（memory seam index）」= **可重建元数据**，重建语义「从 legacy canonical 的画布/聊天节点序列重算接缝；不依赖 new 专属状态」。即：连「哪些 record 已纳入记忆」这个索引都是可重建的派生元数据，更不用说记忆内容本身——记忆不是 new-only 用户数据。
4. **platform §13.1 四 scope 无记忆位**。四 scope（document/user/session/presence）里记忆天然落 user（per-user、跨设备、LWW、不进 CRDT）；硬塞 document 会破坏四 scope 分层。

### 3.3 若未来记忆需「跨用户共享」的 CRDT 约束（升级点，非本阶段）

仅当 unknowns-map D4 提到的「项目共享功能上线」时，可能出现**共享记忆**（如团队级项目简报，成员可见）。届时该共享记忆**若**落 document 域或新 shared scope，**必须**满足 T1.2a 映射纪律：
- 每条记忆 record 独立 id + revision（platform §13.5 硬约束）；
- 字段扁平、可无损映射 Y.Map/Y.Array（record-schema §1：无嵌套大 JSON blob）；
- 有序集合（如多轮偏好历史）= Y.Array<Y.Map>，元素按 id 合并保序；
- scope 标注进 PersistScope（见 §4 挂接点）。

**本阶段显式不做此升级**（§5 非目标 N-goal-3）。

### 3.4 与 kernel 双轨（?kernel=new|legacy）的兼容

记忆层实施时若处 kernel C 阶段（new 写 canonical），记忆接缝索引属「可重建元数据」（kernel-dualtrack-contract §4.5），遵守：
- **回退（C→legacy）不丢**：记忆内容（user 域 KV）是用户数据，在 legacy canonical 可表达，down-migrate 不丢（§4.5 用户数据行）；
- **接缝索引重算**：up-migrate 时从 legacy 画布/聊天序列重算接缝，不从 ckpt 抄（§4.5 可重建元数据行 + §4.4 冲突规则）；
- **不引入 new-only 用户数据**：记忆层禁止引入「只有 new canonical 才存、legacy 无法表达且无法重算」的字段（§4.5 硬禁止行）。

---

## 4. 接缝代码占位（天然挂接点 file:line，不新增代码）

**本节不写实现**。只指出 N3 实施时天然的挂接点——现有代码里已存在的接缝位置，N3 在此扩展，不另起架构。

### 4.1 scope 类型挂接点（若 N3 选独立 scope）

`shared/persist-contract.ts:34`：
```ts
export type PersistScope = 'document' | 'user'
```
天然挂接点：若 N3 决定记忆是独立 scope（而非骑 user 域 namespace），在此加 `'memory'`。**但本文件判断（§3）记忆属 user 域语义，推荐骑 namespace 不加 scope**——加 scope 是 D-mem-1 的可选项之一，非推荐。

### 4.2 user-state 写入挂接点（推荐落法，但需扩展 frozen 正则）

`shared/persist-contract.ts:278-289` 的 `USER_STATE_KEY_FROZEN`（精确正则数组）+ `:293` `isUserStateKeyNamespaceAllowed`（实际 = `frozen.some(re.test(key))`，**非 prefix 匹配**）：
```ts
export const USER_STATE_KEY_FROZEN = [
  /^canvas:[^:]+:selection$/, /^canvas:[^:]+:camera$/, /^canvas:[^:]+:chat-draft$/,
  /^recent:projects$/, /^recent:canvases$/,
  /^pref:tool$/, /^pref:brush$/, /^pref:stamp$/,
  /^panel:[^:]+$/,
] as const
```
> 注意：`:291` 的 `USER_STATE_KEY_NAMESPACES = ['canvas:', 'recent:', 'pref:', 'panel:']` 只是**兼容旧 API 的粗粒度前缀清单**，源码注释明写「N6 frozen regex 是真校验」——**路由实际按 frozen 精确正则拒非法 key**。

天然挂接点：N3 骑 user 域落记忆时，**不能只加 `memory:` prefix**——`memory:canvas:c1` 不匹配任何 frozen 正则会被路由 400 `forbidden-key` 拒。必须**为四类 memory key 形状各加一条精确正则到 `USER_STATE_KEY_FROZEN`**（如 `/^memory:image:[^:]+:[^:]+$/`、`/^memory:canvas:[^:]+$/`、`/^memory:project:[^:]+$/`、`/^memory:personal:[^:]+$/`，最终形状由 D-mem-2 拍）+ 在 `:303` `userStateNamespaceKind` 为每类 key 加 value kind 分派（类比 `canvas:...:selection → 'string-array'`）。这是**扩展 frozen 校验表，不是零新基础设施**——复用的是 frozen 校验机制本身（路由 owner seam / 幂等 / If-Match / 敏感字段扫描仍零新代码），但 regex + kind dispatch 必须显式扩展。

`server/routes/userState.ts`（/api/user-state 路由）：per-owner KV 永不 share + resolveActor owner seam + 幂等 + If-Match + 敏感字段扫描全已落地（文件头注释 N1-N10）。记忆 KV 复用此路由的 authz/幂等/敏感扫描路径 = 零新 authz/幂等/校验代码；**唯独 frozen key 正则 + value kind 分派要扩展**（见上）。

### 4.3 内核读面挂接点（派生记忆的原料源）

- document 域读：`src/kernel/docKernel.ts:20`（DocKernel interface）+ `:82/98`（getNode/listNodes）+ `:103/119`（edge）+ `:124/140`（anchor）。记忆层派生「画布级/图片级记忆」读此面。
- chat collection 读：`server/routes/canvas.ts:513`（GET /api/canvas/:id/chat）+ `server/routes/canvas.ts:348`（chat-message record 类型）。记忆层派生「对话级记忆」读此面。
- user/session 域读：`src/kernel/sessionStore.ts:14`（SessionStore）。记忆层不读此面（同域，无派生关系），但个人级记忆与选区/偏好同域共存。

**注意**：以上读面是同步 CRUD 面，**无事件订阅口**。N3 若要事件驱动，需在 DocKernel 写面（`:86/107/128` upsert*）加 observer，或改读 command 流（§1.2 方案 B + §6 D-mem-3）。

### 4.4 persist 三域拆分挂接点（若记忆需独立 persist key）

`src/kernel/docKernelPersistAdapter.ts:20-21`：
```ts
const documentKey = (name: string): string => `${namespacedKey(name)}:document`
const sessionKey = (name: string): string => `${namespacedKey(name)}:session`
```
+ `:67` projectToThreeDomain 拆 document/session。天然挂接点：若 N3 把记忆独立 persist key（而非骑 user-state），在此加 `memoryKey` + projectToThreeDomain 扩为四域。**但推荐骑 /api/user-state（§4.2），不本地 persist**——记忆是服务端真相的 user 域数据，本地 IDB 仅作离线缓存（与 selection 同级）。

### 4.5 command 出口挂接点（事件驱动接缝）

kernel-dualtrack-contract §6：new 出口 = `CanvasCommand` JSON union（T2.3 实施，可序列化、可发服务端、CRDT 可映射）。记忆层若走 command 流订阅（§1.2 方案 B），挂接点在 T2.3 落地后的 command 调度出口。**当前 T2.3 未实施**（plan §4 P2 T2.3 行），此挂接点为 future seam。

---

## 5. 显式非目标（本阶段不做什么）

| # | 非目标 | 理由 |
|---|------|------|
| N-goal-1 | 不新增 `memory` scope / namespace / 路由 / record 类型 | T2.4 = 接缝文档化，验收=本文件存在且接缝清楚，非实现 |
| N-goal-2 | 不接线 DocKernel / SessionStore / chatStore 任何读订阅 | 记忆层 N3 才实施；T2.4 不动任何代码（双轨默认 legacy 生产无感，kernel-dualtrack-contract §8） |
| N-goal-3 | 不做共享/协作级记忆 | D4 明确共享功能上线时再升级权限模型；本阶段记忆 owner-独享，不碰 CRDT（§3.3） |
| N-goal-4 | 不定 MemoryRecord 字段级 schema | 字段级 schema 随 N3 拍（类比 record-schema §5 chat「不在本文件展开到字段级，指向 T1.3」的处理）；本文件只钉归属（user 域）+ 键语义（memory: namespace 四层前缀） |
| N-goal-5 | 不实现 maker agent_memory 桥接 | unknowns-map D5「深水道设计期终审」+ D6「A 先行」——maker 桥接是深水道（N3 之后），本阶段只记可借鉴点（§7） |
| N-goal-6 | 不引入 new-only 用户数据字段 | kernel-dualtrack-contract §4.5 硬禁止——记忆内容是 user 域用户数据（legacy 可表达），接缝索引是可重建元数据，两者都不得违反 §4.5 |

---

## 6. N3 实施时要拍的决策清单

N3（「AI Agent 记忆，借鉴 maker agent_memory」，plan §4 下一批）动手前，逐项拍板。每项含：决策点 / 选项 / 本文件倾向 / 依据。

| # | 决策点 | 选项 | 倾向 | 依据 |
|---|------|------|------|------|
| D-mem-1 | 记忆落 scope | (a) 骑 user 域 `memory:` namespace (b) 新增 `PersistScope='memory'` 独立 scope (c) 新建 `/api/memory` 路由+独立表 | **(a)** | §3 判断记忆=user 域语义；复用 `/api/user-state` 的 authz/幂等/敏感扫描（§4.2，零新基础设施），**但 frozen key 正则 + value kind 分派必须显式扩展**（`USER_STATE_KEY_FROZEN` 精确正则，非 prefix）；(b)(c) 是 over-engineering 除非共享记忆立项 |
| D-mem-2 | 四层记忆的 key 形状 | (a) `memory:image:<canvasId>:<nodeId>` / `memory:canvas:<canvasId>` / `memory:project:<projectId>` / `memory:personal:<key>` (b) 拆四个 namespace | **(a)** | 单一 `memory:` prefix + 二级前缀分层；**四种 key 形状均需在 `USER_STATE_KEY_FROZEN` 中配置精确正则（非 prefix），并在 `userStateNamespaceKind` 中分派 value kind**（§4.2）；拆四 namespace 增加冻结面 |
| D-mem-3 | 读面接缝：事件驱动 vs 轮询 | (a) 轮询 DocKernel+chat list 比对接缝索引 (b) 订阅 T2.3 CanvasCommand 流 (c) DocKernel 写面加 observer | **(b) 优先，(a) 过渡** | platform §6「command=未来协作同步单元」；T2.3 落地前用 (a) 过渡；(c) 改内核写面，与「内核只 command/投影两方向」解耦原则（platform §2）摩擦大 |
| D-mem-4 | 记忆接缝索引存哪 | (a) user 域 KV（`memory:seam:<canvasId>` 存最后处理到的 record revision/序号）(b) new-only 状态机 | **(a)** | kernel-dualtrack-contract §4.5 已定「记忆接缝索引=可重建元数据，从画布/聊天序列重算，不依赖 new 专属状态」→ (b) 违反 §4.5 硬禁止 |
| D-mem-5 | 图片级负反馈（rerun）语义 | (a) per-user-per-node KV (b) 共享进 document 域 node.generation | **(a)** | D1「静默记入图片级记忆」+ D4 owner-独享；(b) 会让两用户的 rerun 负反馈在同节点冲突 |
| D-mem-6 | 共享/团队级记忆（未来升级点） | (a) 不做 (b) 进 document 域 (c) 新 shared scope | **(a) 本阶段不做** | D4「项目共享功能上线时再升级」；若未来做 (b)/(c)，必须满足 T1.2a 映射纪律（§3.3） |
| D-mem-7 | maker agent_memory 桥接方向 | (a) mivo 简报为唯一权威，桥接注入 maker 会话，maker 侧只作工作缓存不回流 (b) 双写回流 | **(a)** | unknowns-map D5 倾向 (a)；与 §1.4 chat↔记忆「单向只读不回写」同构 |
| D-mem-8 | 记忆持久化过渡形态（T1.3 在途风险） | (a) localStorage 过渡（按 MemoryRecord schema 写，仅换存储适配器）(b) 等 T1.3 合并后直接服务端 | **(a) 过渡** | unknowns-map C7「T1.3 在途（#194 13 条 blocking），记忆持久化需 localStorage 过渡形态，按 MemoryRecord schema 写仅换存储适配器」；N3 动手时确认 T1.3 是否已合 |
| D-mem-9 | 记忆内容 vs 索引的 persist 边界 | (a) 内容=user 域 KV（用户数据，down-migrate 不丢）；索引=可重建元数据（up-migrate 重算）(b) 两者同存 user 域 KV 不区分 | **(a)** | kernel-dualtrack-contract §4.4/§4.5 冲突规则：用户数据以 canonical 为准、元数据可重建者重算不抄 ckpt——内容与索引必须分清 |

---

## 7. maker agent_memory 可借鉴点（据 unknowns-map 蒸馏，N3 终审）

> 来源：`docs/plan/agent-composer-unknowns-map.md`（in-flight，未合入 main）+ memory project_project_mivocanvas_agent_composer_design。maker agent_memory 源码不在本仓，以下为同批调研已蒸馏结论，N3 终审时以 maker 实仓为准。

| 借鉴点 | maker 机制（蒸馏） | mivo 借法 / 不借法 |
|---|---|---|
| 队列持久化防丢四件套 | maker `agent_input_queue_snapshots` 持久化队列表 + `wake_kind=queued` + clientId 幂等 + 断点续接 + 软删可恢复 | 借防丢四件套语义（与 FX-5 写失败重试队列同构），不借 maker 的 Express+Prisma+OSS 链路（platform §4 已定 mivo 用 Hono+IDB/PG，不引入 OSS/Prisma） |
| per-workdir Memory | maker per-workdir Memory（工作缓存） | D5 倾向 mivo 简报为唯一权威、maker 侧只作工作缓存不回流（§6 D-mem-7）；借「工作缓存」定位，不借「回流」 |
| agent_memory schema | （未直读源码，N3 终审） | N3 直读 maker asar/源码确认 MemoryRecord schema，对齐字段名以便桥接注入（D-mem-8 过渡形态需按 MemoryRecord schema 写） |
| 桥接注入 | unknowns-map B1：maker webview preload 注入（`exposeInMainWorld("makerBridge")`） | 深水道（D6 路线 A/B），非 N3 范围；记忆层 N3 只做 mivo 侧派生+存储，桥接是 N3 之后 |

**不借**：tldraw sync（权威服务器模型，与 Yjs 路线冲突，record-schema §13.3 已否决）、maker SkillHub 市场（绑死 Express+Prisma+OSS+Electron IPC，platform §4 已定搬不过来）。

---

## 8. 验收（本任务 = 接缝文档化）

- [x] `docs/decisions/memory-layer-seam.md` 存在。
- [x] 挂接点写清（§1 读哪些事件、§1.3 写哪个域、§1.4 与 chat collection 关系）。
- [x] 数据归属与权限接缝写清（§2 四层归属 + §2.2 与 T1.4 权限层交互假设）。
- [x] CRDT-ready 兼容约束写清（§3 判断独立域 + 依据 + §3.3 若入文档域的映射纪律 + §3.4 双轨兼容）。
- [x] 显式非目标（§5）+ N3 决策清单（§6）+ maker 可借鉴点（§7）。
- [x] 接缝代码占位用 file:line 引用天然挂接点（§4.1-4.5），**不新增代码**。
- [x] 不动任何源码（纯文档 PR，diff = 本文件一文件）。
