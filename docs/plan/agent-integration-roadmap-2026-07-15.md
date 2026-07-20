# mivo-canvas Agent 化整体方案与现状盘点（接 XDMaker + 浏览器双模）

> 生成日期：2026-07-15 ｜ 基线：main `e53fa57`
> **状态：提案（draft）**。提出者（zhongxingtian-ai）**非本仓 owner**。除标注【实证现状】（代码核实的事实）与【已有决定】（可溯源到既有决策文档，如 `agent-composer-unknowns-map.md` 的 D1-D4）外，**本文所有方案选择——含双入口模型、出图执行=B、配额归属、优先级排序——均为提案，待 owner（PraiseZhu）拍板，不代表已定**。沿用 `backend-refactor-decision-2026-07-08.md` 的多人协作纪律。
> 目的：把"用 XDMaker 的 agent 对话替代 mivo 自己的对话（浏览器打开时回退到 mivo 自己的能力）、不接 coding、明确现状与缺口"这个需求，落成一份可执行的现状盘点 + 路线图。
> 方法：三点需求逐条锚定到团队已有设计（`agent-composer-unknowns-map.md` 2026-07-11）+ 逐条用代码核实"现在有什么/做到了哪些/还缺什么"（非引用旧报告，重新 grep 到当前 main）。
> 依据分级：【代码实证】= 定位到 file:line ｜【文档】= 已有设计文档 ｜【未核实】= 无法从本仓确认，需人工/外部补。

---

## 0. 一句话

你要的架构，团队 07-11 已经设计成 **"双车道 + 渐进增强"**（`agent-composer-unknowns-map.md`），和你这次的三点需求完全对齐。但**落地几乎为零**：快车道（mivo 自己的 agent）还停在"提示词增强"阶段没升级成 agent，深水道（maker bridge）需求单发出 4 天无回应，两条车道共同依赖的"agent 能写画布"的命令通道也还没通。**现在能立刻推进、且不依赖任何外部团队的，是命令通道 + 快车道——这两块做完，浏览器单机模式的 agent 就能跑起来，同时为将来接 maker 铺好地基。**

---

## 1. 需求锚定：你的三点 = 已有的"双车道"设计

| 你的需求 | 对应已有设计（`agent-composer-unknowns-map.md`） | 依据 |
|---|---|---|
| ① 接上 XDMaker 后用 maker 的 agent 对话，**替代** mivo 的对话 | **深水道**：经 maker 内置浏览器 bridge 委派 maker 会话，继承全套 MCP 工具 | 文档 §自我画像、§67-71 |
| ① 但 mivo 自己的 agent 能力**要保留**（万一网页打开） | **渐进增强 + 快车道**：bridge 检测降级——有 bridge 走深水道，无 bridge（普通浏览器）回退 mivo 内部快车道 | 文档四象限"渐进增强（bridge 检测降级）" |
| ② 不接 coding agent | 深水道只承接**多步跨系统任务**（飞书/Slack/Jira/Confluence/资产库），coding 不在委派范围 | 文档 §70"多步跨系统…走深水道，工具由 maker 现成 MCP 承接" |
| ③ 现状/缺口/后端准备的明确规划 | 本文档 §3-§7 | — |

**"替代"的含义（本人提案，待 owner 拍板）**：是**两个不同的输入框**，不是"mivo 一个 UI 内部路由"：
- **XDMaker 模式**：用户在 **maker 自己的输入框**里对话，maker agent 全盘处理（含要不要出图），**mivo 输入框不出现**。maker agent 要出图/排版时，反向操作 mivo 画布。
- **浏览器模式**：用户用 **mivo 自己的输入框**，走 mivo 快车道 agent。

> ⚠️ **这一点和既有设计文档有出入，需团队对齐**：`agent-composer-unknowns-map.md §70` 原本设计的是"单步确定性(出图)留 mivo 快车道 / 多步跨系统委派 maker"的**路由分工**（即 mivo 一个输入框内部分流）。你的模型是**两个独立入口**（maker 模式连出图都在 maker 的框里发起）。两者的差异会影响一个具体问题：**XDMaker 模式下出图由谁执行**——是 maker 用它自己现成的 art/mivo 生图 MCP 工具（`cindy-replication-assessment.md §4` 确认 maker 已有这套工具），还是 maker agent 经命令通道调 mivo 的生图？这是深水道设计要定的点（并入 §6 K3），但不影响 §7 的主线优先级。

---

## 2. 架构全景（前端是两个不同入口，共用底层画布 + 命令通道）

> 修正（2026-07-15，用户）：**不是"同一个 mivo UI 换大脑"。装在 XDMaker 里时，用户在 maker 自己的输入框里对话，mivo 的输入框不出现/不使用；只有普通浏览器打开才用 mivo 自己的输入框。是两个不同的对话入口。**

```
              用户在哪个输入框打字？——两个不同的入口
                              │
        ┌─────────────────────┴──────────────────────┐
   [普通浏览器]                                  [XDMaker 内置浏览器]
        │                                              │
  ┌─────▼──────┐                              ┌────────▼─────────┐
  │ mivo 自己的 │  单步确定性                   │ XDMaker 自己的   │  用户直接在 maker
  │ 输入框+agent│  (出图/rerun/derive)          │ 输入框 + maker   │  里对话;mivo 输入框
  │ (意图漏斗)  │                              │ agent(全套 MCP   │  不出现/不使用
  └─────┬──────┘                              │ 工具:飞书/Jira/  │
        │                                     │ 资产库)          │
        │ mivo agent 改本地画布                └────────┬─────────┘
        │                                              │ maker agent 要改画布时,
        │                                              │ 反向操作 mivo 画布
        └────────────────────┬─────────────────────────┘
                     ┌────────▼─────────┐
                     │  CanvasCommand    │  ← 写画布的唯一受控入口
                     │  命令通道         │    (受鉴权+版本+幂等+可序列化)
                     └────────┬─────────┘
                     ┌────────▼─────────┐
                     │ 服务端持久化(PG)  │  ← 已建好、已在服务器开启
                     └──────────────────┘
```

**两个关键点**：
1. **入口是两个不同的输入框**：XDMaker 模式下 maker 的对话**完全取代** mivo 的对话入口（mivo 输入框不出现）；浏览器模式才用 mivo 自己的输入框。这就是需求①"替代"的字面含义（见 §1 更正）。
2. **不管哪个入口，"把结果写进画布"都要经同一个命令通道**——浏览器模式是 mivo agent 改本地画布；XDMaker 模式是 **maker agent 反向操作 mivo 画布**（方向 = maker→画布，正是你两轮前指出的"方向反了"：原需求单 `maker-bridge-request-route-a.md` 设计的是 mivo 页面→驱动 maker 会话，方向错了，见 §6 K3）。命令通道是两个入口的**公共地基，不依赖 maker，应优先做**。

---

## 3. 现状盘点：现在有什么 / 做到了哪些

### 3.1 快车道（mivo 自己的 agent）—— 停在"提示词增强"，未升级成 agent

| 项 | 现状 | 依据 |
|---|---|---|
| 聊天对话 | ✅ 有 UI + 有 LLM。但**只是单层意图路由**：`enhance` 路由用 claude-haiku-4-5→gpt-5.4-mini，把输入分成 `chat`（回文字/追问）或 `generate`（出润色 prompt+参数） | 【代码实证】`server/routes/enhance.ts:4,25-27` |
| 出图/改图 | ✅ **真生图**（非 mock），走平台通道 aigc.xindong.com | 【代码实证】`server/platform/job.ts`、`server/routes/generate.ts`/`edit.ts` |
| mask 局部编辑 | ✅ 有完整流程 | 【代码实证】`src/store/chatMaskEditFlow.ts` |
| **四层意图漏斗**（UI直判>规则>小LLM>确认条） | ❌ **未实现**（现在是单层 LLM 路由，无 UI直判/规则旁路） | 【代码实证】无 intent/funnel 实现文件；无相关提交 |
| **rerun / derive 作为独立工具**（"再来一张"=同参重跑、"出变体"=i2i） | ❌ **未实现**（现在只有笼统的 generate） | 【代码实证】无实现；D1 已拍板但未落地 |
| **4 张批量田字格落图 + 血缘边** | ❌ 未实现（D3 已拍板未落地） | 【文档】D3 |
| **四层记忆**（图片/画布/项目/个人） | ❌ **只有接缝文档，零实现** | 【代码实证】`docs/decisions/memory-layer-seam.md:2`"占位不实现"；无客户端 memory 文件 |
| **agent 化灰度 flag**（`?composer=agent`） | ❌ 未实现（计划挂但没建） | 【代码实证】无实现；【文档】C5 |

**小结**：快车道现在能"聊天 + 出图"，但**不是 agent**——没有工具、没有自主多轮、没有记忆、没有确定性执行（rerun/derive）。文档里 v1 计划的快车道 T1-T4，**一件都没开工**。

### 3.2 深水道（接 maker）—— 需求单发出，无回应，零实现

| 项 | 现状 | 依据 |
|---|---|---|
| maker bridge 需求单 | ✅ 已发出（2026-07-11，`docs/plan/maker-bridge-request-route-a.md`） | 【文档】 |
| maker 团队回应 | ❌ **发出 4 天，无任何回应**（git/GitHub/changelog 零命中；**飞书渠道未核实**） | 【代码实证】+ 【未核实：飞书】（见 §6） |
| mivo 侧 bridge 消费代码 | ❌ 零实现（无 makerBridge/mivoPreload 消费代码） | 【代码实证】全仓 grep 仅命中需求单本身 |
| 深水道设计成熟度 | ⚠️ 有设计但有硬缺口：workdir/workspace 映射、流式输出、多会话并发身份，均未定（你上一轮点出的三点，文档 B1-B5/§69 也标了"未核实/待决"） | 【文档】B1-B5 |

**小结**：深水道**完全卡在外部依赖**（maker 团队要先改他们的 Electron 代码库注入 bridge），且设计本身还有你点出的三个硬缺口没解决。

### 3.3 命令通道 + 服务端地基（两条车道共用）—— 地基扎实，最后一段没接通

| 项 | 现状 | 依据 |
|---|---|---|
| 服务端 PG 持久化 + 权限 | ✅ 建好，**且已在生产服务器开启**（07-13 我们翻的 `MIVO_PERSIST_BACKEND=pg`）；owner/editor/viewer + 分享链接 + per-record 乐观锁(409) | 【代码实证】`server/persist/pgBackend.ts`、`pgPermissionBackend.ts`；服务器 healthz `backend=pg` |
| CanvasCommand 类型系统 | ✅ 27/27 同步出口已迁入（JSON union + 序列化 + 两阶段设计） | 【代码实证】PR #242；`src/canvas/actions/canvasCommand.ts` |
| 手动操作 → 服务端同步 | ✅ **几乎全接通**（增删改/撤销重做/剪切/编组/移动/粘贴/别名/指针交互全走 wrapMutation），但**锁在客户端开关 `?persist=server` 后，默认 `local`** | 【代码实证】PR #243-#248；`src/lib/persistMode.ts:28` 默认 local |
| 资产引用计数（attach/detach） | 🟡 手动操作已接（duplicate/paste/delete），但 **import/generate 两条明确未接**（团队标 `TODO(T2.2)`） | 【代码实证】PR #244 body |
| **命令通道服务端端点** | ❌ `/api/canvas` 只有逐记录 REST（CRUD + reorder），**没有"提交任意 CanvasCommand"的命令端点** | 【代码实证】`server/routes/canvas.ts:274-794` 全是 `/:id/nodes/:nodeId` 式逐记录路径 |
| **不可信 payload 校验** | ❌ `deserializeCanvasCommand` **明示不校验不可信远程命令** | 【代码实证】`src/canvas/actions/canvasCommand.ts:431` |
| **异步两阶段命令 AssetBridge**（生图/导入/mask 落画布） | ❌ **全仓零生产实现** | 【代码实证】`git grep CanvasCommandAssetBridge` 仅命中类型定义 + 测试 |

**小结**：**"人手动改画布→存服务器"这条链，代码基本通了（只差开客户端开关）；但"agent/外部下指令改画布"这条链——命令端点、payload 校验、异步生成落画布——是空的。** 而后者恰恰是 agent 化的核心。

---

## 4. 缺口盘点：还缺什么（按车道汇总）

### 4.1 两条车道共用的公共缺口（最关键，不依赖 maker）

1. **命令通道服务端化**：加"提交 CanvasCommand"的受鉴权端点 + 版本号 + 幂等键(clientId) + base revision/409/rebase + 审计日志。（这是审计报告排的价值最高项，我 07-14 报告也确认零进展）
2. **deserialize 校验不可信 payload**：agent/远程下来的命令必须校验，否则是安全洞。
3. **异步两阶段命令 AssetBridge 生产实现**：让"生图/导入资源"的结果能真正落进画布（现在 import/generate 明确绕开同步、标 TODO(T2.2)）。

### 4.2 快车道专属缺口（mivo 自己的 agent，浏览器模式就要用）

4. 四层意图漏斗（UI直判/规则/小LLM/确认条）+ 降级语义（解析失败按纯提示词，保底不劣于现状）。
5. rerun / derive 两个确定性工具（D1 已拍板，未落地）。
6. 4 张批量田字格落图 + 血缘边（D3 已拍板，未落地）。
7. 四层记忆的客户端实现（现在只有接缝文档；依赖 §4.1 的服务端真相源就位）。
8. 意图识别评测集（30-50 条真实美术话术，A5，**owner 未认领、未排期**，是快车道验收的 gating 前置）。
9. agent 化灰度 flag（`?composer=agent`）。

### 4.3 深水道专属缺口（接 maker，卡外部）

10. maker 团队接需求单 + 实现 `window.makerBridge`（外部依赖，卡住）。
11. 你点出的三个设计硬缺口需先定：**workdir/workspace 映射**（mivo 画布不是目录，agent 会话怎么知道操作哪个画布）、**流式输出协议**（画布场景需要看着结果长出来，原需求单砍掉流式站不住）、**多会话并发身份**（agent 主动写画布=天然多会话并发，原方案推给"以后"的多租户，反过来就是地基问题）。
12. mivo 侧 bridge 消费层 + 断链检测/重建 + 版本协商（B2/B4）。

---

## 5. 后端要对齐 agent 目标，还缺哪些能力（2026-07-15 逐条核实到 main `e53fa57`）

> 分"已具备（别重造）"和"缺口（按车道/优先级分组）"。缺口均为**当前 main 实测**，非引用旧审计。

**已具备、直接可用（别重造）：**

| 已具备 | 依据 |
|---|---|
| PG 持久化 + owner/editor/viewer 权限 + 分享链接 | 已建、已在生产开启（07-13） |
| per-record 乐观锁（revision/409）——多会话并发写同画布的冲突仲裁 | `server/persist/backend.contract.dual.test.ts` |
| 画布逐记录 REST（CRUD + reorder + node/edge/anchor + chat 子资源） | `server/routes/canvas.ts:274-794` |
| SSO 鉴权（#155） | 已建 |
| 真生图（平台通道 aigc.xindong.com） | `server/platform/job.ts` |

### 组 1 · 命令通道 —— 最核心，两条车道公共，不依赖 maker

1. **命令提交端点**：`/api/canvas` 现在**只有逐记录 REST，无"提交高层命令"端点**（实测 grep `/command|/submit|/batch|/agent` 全空）。需 `/api/canvas/:id/commands`（或 batch）：鉴权 + 命令版本 + 幂等键 + base revision/409/rebase + **审计日志**。后端最大一块新增。
2. **不可信 payload 服务端校验**：agent/外部命令必须服务端校验 schema——客户端 `deserializeCanvasCommand` 明示不校验（`canvasCommand.ts:431`），服务端也无此层。安全洞。

### 组 2 · "生成落画布"的服务端支撑 —— agent 写画布的关键路径

3. **异步生成命令的服务端接线**："生成图→落画布"异步链服务端**还不成立**（import/generate 的 node 创建绕开服务端，团队自标 `TODO(T2.2)`，PR #244 body）。
4. **生成任务持久化 + per-user 归属**：任务注册表现在**进程内内存、重启即失、单进程**（`server/tasks/registry.ts:2,10` 注释原话）。agent 生成是异步（提交→轮询→落图），任务态须**落库 + 按用户隔离**。

### 组 3 · 深水道专属 —— 接 maker 时才要，多数 gated 在外部确认

5. **命令通道接受"外部身份"**：命令端点要能鉴权来自 **maker 会话的用户身份**（不只 mivo 自己 SSO），让 maker agent 下发的命令被授权 + 记到对的人。（并入 K3）
6. **per-user 出图身份透传**：出图现在**写死共享 platformKey**（`state.ts:123` `sub: ctx.platformKey`）。支持按用户身份出图 = §6.1 配额迁移前置，**gated 在 aigc.xindong.com 确认**。
7. **流式（SSE）业务通路**：现在**只有探测 probe**（`server/routes/sse-probe.ts` + spike，测网关放不放行），无真 agent 事件流通路。maker 进度回传 / "看着图生成" 需要它。**gated 在网关实测**（即第三步测试开关）。

### 组 4 · 快车道 agent 支撑

8. **记忆层服务端**：四层记忆后端**零实现**（`server/` 无 memory 文件；#203 仅接缝文档）。可先走客户端 localStorage 过渡（seam 文档 C7 已定），但"项目简报/被否方向"要跨设备/协作时需服务端（可挂 `user-state` KV 的 `memory:` 命名空间）。

### 建议顺序

```
最先(无外部依赖,agent 写画布总开关):  组1(命令端点+校验) → 组2(生成落画布+任务持久化)
浏览器快车道要、可先客户端过渡:        组4(记忆,后端不阻塞)
接 maker 时才做、且卡外部确认:          组3(外部身份/per-user出图/SSE)
```

**小结**：后端地基（存储/权限/并发/鉴权/真生图）都有了；**缺的全是"让 agent 安全地把生成结果写进画布"这条链**——命令端点、payload 校验、生成落画布、任务持久化（组1+组2），核心、无外部依赖、该最先做。深水道（组3）接 maker 时再说，多数 gated 在外部（maker 团队 / aigc.xindong.com / 网关实测）。

---

## 6. 关键决策与开放项（需拍板 / 需外部确认）

| # | 事项 | 类型 | 现状 |
|---|---|---|---|
| K1 | "替代对话"= **两个独立输入框**（XDMaker 用 maker 的框 / 浏览器用 mivo 的框） | 方向性 | 🟡 本人提案，**待 owner 拍板**；与旧文档"路由分工"模型有出入，需团队对齐（§1） |
| K2 | maker bridge 需求单——**主动追问 maker 团队**，问排期/意愿；**并排查 maker 是否有不需改代码的外部 HTTP/API 通路** | 外部依赖 | ⏳ 待发起（B1）；飞书渠道我**未能核实**（token 失效），需人工确认对方到底回没回 |
| K3 | 深水道设计缺口：**方向反转**（maker→画布，非原需求单的 mivo→maker）+ workdir/workspace 映射 + 流式协议 + 多会话身份 + **XDMaker 模式出图由谁执行**——**先定再发第二版需求单**。详见 **§6.2**（workdir 已给建议；出图执行/方向已给提案；流式/多会话身份待补） | 设计 | ⏳ 本人已给方向 + workdir 建议（§6.2），流式/多会话身份未成文；全部待 owner 拍板 |
| K4 | 意图评测集 owner 认领 + 话术采集（快车道验收 gating） | 前置任务 | ⏳ 未认领（A5，建议你本人） |
| K5 | 三组双轨（renderer/kernel/persist）退轨决议 | 技术债 | ⏳ 审计报告排第三，跟本方案关联间接 |

---

## 6.1 出图执行 + 配额归属（本人提案，待 owner 拍板）

> ⚠️ 本节的选择由提出者（非 owner）给出，**需 owner（PraiseZhu）拍板后才算定**。尤其配额归属涉及计费/成本归属，是管理决策，本人只提建议。

**提案（待 owner 拍板）：**
- **出图执行 = B（mivo 执行）**：画布是 mivo 的地盘，凡是写画布（含"生成落画布"）都经 mivo 命令通道，单一真相源、两模式行为一致。**无过渡态**（不临时用 maker 自带工具出图）。
- **配额归属 = 先期算 mivo-canvas，后期迁 XDMaker**：
  - **先期（现在）= 零改动**：mivo 出图用共享 `MIVO_PLATFORM_KEY`，天然算 mivo-canvas。**不需要做任何事，维持现状。**
  - **后期迁移到"按用户个人算"**（XDMaker 模式取 maker 身份 / 浏览器模式取 SSO 身份），有下方前置清单，**未过闸前不启动**。

**迁移前置清单（必须按序过闸，否则维持先期）：**

*第一道闸 — 找 aigc.xindong.com 的人确认（现在确认不了 → 卡在先期）：*
1. **计费粒度**：按 `mivo_` key 一个桶，还是能按最终用户个人算？有无独立于调用 key 的"配额归属人"概念？
2. **per-user 身份怎么传**：`/api/v1/state/token` 的 `sub` 能否换成用户个人身份（SSO / maker 用户），让后端按人算？还是 `sub` 必须 `mivo_` 前缀 key？
3. **maker 出图现在的计费身份**：maker art/mivo 工具用什么身份/凭证按人算（B5）？mivo 能否用同一套，让"maker 触发"与"mivo 触发"落到同一人同一桶？
4. **配额耗尽行为**：per-user 配额用完返回什么码，mivo 怎么降级/提示。
5. **per-user 凭证签发/轮换**：谁签发、怎么轮换（勿变成每人每月换 key）。
> ①③ 是迁移可行性总闸门：答"能按人头算"→ 迁移≈"mivo 改用 per-user 身份"一个改动；答"只能按 key 一桶"→ 需后端先支持，重估甚至不做。

*第二道闸 — mivo 侧工程（确认通过且后端支持后才做）：*
6. platform token 交换支持 per-user `sub`（依赖 ①②）
7. 出图调用从共享 key 切到当前登录用户身份（浏览器 SSO #155 / XDMaker maker 身份）
8. 命令通道携带用户身份（XDMaker 模式，并入 K3）
9. 配额耗尽降级/提示 UX（依赖 ④）

**未核实**：aigc.xindong.com 的计费分桶模型（无后端可见性，即上方 ①，需人工确认）。

## 6.2 深水道设计缺口 K3 的建议（本人提案，助 owner 思考，非决定）

> 本节把 K3 的设计缺口逐条给**建议**，供 owner 拍板参考。全是提案，不代表已定。

### workdir/workspace 与 mivo 的关系（本人建议）

**问题本质**：maker 是给写代码用的，每个 agent 会话绑一个 **workdir（硬盘上的代码文件夹，通常是 git 仓库）**——agent 靠它知道"我在哪个项目里读写文件"。而 mivo **没有文件夹**：只有数据库里的**项目**和**画布**（用 `canvasId` 标识）。所以"maker 会话该操作哪张画布"没法用 workdir 表达——square peg in round hole。

**建议：解耦，别硬把画布塞进 workdir。**
- workdir 归 maker 的**文件操作**用；**mivo 画布任务根本用不上它**，留空/忽略。硬塞会让 maker 的文件工具去 workdir 找文件、啥也找不到。
- "操作哪张画布"作为**独立目标 `canvasId`**，走**命令通道**传，不塞进 workdir。
- maker agent 干 mivo 的活用的是**画布命令**（加节点/生成图，命令自带 `canvasId`），不是文件工具——workdir 与此正交。

**分支（取决于 maker 内部机制，需向 maker 团队确认）：**
- 若 maker 能建"**不带真实 workdir**"的会话 → 直接解耦，最干净。
- 若 maker **必须要一个真实文件夹**才肯建会话 → 退一步：给每个 mivo **项目建一个真实空文件夹**（放导出/资产）当 workdir 凑数（即把 §69"项目↔工作目录"落成一个真文件夹）；具体操作哪张画布仍靠命令里的 `canvasId`。
- 两种情况下，"操作哪张画布"都靠 `canvasId` 走命令通道，**不靠 workdir**——这一点不变。

**→ 要向 maker 团队确认的点（并入 K2 追问清单）**：maker 建会话是否强制要求一个真实存在的 workdir？

### K3 其余缺口（仍待成文提案）

- **方向反转**（maker→画布）：已在 §2 说明，需在第二版需求单里改对方向。
- **XDMaker 模式出图由谁执行**：已在 §6.1 给提案（B / mivo 执行）。
- **流式输出协议**、**多会话并发身份**：本文尚未给具体提案，深水道设计时补（owner 拍板前置）。

## 7. 优先级排序与路线图

> 原则：先做**不依赖 maker、且两条车道都用得上**的公共地基，再做浏览器单机就能验证的快车道，深水道并行推进外部沟通但不阻塞主线。

**第一优先（现在就能做，不等任何人）——公共命令通道**
- P1-1 命令通道服务端化（端点 + 版本 + 幂等 + 鉴权 + 审计）
- P1-2 deserialize 不可信 payload 校验
- P1-3 异步两阶段命令 AssetBridge 生产实现（打通生图/导入落画布）
- ▶ 完成后：agent（不管哪个大脑）具备"安全地把生成结果写进画布"的能力——**这是 agent 化的真正开关**。

**第二优先（紧跟，浏览器单机即可验证）——快车道 agent 化**
- P2-1 四层意图漏斗 + 降级语义
- P2-2 rerun / derive 工具（D1）
- P2-3 4 张批量田字格（D3）
- P2-4 意图评测集（K4，需先认领 owner——**建议现在就认领，因为它是 P2 验收 gating，采集要时间**）
- P2-5 挂 `?composer=agent` 灰度 flag
- ▶ 完成后：**普通浏览器打开 mivo 就有一个能用的 agent**（要保留的那个能力，真正成型）。

**并行推进（有等待时间，越早启动越好）——深水道外部沟通**
- P3-1 主动追问 maker 团队（K2）+ 排查是否有绕开 bridge 的外部 API
- P3-2 定深水道三硬缺口（K3），把第二版需求单改对再发
- ▶ 这条完全在别人手上，先启动沟通、把设计定对，不占主线工程。

**理由**：
1. 命令通道（P1）价值最高、无外部依赖、且**是两条车道的公共前提**——不管最后接不接 maker，agent 要改画布就必须有它。审计报告和我 07-14 的调查都把它排第一。
2. 快车道（P2）能让"要保留的 mivo 自己的 agent"从"提示词增强"真正变成 agent，且浏览器单机就能验证，不赌 maker。
3. 深水道（P3）价值大但**全案最大外部依赖**（文档 B1 原话），且设计有未决硬缺口——先沟通、先定设计，等 P1 地基好了，接起来水到渠成；一直等它会拖死整个 agent 化。

---

## 附：本方案依据与核实记录

- 三点需求逐条锚定 `docs/plan/agent-composer-unknowns-map.md`（2026-07-11，团队既有设计，含 D1-D5 决策、B1-B5 外部依赖、C1-C7 盲区）
- 现状逐条 grep 到当前 main（`e53fa57`）核实，非引用旧报告：`server/routes/enhance.ts`、`server/platform/job.ts`、`src/lib/persistMode.ts:28`、`src/canvas/actions/canvasCommand.ts:431`、`git grep CanvasCommandAssetBridge`、`server/routes/canvas.ts`、`docs/decisions/memory-layer-seam.md`
- 交叉印证：`docs/reports/arch-backend-decouple-audit-2026-07-12.md`（后端审计）、`docs/reports/maker-agent-integration-status-2026-07-14.md`（我上次的调查，含代码漂移核实）
- 快车道 agent 化实现：**核实为零**（无 intent/funnel/rerun/derive 实现文件、无相关提交）
- **未核实项（如实标注）**：① maker 团队是否在飞书渠道回应（MCP token 失效，未能查）；② maker 是否存在不需改代码的外部 HTTP/API 通路（未接触 maker 代码库，采信题干"无实现痕迹"）；③ K1"替代对话"的确切含义（需你确认）
