# MivoCanvas 平台架构决策记录（2026-07-07）

> 状态：**正式**。§6 CRDT-ready 已由 owner 拍板（2026-07-07：肯定做）。
> 定位：这是 MivoCanvas 从"产品化 demo"走向"可多人共建的设计平台"的架构真相源。后续每个愿景的执行计划挂在本文件之下，不另立第二真相源。
> 上游依据：`docs/plan/productization-roadmap.md`（四层架构 L1-L4 + D1-D10）、`docs/mivo-system-inventory.md`（mivoserver 能力盘点）、`history/maker-arch-probe/skillhub-and-theme.md`（maker skillhub/主题架构，glm-5.2 调研，含 file:line 证据）、`history/auth-probe/05-synthesis.md`（鉴权拍板 A2+B1）。

---

## 1. 决策：选"分层内核 + 插件总线"平台型架构

在三个候选里选 **C**：

| 候选 | 本质 | 判定 |
|------|------|------|
| A. 套壳 maker / 塞进 mivoserver | mivo 变薄前端，逻辑进别人的仓 | ❌ 作为架构底座不可——画布文档模型（含 figma 级设计原语）必须 mivo 自持；跨仓改内核=零 CI 保护、迭代归零。套壳只作**产品形态**（§5），不作架构 |
| B. 自给自足单体 | 什么都自己做 | ❌ 重复造 maker 的身份/skill/资产轮子，飞轮转不起来 |
| **C. 分层内核 + 插件总线** | 稳定内核 + 统一插槽 + BFF 契约层借外部能力 | ✅ 内核自持保设计能力；外部能力借 maker/mivoserver；插件化让多人各认领一个插件独立贡献 |

**选它的三条硬理由**：① 内核自持 → figma 级设计能力有地方长；② 插件总线 + 契约测试 → 模块解耦、多人可并行贡献；③ 外部能力走 BFF 契约 → 接 maker/mivoserver/P4/figma 时前端零改动，不拖累"每分钟自动部署"的迭代速度。

---

## 2. 分层（纵向）

```
L4 交互/渲染层(薄)   Leafer 画布渲染 + 输入框(mivo/maker tab) + 面板/设置
        ↕ 只读投影(projection) / 只写 command —— 唯一双向通道
L1 文档内核(真相源)   Doc = Node[] + Anchor[] + Edge[] + Version;CRDT-ready(§6)
        ↕ 四类插件总线(§3)
L2 编排层            agent 编排:读画布上下文 → 规划 → 调能力 → 写回画布
        ↕ BFF 契约(唯一对外缝,P1 已实证平移时前端零改动)
L3 能力底座          mivoserver(身份/资产/多模型/agent域) + llm-proxy + 外部系统
```

**内核解耦硬机制**（这是"多人共建不退化成多人制造耦合"的技术前提）：
- 插件对内核**只有 command / 投影两个方向**，永不直接 mutate 内核状态（推广现有 RendererAdapter 契约）。
- 每类总线一套**契约测试**：贡献者的插件过契约测试即可合入，无需理解内核实现。没有契约测试，插件化就是空话。

---

## 3. 四类插件总线（横向 —— 每个愿景都是往插槽注册，不是新架构）

| 总线 | 接口契约（草案） | 现有地基 | 谁插进来 | 解耦保证 |
|------|-----------------|---------|---------|---------|
| **节点类型总线** | `NodeType{ render, hitTest, defaultSize, capabilities, serialize }` | `canvasNodeRegistry` 已有雏形 | md/pdf/视频/图 · figma 设计元素 · 未来任意节点 | 新节点只注册，不改 renderer（投影层隔离） |
| **能力总线**（生成/编辑） | `Capability{ id, inputSchema, invoke, cancel }` | BFF generate/edit/enhance | 2D 生图 · 设计辅助 · 背后切 mivoserver 20+ 模型 | 能力走 BFF 契约，前端只认 schema |
| **资产源总线** | `AssetSource{ list, search, thumbnail, importToCanvas }` | `AssetSource/AssetItem` 已有（Local/Eagle/Pinterest） | P4 · Unity · Figma · Eagle 各一个 connector | 每个 connector 独立 PR，彼此不知道对方 |
| **skill 总线** | 见 §4（借 maker StoredManifest 模型，执行交 Claude Code） | 前端 Plugins/Skills 页现为静态占位 | skillhub 上传的用户 skill | 沙箱/权限边界由执行方（Claude Code）承担 |

**形式化时机原则（owner 修正，2026-07-07）：按"第二个实现到场"再形式化，不四条一起铺。**
- **现在就补接口 + 契约测试**：节点类型总线（已有 md/图/stamp 等 2+ 实现）、资产源总线（已有 Local/Eagle 2+ 实现）——抽象已被多实现验证过，形式化是收敛不是猜测。
- **只写一页接口草案，暂不上契约测试**：能力总线（实质只有"生图"一族）、skill 总线（静态占位）——等第二个真实实现到场（如 maker tab 的 Capability 接入）再形式化。单实现时上契约就是对着一个样本猜接口，改起来测试反而成拖累。
- 理由：当前团队规模下，四套契约测试 + 全量治理机制一次全上，维护成本先于收益到来。

---

## 4. skill 总线设计（据 maker 调研定，走极简路径）

maker 调研的关键结论（`history/maker-arch-probe/skillhub-and-theme.md`）：
- **maker 自己没有 skill 执行运行时**：skill 执行完全交给 spawn 出的 Claude Code CLI 子进程，按原生机制加载 `~/.claude/skills/<name>/SKILL.md`（报告 L15）。maker 只是**市场 + 装机管理器**。
- SkillHub 市场是企业级链路（2 阶段 publish → OSS → 上游 Hub S2S 签名 + 安全扫描 + visibility 三档 + 团队作用域），但绑死 Express+Prisma+OSS+Electron IPC，**MivoCanvas（web + Hono BFF，无多租户）搬不过来**（报告 L2）。

**MivoCanvas skill 总线选型**：
1. **执行层不自建**：skill 执行交 Claude Code（复用 maker 同一模型），mivo 不写 skill runtime。
2. **本地管理层**：借鉴 maker `StoredManifest` schema + `folderHash` 校验 + `origin` 标记 + frontmatter 校验（name/description 必填，对齐 Claude Code SKILL.md spec），做本地 skill 注册表。
3. **市场层（未来）**：借鉴 2 阶段 publish + visibility 三档模型，但 BFF 用现有 Hono + IndexedDB，**不引入 OSS/Prisma/上游 Hub**。
4. **飞轮对齐**：skill manifest 格式与 maker 对齐 → skill 在 maker 创作、发布到共享 skillhub、在 mivo 画布调用（§5）。

> ⚠ skillhub 上传 = 跑不受信用户代码，是六愿景里唯一带沙箱/权限/供应链问题的层，**单独立项**，非普通功能。

---

## 5. 与 maker 的飞轮（架构落法）

产品形态（owner 补充的愿景）：画布右侧输入框上方 `mivo/maker` tab，同一输入框切换——mivo 处理图，maker 处理图以外；并考虑"mivo 套壳 maker"复用 maker 内置能力（环境部署等）。

**架构落法**（把产品形态翻译成解耦实现）：
- **tab = 编排层路由**：输入框是 L4 组件，背后 L2 按 tab 分发到不同 Capability。maker 能力通过 **BFF/能力总线**暴露成 Capability 接入——**不是 mivo 代码跑在 maker 进程里**。前者可独立迭代，后者会让两产品发布绑死。
- **飞轮的轴 = 共享身份 + 共享 skill 注册表**：身份已定走 A2（依赖 maker OAuth/JWT，`history/auth-probe/05-synthesis.md`）；skill 注册表格式与 maker 对齐（§4）。这两者放在公共底座（mivoserver），飞轮才转得起来。
- **"套壳 maker"**：作为**产品形态**成立且推荐（用户在一个壳里同时得到 mivo 画布 + maker 全家桶）；架构上实现为"maker 能力经 BFF 接入"，不是进程级套壳。

---

## 6. 【已拍板 ✅】内核数据模型现在做成 CRDT-ready（owner 2026-07-07 确认）

owner 已明确"协作肯定要做，只是不是现在"。这推导出唯一一个**现在不做功能、但现在不定就要返工**的决策：

- **选 CRDT-ready（推荐）**：L1 文档结构现在就用可合并结构，而非单个大 JSON 快照。现在仍单人 local persist，未来接入引擎无痛。成本：现在多 1 个 spike + 少量内核改造。
  **【owner 修正，2026-07-07】spike 直接对着 Yjs 的语义做，不自研 LWW 结构**——自己发明的可合并结构若与未来真正引入的引擎（Yjs/Automerge）语义对不上，预留等于白留。**spike 验收标准**：现有 Doc 结构能**无损映射到 Y.Map / Y.Array 的形状**（每节点独立 id、属性扁平、无嵌套大 JSON），而不是"我们自己定义了一套 LWW"。
- **选"以后再说"**：现在省事。代价：协作真做时，L1 + 所有存量画布迁移 + 投影层全部重写，数量级更大的返工。

**推荐选 CRDT-ready**，理由=owner 已确认协作必做，且 command 层与 undo 解耦（roadmap D7）本就在计划内，command 就是未来的协作同步单元。**此项需 owner 签字后本文件转正式。**

figma 兼容 + 协作的其余部分**现在只预留不实现**：CRDT 引擎、presence、多人光标、figma 设计原语、figma 协作级红线（roadmap 现有"不做 CRDT/实时协作"约束需在协作立项时正式解除）——均为未来 PR，架构只保证加入时不返工。

---

## 7. 主题系统（据 maker 调研定）

直接借鉴 maker 桌面端的 VSCode 风格 contribution 模型（`history/maker-arch-probe/skillhub-and-theme.md` L122-134，已核证 file:line）：
- `ColorRegistry.registerColor(id, {light, dark})` 注册 token → `ThemeService.applyTheme` 序列化成 `:root{--token:value}` 注入 `<style id="theme-vars">` → 组件用 `var(--token)` 消费。
- MivoCanvas 是 Vite+React，CSS 变量方案天然适配，**可直接移植**。
- 改进：token 分 **primitive / semantic 两层**（maker 桌面只有 semantic 一层，mivo 加 primitive 做 hex 真相源）。
- 不学 maker 移动端"两份 token 靠文档对齐"的反模式；若未来加 RN 端，抽独立 token 包。

---

## 8. 六愿景 → 总线映射（backlog，一件件来）

| 愿景 | 挂哪个总线 | 地基现状 | 相对顺序 |
|------|-----------|---------|---------|
| ⑤ 2D 生图 | 能力总线 | 现链路 + mivoserver 图像模型，最成熟 | 已在做（服务端化收口） |
| ② 多文件画板(md/pdf/视频) | 节点类型总线 | 节点类型已在 L1，pdf/video 仅静态需补渲染 | 近期 |
| ③ 内部资产库(P4/Unity/Figma/Eagle) | 资产源总线 | `AssetSource` 抽象已有，Eagle/Local 已实现 | 中期，逐个 connector |
| ④ skillhub | skill 总线 | 前端占位，执行交 CC，本地管理借 maker schema | 中后期，单独立项（沙箱） |
| ① figma 兼容(设计能力) | 节点类型总线 + 资产源总线 | 缺矢量/组件/约束设计原语，最大新层 | 后期，量级最大 |
| ⑥ maker 飞轮 | 编排层路由 + 身份/skill 底座 | 身份 A2 已定，第一根辐条 | 随 skillhub 一并 |
| （协作） | L1 CRDT + command 同步 | 现在只预留（§6） | 最后，独立立项解红线 |

---

## 9. 落地这套架构的最小启动动作

1. ~~owner 拍板 §6 CRDT-ready~~ ✅ 已拍板，本文件转正式。
2. 把四类总线的接口契约 + 契约测试骨架建起来（其中节点类型/资产源已有雏形，补齐接口 + 测试即可）——这是"让更多人贡献"的开关。
3. 其余按 §8 顺序一件件做，每件挂本文件。

---

## 10. 现有功能 → 新架构迁移映射（绞杀者模式，不是重写）

**迁移总原则**：现有代码离目标架构不远（registry 雏形、RendererAdapter、slice 门面、BFF 都已在）——迁移 = **收敛 + 补契约**，逐块把现有实现挂到形式化接口后面；每一步 main 可发布（每分钟自动部署在跑，不允许长期迁移分支），每一步带 flag/开关可回滚（renderer flag 是成功先例）。

| 现有功能/模块 | 目标位置 | 迁移动作 | 差距量级 |
|---|---|---|---|
| `documentModelV2` + `canvasDocumentModel` | L1 内核（CRDT-ready Doc） | 字段级 LWW 结构改造 + persist 大版本迁移（§12-2） | **大**，M1 主体 |
| `canvasActionModel` dispatch（1320 行） | L1 command 层 | dispatch 已统一 ✅；把 action 形式化为**可序列化 command**（CRDT-ready 第 3 条） | 中 |
| `canvasNodeRegistry` + `nodeCapabilities` | 节点类型总线 | 已是雏形 ✅；补齐 `NodeType` 接口（render/hitTest/serialize）+ 契约测试；清掉散在双轨分支里的 per-type 硬编码 | 中 |
| Leafer paint 系列 + RendererAdapter + hitTest | L4 渲染层 | 已符合投影契约 ✅；基本不动（顺手清 Spike 命名漂移 R-09） | 小 |
| `generationSlice` + `chatMaskEditFlow` + `chatEnhanceFlow` | L2 编排层 + 能力总线 | 网络编排从 store 收敛到 L2 facade（facade 雏形已有）；生成动作形式化为 `Capability` | 中 |
| BFF `server/routes/*`（generate/edit/enhance/tasks） | L3 能力底座入口 | 已是契约层 ✅；per-user key 透传（auth E1/E2 分支已实现待合） | 小 |
| `LibraryWorkspace` + `assetLibraryModel`（AssetSource） | 资产源总线 | 抽象已有 ✅；形式化 `AssetSource` 接口 + 契约测试；Local/Eagle 改挂接口后，Pinterest 占位随行 | 小-中 |
| 项目侧栏 / 设置 / 更新日志 / debug log / Inspector | L4 外围 UI | 不动 | 零 |
| Plugins/Skills 静态占位页 | skill 总线 | 全新（§4 极简路径），排最后 | 大，单独立项 |
| persist（IDB v9 + 迁移链） | L1 存储适配 | 随 M1 一次大版本迁移；迁移器/fixtures 体系已有 ✅ | 中 |

**迁移分期（每期独立可发布）**：
- **M0 保护网（两个硬前置，同级，缺一不得进 M1）**：
  ① 合入 auth E1/E2 分支（否则后续全在 rebase 地狱）；
  ② **prod 未纳管改动清零**（10.102.80.15 上"区域描述/蒙版编辑"未提交改动：抢救成分支走 PR 或显式丢弃）——每分钟自动部署 + 内网真实用户数据的前提下，线上与仓库不一致时启动 M1 persist 大迁移，出问题无法区分"迁移 bug"和"未纳管改动副作用"；
  另：CRDT-ready 结构规范 spike（验收=现有 Doc 无损映射 Y.Map/Y.Array 形状，见 §6）。
- **M1 内核收口**：Doc 结构 CRDT-ready 化（对齐 Yjs 语义）+ command 形式化 + persist 迁移。**必须在 P4c 文档服务端持久化之前**——否则服务端 schema 存旧结构，要二次迁移。
- **M2 总线契约化（按 §3 时机原则收窄）**：**节点类型、资产源**两条定接口 + 契约测试 + 现有实现挂接（两条可并行）；**能力、skill** 只交一页接口草案，不上契约测试。
- **M3 编排上移**：generation/mask/enhance 编排收敛 L2。
- **M4 服务端化**：P4b 资产 → P4c 文档（存的就是 CRDT-ready 结构，一步到位）。
- skill 总线在第二个真实实现到场后单独立项形式化。

## 11. 解耦的强制机制（多人共建的开关，全部可机器执行）

**上机制的节奏同样遵守"第二个实现到场"原则（owner 修正）**：现在只对**节点类型、资产源**两条已形式化总线上机制；能力/skill 总线的机制随其形式化时点再上。全量一次铺开的维护成本先于收益到来。

| # | 机制 | 现状 | 补什么 | 时机 |
|---|------|------|--------|------|
| 1 | **command/投影唯一双向通道**：插件/UI 永不直接 mutate 内核 | RendererAdapter 已实践 | 推广到全内核，eslint 禁 store 内部 set 的裸调用面 | M1 随内核收口 |
| 2 | **接口 + 注册表**：每总线一个契约包，插件只 import 契约包 | registry 雏形 ×2 | eslint `no-restricted-imports` 先行（轻）；dependency-cruiser 等贡献者变多再上 | M2，仅两条成熟总线 |
| 3 | **契约测试 gate**：过契约测试即可合入 | server contracts、store contract tests 已有先例 | **节点类型、资产源两套**，进 CI required check | M2 |
| 4 | **CI 结构守卫** | Structure Guard(baseline.json) + 值级循环依赖检测已在 CI | 扩展：新增总线目录的行数/依赖规则 | M2 顺带 |
| 5 | **CODEOWNERS per 总线** | 无 | 暂缓——单人主导期无意义，第二个外部贡献者到场再建 | 贡献者 ≥2 时 |
| 6 | **贡献者文档**：每总线一页"如何写一个 X 插件" | 无 | 随各总线形式化交付 | 跟随 #3 |

## 12. 迁移风险清单（含 owner 尚未提出、但必须考虑的事）

1. **每分钟自动部署 = 迁移全程不许 main 破碎**。绞杀者模式是被部署形态逼出来的硬约束，不是风格偏好；任何"迁移大分支憋两周"的做法直接否决。
2. **存量数据是真实用户数据了**（内网已多人在用）：M1 的 persist 大版本迁移必须带 dry-run + fixtures 回归 + 失败回滚;prod 用户的画布丢了无法向团队交代。
3. **auth 代码还躺在两个 worktree 未提交/未合并**（E1/E2，双审已过）——是迁移的第一顺位前置：先合它，否则 M1 改 store 结构会把这两个分支冲突到没法救。
4. **迁移期间性能门禁不许倒退**：20k pan p95 26.7ms 是已验收基线，M1 改文档结构、M3 动编排都可能碰投影路径,每期出 before/after 基准（采集协议 §12.1 已有,直接用）。
5. **双轨 DOM 渲染器加倍每一步成本**：迁移触碰渲染相关契约时双轨都要验。建议把"删双轨"的观察窗决策提前到 M2 前拍板,少拖一天少付一天双轨税。
6. **迁移和新功能并行的节奏治理**：团队还在出功能 PR（#146 在跑）,迁移 PR 一律小步 + 合并队列,每合一个其余 rebase——p0p1 债务修复的 merge queue 纪律直接沿用。
7. **服务端 schema 顺序耦合**（最容易踩的坑）：P4c 文档持久化**必须等 M1**,先上服务端再改结构 = 客户端服务端双份迁移。资产服务端化 P4b 无此依赖,可先行。
8. **prod 服务器未纳管改动清零已升级为 M0 硬前置**（见 §10 M0-②），与合并 auth 分支同级,不再是"注意事项"。
9. **命名漂移在迁移时顺手清**（R-09 Spike 命名等）:新贡献者进场靠代码自我描述,名不副实的模块会让"多人共建"从第一天就跑偏。
10. **skill 沙箱是安全立项不是功能立项**（§4 已标）,不进迁移主线。

---

## 13. 近期落地架构：模块级设计（2026-07-08，owner 已确认方向）

> 定位：§1-9 是长远方向,本节是**接下来两三个月照着干的**——目标收窄为「当前功能模块解耦 + 后端底座顺利搭建 + CRDT-ready」。参考 tldraw SDK 的 Store/record scope 模型（`history/maker-arch-probe/tldraw-sdk-eval.md`）。

> **预检回灌（2026-07-08）**：§13 的共享/归属模型经 `history/arch-precheck/unknowns-map.md` 访谈定稿，取代早期"团队空间"设想。要点见 §13.5。

### 13.1 核心切分：四层 scope（按"数据的命运"分类）

| scope | 内容 | 同步策略 |
|-------|------|---------|
| **document** | nodes/edges/anchors/画布与项目结构；chat 消息（~~per-canvas collection,随画布分享~~ → DP-6R：**per-actor 私有** collection under actor，不随画布分享；chat-collection liveness 仍 per-canvas under canvas owner） | 服务端真相 + **节点级合并**（每 record 带 revision,同节点才冲突）；CRDT-ready 字段级改造与此同向 |
| **user**（owner 修正 2026-07-08：session 需要同步 → 落成此域） | 相机 per 画布、最近打开项目/画布、工具偏好（brush/stamp 记忆）、面板开合、聊天草稿 | **跨设备同步、按人隔离**：简单 KV + LWW,不进 CRDT。服务端接口 `/api/user-state`（窄,适合作后端底座第一个接口） |
| **session**（纯瞬态） | 拖拽中间态、编辑 overlay 瞬态、在飞任务句柄 | 不同步（无跨设备语义）。默认约定：**undo 栈 per 设备**（跨设备 undo=协作级工程,推迟）;**选区不同步**（要开是 user 域加一行的事） |
| **presence** | 他人光标/选区 | 未来协作,现在零代码,留概念位 |

服务端只需理解 document records + assetId + user-state KV,session/编排/渲染不过网——这就是"底座顺利搭建"的保障。

### 13.2 目标模块与现有代码映射

| 现有模块 | 去处 | 解耦动作 |
|---------|------|---------|
| canvasStore documentSlice + documentModelV2 | **DocKernel**（唯一文档真相源） | records 扁平化：独立 id + 字段级属性,可无损映射 Y.Map/Y.Array;schema + **record 级 migrations**（现有整库版本迁移升级,服务端多版本并存必需） |
| canvasActionModel | **Command 层**（唯一写入口） | dispatch 已统一✅,补**可序列化格式**（全参数、无闭包）;undo 从快照式渐进换 command 式 |
| selectionSlice / cameraFocusStore / 编辑态 | user 域 或 session 域（按 13.1 归类） | 基本不动,明确 scope 标注 |
| generationSlice / chatMaskEditFlow / chatEnhanceFlow | **GenerationOrchestrator**（L2） | 编排不再直接 set 文档,commitGenerationResult 改发 command;在飞任务归 session |
| chatStore 消息 | document 域独立 collection | 走同一 PersistAdapter |
| assetStorage / assetUrlLease | **AssetService**（接口化） | document 只存 assetId（`mivo-asset:` 现状已符✅）;服务端化=换 resolve 实现,lease 原样 |
| persistIdbStorage | **PersistAdapter 的 IDB 实现** | 先抽接口挂现有实现（行为零变化）;P4c 写 Server 实现,双实现渐切 |
| RendererAdapter / Leafer paint / hitTest | 不动 | 投影契约已是目标形态 |
| BFF server/ | 不动 | 底座=加 auth（待合）+ /api/assets + /api/canvas + /api/user-state |

### 13.3 tldraw 借用清单（明确到点）

1. record scope 分层（→13.1 四层模型）;2. Schema + record 级 migrations;3. ShapeUtil API 面对照节点类型总线接口。**不借**：tldraw sync（权威服务器模型,与 Yjs 路线冲突）、DOM 渲染（Leafer 迁移已否决该路线）。

### 13.4 落地顺序（小步,每步 main 可发布）

1. record schema + scope 标注 spike（验收=现有 Doc 无损映射 Y.Map/Y.Array）
2. **PersistAdapter 接口先切**（IDB 挂后面行为不变）——接口一冻结,**P4b/P4c 服务端可拿接口并行开工,不等 3-5**
3. 字段级更新改造（消灭整节点替换,可按节点类型分批）
4. command 序列化收敛
5. Orchestrator 出口改 command（generation 域与文档域正式脱钩）

与 §10 的关系：本节是 M1 的模块粒度细化（步骤 1/3/4/5）+ M4 对接面提前冻结（步骤 2）,无冲突。

### 13.5 共享 / 归属模型（预检定稿 2026-07-08）

Figma 式，**无预定义团队实体**——组织成员资格 = 有效 maker JWT，默认私有，按项目邀请/分享。

- **归属**：`projects(id, ownerId)` + `project_members(projectId, userId, role)` + `share_links(token, projectId, permission)`；**人的标识一律用 maker user id，不发明第二套身份，零 maker 跨仓改动**。
- **可见性**：默认只见自己建的项目；分享两种——邀请指定人 / 分享链接；被分享后项目出现在对方列表。
- **权限**：成员 role = owner/editor/viewer；链接 permission = view/edit（owner 建链接时选）；**仅 owner 可邀请**（第一版关死转授权）。校验点全在 BFF 中间件（`/api/projects`、`/api/canvas`）。
- **并发编辑**：节点级合并（A2）——每 record 带 revision，服务端按节点粒度 merge，同节点才冲突提示。
- **chat**：~~per-canvas，随画布分享对成员可见（提示词草稿即公开；未来加"私有/发布"标记可向后兼容）。~~ **DP-6R（2026-07-12 重拆，本句 per-canvas 共享语义 obsolete）**：chat-message **per-actor 私有**（envelope.ownerId=写入者 actor；PK=(actor,'chat-message',msgId)，两 actor 可在同 canvas 拥同 msgId），**不随画布分享、成员互不可见**；chat-collection 仍 per-canvas under canvas owner，只钉 canvas 级"对话集合在"liveness 标记（随 canvas 原子创建/软删/恢复），不含 per-actor 状态。chat 写入/reorder 不 bump 共享 canvas contentVersion；reorder 走 per-actor×canvas 独立 orderRevision（api-surface §4.2.3）。匿名 share-link 访客 chat 读写一律 401 require-login。
- **本机资产源**（Eagle/local）：deferred，资产源总线第一版只抽象服务端源。

**对 M1/P4c 的硬约束**：record schema 必含 `revision` 字段（spike 阶段就要有，不是 P4c 才加）；`/api/canvas` `/api/projects` 第一版就要带 owner/成员/链接权限校验，不能后补。

**未消化的 B 类设计缺口**（转 spike/计划，非架构阻塞）：B1 属性扁平粒度规则、B2 command 两阶段资产协议、B3 chat↔node 弱引用契约、B4 版本偏斜协商、B5 服务端资产 GC/配额、B6 DocKernel 性能路径重测。清单见 `history/arch-precheck/unknowns-map.md` B 节。
