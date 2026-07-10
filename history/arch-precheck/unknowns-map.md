# 架构设计预检 · 未知数地图（2026-07-08）

> 对象：`docs/decisions/platform-architecture-2026-07-07.md`（§1-13）
> 方法：文档断言 vs 代码领土逐条对照（已读码核证的标 ✅ 证据）
> 状态：访谈进行中，一次一问。答案写回本文件并同步修订决策文档。

## A. 架构级未知数（答案会改变 schema/API，禁止默认值）

### A1. 画布的归属与共享模型 【已答 ✅ 2026-07-08，owner 二次澄清后定稿】
**最终模型：个人项目 + 项目级邀请/链接分享（Figma 式），无预定义团队实体。**
- 组织成员资格 = 有效 maker JWT（登录即组织内）；默认只看到自己建的项目；
- 分享方式两种：**邀请指定人** / **分享链接**；被分享/被邀请后，该项目出现在对方的项目列表里；
- 不分享 = 纯私有。编辑冲突按 A2 的节点级合并。
- schema 形态：`project.ownerId` + `project_members(projectId, userId, role)` + `share_links(token, projectId, permission)`——全部用 maker user id 作人的标识，不发明第二套身份。
- ~~A1b 团队来源~~：**已消解**——无团队实体，无需组织架构映射，零 maker 跨仓改动。
- ~~A1c 个人空间~~：**已消解**——个人即默认，共享是邀请的结果。

### A1d. 分享的权限档位 【访谈第 3 问】
邀请成员默认可编辑（A2 节点级合并服务于此）。**链接分享**进来的人是只读、可编辑、还是 owner 建链接时二选一？被邀请人能否再邀请他人（转授权）？
- 影响：share_links 表要不要 permission 字段、成员表要不要 role 分级（owner/editor/viewer）、以及"链接+组织内"是否等于半公开的安全口径。
- **答案 ✅（2026-07-08）：c) owner 建链接时选只读/可编辑 + 仅 owner 可邀请（第一版关死转授权）。**
- 落地含义：share_links 带 permission 字段；成员 role 三档 owner/editor/viewer；邀请操作 owner-only 校验在 BFF 层强制。

### A4. 共享画布上的 chat 消息可见性 【已答 ✅ 2026-07-08】
**答案：b) 对话跟画布走**——共享画布的对话/提示词历史对所有成员可见，按画布维度存（per scene，非 per user-scene）。
- chat collection 归属：project/canvas 维度，随画布一起分享，进 document scope。
- 已知取舍（owner 接受）：提示词草稿对成员公开；未来若需隐私，加"私有/发布到画布日志"标记即可，schema 不推翻（a←可加，非拆）。

### A2. 团队并发编辑的冲突语义 【访谈第 2 问，A1=c 后已升级】
A1 选了团队可编辑，冲突场景从"同一人两设备"升级为"两个设计师同画布"，整文档 LWW 基本不可接受（互相无声覆盖对方工作）。三个候选：
- a) 整文档 revision + 冲突提示（保存撞版本 → "同事已改，刷新/覆盖/另存"）——最简，但同画布并行编辑体验差、覆盖选项危险；
- b) record 级合并（服务端按节点粒度合并：你改节点 A 我改节点 B 都保留，同节点才冲突）——团队体验好；代价：M1 records 要 per-record revision 字段，P4c 服务端要 merge 逻辑（= CRDT-lite 提前一部分）；
- c) 画布级编辑锁（同一时间一人可编辑，他人只读 + "XX 正在编辑"标识）——实现最省，牺牲并行，但与"非实时"定位自洽。
- **答案 ✅（2026-07-08）：b) 节点级合并**。
- 落地含义（进 M1/P4c 计划的硬要求）：① record schema 每节点带 revision 字段（spike 必含）；② P4c 服务端有节点粒度 merge 逻辑，同节点冲突才提示；③ 与 CRDT-ready 字段级改造同向复用。

### A3. Eagle/本地素材在 web 部署形态下断链 ✅ 已核证
BFF 的 Eagle 代理读 `MIVO_EAGLE_API_URL`（服务端 env，默认 127.0.0.1:41595）——**部署到服务器后，这指向服务器自己，不是设计师本机的 Eagle**。生产默认也是关的。即：当前 Eagle/本地目录素材库只在本机 dev 拓扑成立，服务端化后此功能对 web 用户不存在。
- **答案 ✅（2026-07-08）：c) 资产源总线第一版只抽象服务端源；Eagle/本地目录明确标 deferred（需要时再扩总线支持"客户端本地源"这一类）。**
- 落地含义：AssetSource 接口第一版不为"源运行在客户端"预留抽象；Eagle/local 现有 dev 代码保留但不进 web 生产资产链路；P4/Figma/Unity 未来都走服务端侧对接。

## B. 设计级缺口（工程可解，但 spike/计划必须覆盖，不可默认跳过）

### B1. "属性扁平"与 V2 嵌套字段的粒度矛盾 ✅ 已核证
`mivoCanvas.ts:260-267`：transform/fills[]/strokes[]/effects[]/layout/constraints/asset/relations 全是嵌套对象/数组，另有 aiWorkflow、markupPoints[]。CRDT spike 验收写"属性扁平、无嵌套大 JSON"——字面上现有结构就不满足。
- 需要 spike 明确粒度规则：哪些嵌套对象作为"原子值整体替换"（如 transform 一次拖拽整体变）、哪些必须字段级（如 fills 数组条目）。tldraw 的做法（record 属性浅层、复杂值原子替换）可直接对照。
- 风险：不定粒度规则，"无损映射 Y.Map"验收会被各自解读。

### B2. command 可序列化 vs Blob 载荷 ✅ 已核证
导入链路（canvasAssetImport.ts）与生成结果落地携带 File/Blob。command 若要可序列化，必须定"两阶段协议"：先资产入库拿 assetId，command 只引用 id。
- 现有 `mivo-asset:` 伪 URL 机制是好基础，但 commitGenerationResult 等路径需显式改写为两阶段。spike/M1 计划要有这一条，否则 command 序列化做到一半卡在 Blob 上。

### B3. chat 消息 ↔ 画布节点跨 collection 引用 ✅ 已核证
chatStore 消息持 resultNodeIds/nodeIds 指向画布节点。两个 collection 若分开同步/分开迁移，引用悬空怎么处理（节点删了消息还指着；消息 trim 了节点的来源断了）？
- 需要定：引用是"弱引用可悬空（UI 兜底显示）"还是"级联维护"。建议弱引用 + UI 兜底，但要写成契约。

### B4. 版本偏斜：长活标签页 × 每分钟自动部署
设计师挂一整天的旧版本 tab，往新版本服务端写旧 schema record。record 级 migrations 解决"读旧"，但"旧客户端写回"要不要拒绝/强制刷新？
- 需要一个版本协商策略（schema version header + 服务端拒写 + 前端提示刷新，或静默升格）。不定的话第一次 schema 演进就撞。

### B5. 服务端资产的 GC 与配额
assetId 被多画布引用（复制节点、跨画布粘贴），服务端删画布时资产删不删？引用计数还是永不删 + 配额？P4b 计划需要一节。

### B6. DocKernel 替换后的性能路径
R01 拖拽快速路径、per-node memo 都绑在现有 store 订阅形态上。DocKernel 换订阅路径后 20k 基线要重跑。已有基准协议 ✅，只需把"每步出 before/after"写进 M1 的每个 PR 验收（§12-4 已有原则，落到 PR 级）。

## C. 已覆盖 / 无需再问（预检确认无缺口）

- M0 双硬前置（auth 合入、prod 改动清零）——已在 §10。
- undo per 设备、选区不同步——已显式决策并可逆。
- user-state KV 的 LWW 冲突语义——同用户多 tab 相机互踩，体感问题非架构问题，观察即可。
- skill 沙箱单独立项——已标。
- tldraw sync 不借用——已论证。

## 访谈记录（架构级 A 类已干涸，2026-07-08 收口）

| # | 问题 | 答案 |
|---|------|------|
| 1 | A1 画布归属与共享模型 | Figma 式：个人项目 + 邀请/链接分享，无预定义团队实体 |
| 2 | A2 并发编辑冲突语义 | b) 节点级合并（每 record 带 revision，服务端节点粒度 merge） |
| 3 | A1d 分享权限档 | c) 链接 owner 选只读/可编辑 + 仅 owner 可邀请（关死转授权） |
| 4 | A4 共享画布对话可见性 | b) 对话跟画布走，成员可见，per-canvas 存 |
| 5 | A3 本机资产源（Eagle/local） | c) 总线只抽象服务端源，本机源 deferred |

连续一轮无新架构级未知数 → 访谈干涸，收口。B 类设计缺口转入 spike/计划（非用户决策项）。

## 决策对 schema/接口的净影响（供决策文档 §13 更新）

- **归属层**：`projects(id, ownerId)` + `project_members(projectId, userId, role: owner|editor|viewer)` + `share_links(token, projectId, permission: view|edit)`；人的标识一律 maker user id。
- **document 层**：每个 record（node/edge/anchor）带 `revision` 字段（节点级合并前提，且与 CRDT-ready 字段级改造同向）。
- **chat**：per-canvas collection，随画布分享进 document scope。
- **user scope**：不变（§13.1）。
- **资产源总线**：接口第一版仅服务端源，不为客户端本地源预留抽象。
- **权限校验点**：BFF 层——邀请 owner-only、链接 permission、成员 role 三档，都在 `/api/canvas` `/api/projects` 中间件强制。
