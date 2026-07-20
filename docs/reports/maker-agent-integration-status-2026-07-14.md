# Agent 化路线现状调查：maker bridge 卡在哪、下一步做什么

> 生成日期：2026-07-14
> 触发：三份既有材料（`cindy-replication-assessment.md` 2026-07-01 / `maker-bridge-request-route-a.md` 2026-07-11 / `arch-backend-decouple-audit-2026-07-12.md`）分散在不同时间点，没人系统追过"现在到底卡在哪、下一步做什么"。
> 方法：① 核实 maker bridge 需求单的最新状态（git log 全历史 + GitHub issue/PR 搜索 + 飞书搜索）；② 逐条重新核对 07-12 审计报告的代码断言是否仍成立（审计基线 `c442b78` → 现在 `2af6dca`，中间有 **185 个提交**，含一整条专门推进"下一步 3 件事"的 `A2` 工作流，**审计报告部分结论已过时，本报告逐条标注差异**）；③ 分析 maker bridge 与"下一步 3 件事"的依赖关系；④ 给出行动方案。
> 原则：每条结论标依据（文件:行号 / commit / PR / 文档），查不清楚的明确写"未核实"，不猜。

---

## TL;DR

1. **maker bridge 需求单（2026-07-11 发出）截至本次调查（2026-07-14，已过 3 天）仍无任何回应**——maker 代码库无实现痕迹、GitHub 无相关 issue/PR、仓库内无更新文档。**飞书渠道本次未能核实**（MCP token 失效，见 §1.3），这是本报告唯一的核实盲区，需要人工在飞书里确认一次。
2. **审计报告（07-12）的"下一步 3 件事"里，第①②件事在过去 2 天已经被大量推进**（`A2` 工作流 #237–#242），但**都还在一个默认关闭的开关后面**（客户端 `?persist=local|shadow|server`，默认 `local` = 生产零变化）。审计报告"客户端持久化没接服务端真相源"这句话，对**非画布域**和**画布域的同步写操作（增删改排序）**已经不准确了——代码已经真的接通，只是没打开开关；但对**异步两阶段命令**（生图、mask 编辑、导入资产）和**agent 可信调用的硬化**（payload 校验、批量提交端点）仍然准确，这两块是零进展。
3. **maker bridge 和"CanvasCommand 命令通道"解决的是两个不同问题，互不阻塞，可以并行推进**：bridge 是"把任务甩给 maker 会话执行"（发消息/建会话），命令通道是"agent 主动改画布内容"。就算 bridge 明天接通，agent 也只能通过它跟 maker 会话对话，**不能借道 bridge 直接操作 mivo 画布**——改画布这件事无论走哪条集成路线都必须有命令通道，所以它不应该等 maker 团队回应，现在就能独立推进，而且应该优先做。

---

## 1. 调查一：maker bridge 需求单最新状态

### 1.1 需求单本身（复述，供对照）

`docs/plan/maker-bridge-request-route-a.md`（2026-07-11 发出）：请求 maker 团队在其 Electron 内置浏览器打开 mivo 页面时注入 `window.makerBridge`（仿照 maker 现成的 `ghostPreload.js` 模式），暴露 `getContext/createSession/sendMessage/renameSession/archiveSession/onSessionEvent` 六个方法，让 mivo 前端能驱动 maker 会话。**明确排除**：多租户、指定 workdir、流式输出、Fork/Rewind 编程接口（这四项留给"路线 B"，另行评估，注意这里的 A/B 编号跟 `cindy-replication-assessment.md` 的路线 A/B 是两套不同分类，参见需求单第 1 行括注）。

### 1.2 核实结果：无任何回应痕迹

| 核实渠道 | 方法 | 结果 |
|---|---|---|
| maker 代码库 | 搜 `makerBridge` / `mivoPreload` / `mivo-bridge` | **零命中**（题干已给出此结论，本次未重复远程访问 maker 仓库，采信题干） |
| 本仓库 git 全历史 | `git log --all -i --grep="maker.bridge\|makerBridge\|mivoPreload\|mivo-bridge"` | 只有两条"抢救文档入库"的 commit（把这份需求单本身纳入 git 管理），**没有任何后续沟通/回复/实现记录** |
| 本仓库全文搜索 | `git grep -il "makerBridge\|mivoPreload\|mivo-bridge"` | 只有需求单本身 + `docs/decisions/memory-layer-seam.md` 里一处提及（引用性质，非状态更新） |
| GitHub issues/PRs | `gh issue list --search "maker bridge"` / `gh pr list --search "maker bridge OR makerBridge"` | issue 搜索**零命中**；PR 搜索命中的全是关键词宽泛匹配（如 #142 "maker 项目目录管理复刻"、#203 "记忆层"），**没有一条真正跟 bridge 实现相关** |
| `public/changelog.json` | 文本搜 | 无命中 |
| 飞书 | `mcp__feishu__search-doc` | **失败**：`UAT refresh failed / refresh token invalid`。**本次未能核实飞书渠道，这是本报告唯一的盲区**——如果 maker 团队是在飞书群里口头/文档回复的，本报告不会知道。建议人工确认一次。 |

**结论：截至调查时（2026-07-14，需求单发出后第 3 天）仍无回应，无法判断对方是排期中、已读未回、还是尚未看到。飞书渠道待人工补充核实。**

---

## 2. 调查二：审计报告（07-12）结论的时效性核查

审计报告基线是 commit `c442b78`（2026-07-12）。**现在是 `2af6dca`（2026-07-14），中间 185 个提交**，其中一条完整的工作流 `A2`（#237 → #242）看名字就是在动审计报告点名的东西：

```
#237 a2-s1  三前置(chat merge/project delete/duplicateCanvas)
#239 a2-s2  server contract — DomainOp+BaseCursor 新契约
#240 a2-s3  G1-c 画布传输客户端接线 — 7 写口真发 + hydrate base/bundle 签发
#241 a2-s4  Block 1 — 画布 submitChange 写路径通电 + fail-visible 收口
#242 a2-s4  Block 2 — 剩余 5 emitter 迁 CanvasCommand 达 27/27
```

所以**不能直接引用审计报告的结论**，必须逐条重新核实。下表是核实结果：

| 审计报告（07-12）断言 | 现在（07-14）是否仍成立 | 依据 |
|---|---|---|
| "客户端持久化没接服务端真相源……没人往服务端真的写"（`serverPersistAdapter.ts:89-115` 全 reject） | **部分过时**。非画布域（G1-a）+ 画布域同步写（node/edge/anchor 的 create/edit/delete/reorder，G1-c）**已经真的接通** | `src/lib/canvasSyncPortClient.ts:430-437`（`getCanvasSyncPort()` 非 local 模式起真实 fetch port）；`src/canvas/actions/useCanvasActionRuntime.ts:91`（生产 hook 真的用 `wrapCanvasActionRuntimeWithSync` 包裹）；`server/routes/canvas.ts:274,334,430,447,783-794`（POST/PUT/PATCH/DELETE + reorder + per-record cascade delete，比单纯 CRUD 丰富） |
| 同上，但**默认路径**是否受影响 | **不受影接，仍是零变化** | `src/lib/persistMode.ts:1-30`：三态 `local/shadow/server`，`DEFAULT_MODE = 'local'`；`getCanvasSyncPort()` 第一行 `if (isLocalPersist) return unwiredCanvasSyncPort`——不加 `?persist=server` 或 `VITE_MIVO_PERSIST`，行为跟审计时一字不差 |
| "`/api/canvas` 只有 CRUD，没有命令端点" | **仍大体成立，且不会被 #240/#241 推翻**：新增的是更丰富的**逐记录 REST 语义**（PATCH 带 DomainOp 数组做 leaf-decompose 编辑、POST reorder），**不是**一个能装下任意高层意图的"提交 CanvasCommand"式命令端点 | `server/routes/canvas.ts:783-794` 是 `/:id/nodes/:nodeId` 这类逐记录路径，不是 `/api/canvas/:id/commands` 之类的批量命令入口 |
| "CanvasCommand deserialize 不校验不可信 payload"（`canvasCommand.ts:430-433`） | **仍然成立，零变化** | `src/canvas/actions/canvasCommand.ts:431`：注释原文还在，"Deep payload validation of untrusted remote commands is [not done]" |
| "CanvasCommandAssetBridge 全仓无生产实现"（7 个异步两阶段命令：生图/mask编辑/导入资产） | **仍然成立，零变化** | `git grep -l "CanvasCommandAssetBridge"` 只命中 `canvasCommandExecutor.ts`（类型定义）和 `canvasCommandExecutor.deferred.test.ts`（测试），**没有任何非测试文件实现或注入这个接口** |
| "executor flip 未做"（audit 用语；即 27/27 emitter 之后，command 层是否真的驱动服务端写） | **明确未做，且 #240/#241 的 PR 说明里主动写清楚了这是故意 deferred 的范围** | PR #240 body："executor flip 未做……adapter 方法 wired 供直接调用方（Phase 4 emitter 接线属阶段 4，本单不做）" |
| "记忆层 #203 只是接缝文档，非实现" | **仍然成立，零变化** | `docs/decisions/memory-layer-seam.md:2`："状态：**占位不实现**（seam-only）"；日期仍是 2026-07-11，没有更晚版本 |
| "maker 路线 A 无硬 blocker，但是单用户挂件，不能当协作能力" | 这条是判断不是代码断言，见 §3 分析 | — |

### 2.1 一句话总结这次核查

**"下一步 3 件事"里第①②件（CanvasCommand → command transport、客户端接服务端真相源）过去两天有实打实的工程进展，但都还锁在一个默认关闭的客户端开关（`?persist=`）后面，而且只覆盖"同步的记录级写操作"这一个子集**——异步两阶段命令（生图/编辑/导入，这恰恰是"agent 主动改画布"最典型的场景）和"外部/agent 可信调用的硬化"（payload 校验、批量提交端点、鉴权）**两块，跟审计报告写的时候一样，是零进展**。

---

## 3. maker bridge 与"下一步 3 件事"的依赖关系

### 3.1 maker bridge 接通后，agent 能做到什么、做不到什么

先看 bridge 需求单本身定义的能力面（`maker-bridge-request-route-a.md` 第 15-79 行）：`getContext / createSession / sendMessage / renameSession / archiveSession / onSessionEvent`。**这六个方法全部是"操作 maker 会话"，没有一个是"操作 mivo 画布"**——bridge 是单向的：mivo 页面→驱动 maker 会话；maker 会话完成后，事件流回传的是 `{ sessionId, kind, finalText }`（纯文本结果），**不是"往画布里写节点/图片"的结构化指令**。

所以即便 bridge 明天就接通：

| 能做到 | 做不到 |
|---|---|
| 用户在画布输入框敲"帮我发个飞书消息给XX" → mivo 经 bridge 转发给 maker 会话 → maker 用它现成的飞书 MCP 工具执行 → 结果文本传回，显示在 mivo 界面某处（比如聊天面板） | agent（无论是 maker 会话还是别的）**没有任何路径能把结果写进画布**——没有"往画布加节点"的 API，`onSessionEvent` 只回传 `finalText`，谁来把这段文本变成画布上的节点、图片、排版，bridge 完全不管 |
| 委派任何 maker 现成 MCP 工具能干的事——Jira、资产库、web 搜索……只要是"文字进、文字出"的任务 | "帮我生成 3 张图并排好版"这类**需要把结果具体化到画布几何/内容**的任务——即使 maker 会话内部调了生图工具拿到了图片，**bridge 协议里没有"把这张图放到画布 (x,y) 位置"这个动作**，需要 mivo 这边自己解析 `finalText`/额外约定协议、再调用画布写入 API——而这个"画布写入 API" 正是 §2 核查中确认**仍然缺失**的东西 |

**结论：无论 CanvasCommand 命令通道做没做完，maker bridge 本身提供的都只是"文字层面的任务委派"，不提供"改画布"的能力。** 这两件事是解耦的——bridge 解决"甩活出去"，命令通道解决"活干完了怎么落到画布上"。

### 3.2 CanvasCommand 命令通道，是不是不管走不走 bridge 都要做？该排在 bridge 前面、后面、还是并行？

**必须做，且不依赖 bridge 是否接通，应该并行推进、优先级更高。** 理由：

1. **"agent 改画布"这个能力，任何集成路线都绕不开它**。不管任务是通过 maker bridge 委派、还是走 mivo 自建的其它 agent 接口，最终"把生成的图放进画布""把标注结果写回节点"这类动作，都要经过同一个入口——命令通道。bridge 只是"怎么把意图传进来"的其中一条路，命令通道是"意图传进来之后怎么落地"，两者是**串联但不互相依赖**的两个环节，bridge 卡住不影响命令通道的开发，命令通道没做完也不影响 bridge 先接通（只是接通了也用不上）。
2. **命令通道现在的缺口，恰好是"外部可信调用"这一层，跟 bridge 未来要用到的能力高度重合**。§2 核查发现:非画布域和画布域同步写(create/edit/delete/reorder)的**内部**传输已经打通,但 `deserializeCanvasCommand` 明确不校验不可信 payload、也没有一个"提交任意 CanvasCommand"的服务端端点。这两块恰恰是"将来不管是 maker 会话、还是别的 agent，要从外部安全地对画布下指令"必须有的东西——**现在做这件事，不是为了 maker bridge 专门做,是产品自身的地基**,bridge 接通后正好能立刻用上,不用等 bridge 之后再返工。
3. **异步两阶段命令(生图/mask编辑/导入资产)的 AssetBridge 至今零实现**,这是"agent 生成内容并落到画布"最核心的路径,跟是否走 maker 集成完全无关——不管 agent 是 maker 会话还是 mivo 自己的生成流程,这条路都要打通。

**排序建议**:并行,但如果资源有限只能挑一个,**先做命令通道**——因为它是内部工程(不依赖任何外部团队响应),而且是"下一步 3 件事"里审计报告排的价值最高项,现在的开发节奏(A2 工作流)也正好在这条线上,顺势做完阻力最小。

---

## 4. 行动方案

### 4.1 现在能立刻推进的事(不依赖 maker 团队响应)

| 事项 | 内容 | 为什么现在能做 |
|---|---|---|
| **① CanvasCommand 命令通道 agent 化硬化** | 补 `deserializeCanvasCommand` 的 payload schema 校验(§2 表格已确认零进展);设计一个真正的"提交命令"服务端端点(区别于现有逐记录 REST);补齐 idempotency/clientId、鉴权、审计 | 完全是 mivo-canvas 内部工程,A2 工作流的基础设施(BaseCursor/DomainOp/双后端契约)已经就位,续做阻力最小 |
| **② 异步两阶段命令的 AssetBridge 生产实现** | 给生图/mask编辑/导入资产这 7 个命令补生产 `CanvasCommandAssetBridge`,目前全仓零实现(§2 已核实) | 同①,纯内部工程,且是"agent 生成内容落地画布"的关键缺口 |
| **③ 决定要不要把 `persist=server` 提到默认值(或至少灰度)** | 现有的同步写通道(create/edit/delete/reorder)已经真的打通,只是锁在默认关闭的开关后。评估是否可以灰度开放,让"客户端接服务端真相源"这条线从"建好没用"变成"真的在用" | 基础设施已完备(§2),缺的只是决策+灰度验证,不涉及外部依赖 |
| **④ 追问 maker 团队一次(不是等,是主动跟进)** | 需求单已过 3 天无回应,可以先在飞书/沟通渠道追问一句进展,而不是被动等 | 这不算"依赖对方响应才能推进",追问本身现在就能做 |

### 4.2 需要等 maker 团队回应才能推进的事 + 备选方案

| 事项 | 卡在哪 | 备选方案 |
|---|---|---|
| **makerBridge 本身的实现**(注入 preload、`window.makerBridge` API) | 需要 maker 团队改他们的 Electron 代码库(`will-attach-webview` 钩子 + 新 preload 文件 + `ipcMain` handler),mivo 这边无法自己实现 | 若长期无回应,评估**是否存在不需要 maker 改代码的替代通路**——例如 maker 是否有面向外部的 HTTP/webhook API 可以让 mivo 直接调用(绕开"注入 preload"这个必须由 maker 主导的机制)。**这一点本次调查未核实**(未接触 maker 代码库/API 文档),需要专门去查 maker 是否存在这样的外部接口,如果存在,可能是比等 bridge 更快的路 |
| **多用户/协作场景下的 agent 委派**(需求单已明确排除,留给"路线 B") | 依赖路线 A(单用户 bridge)先落地探路,且需要 maker 团队对多租户方案表态 | 暂无需要,产品现在也还没到多人协作阶段(参考另一份决议里 D16 协作时机的讨论),不是当前瓶颈 |

### 4.3 优先级排序 + 理由

1. **CanvasCommand 命令通道硬化(§4.1 ①②)** — 最高优先级。不依赖外部、是"agent 改画布"唯一路径、现有工程惯性(A2 工作流)正好在这条线上、且审计报告本身就把它排第一。
2. **`persist=server` 灰度决策(§4.1 ③)** — 高优先级,紧跟①。基础设施已完备,只差决策,决策成本低、验证价值高。
3. **追问 maker 团队 + 排查是否有绕开 bridge 的外部 API(§4.1 ④ + §4.2 备选方案)** — 中优先级,但要**尽快启动**,因为这条线完全在别人手上、有不确定的等待时间,越早问越早知道要不要转向备选方案。
4. **三组双轨退轨决议(renderer/kernel/persist)** — 中优先级,审计报告排第三,跟本次 maker/agent 化的问题关联较间接,可以按原计划节奏推进,不需要因为这次调查加速。

---

## 附录:本次调查方法记录

- 直接读三份权威文档全文(未做二次转述失真)
- `git log --all` 全历史搜索(非仅当前分支)maker bridge 相关关键词
- `gh issue list` / `gh pr list` 关键词搜索(GitHub 侧)
- `mcp__feishu__search-doc` 尝试搜索(**失败:token 失效,未能核实飞书渠道,见 §1.3**)
- 对审计报告(07-12)列出的每一条"未接线/缺失"断言,逐条用 `git grep` + `Read` 定位到当前 main(`2af6dca`)对应代码行重新核实,而非直接引用审计报告原文
- 核实过程中发现的关键代码位置:`src/lib/persistMode.ts`、`src/lib/canvasSyncPortClient.ts:428-437`、`src/canvas/actions/useCanvasActionRuntime.ts:91`、`src/canvas/actions/canvasSyncRuntime.ts`、`server/routes/canvas.ts`、`src/canvas/actions/canvasCommand.ts:431`、`src/canvas/actions/canvasCommandExecutor.ts`
- 未做:未接触 maker 代码库本身(采信题干已核实结论);未能核实飞书;未重新跑 e2e/CI(本次是只读调查,不改代码)
