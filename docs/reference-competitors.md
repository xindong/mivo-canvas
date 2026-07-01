# MivoCanvas 参考竞品与架构选型盘点

> 生成日期：2026-07-01
> 方法：4 个 worker 并行用 `gh` CLI 检索 GitHub + WebSearch 背景资料,主 agent(opus)过滤 + 综合判断
> 目标：以 **Figma(协作无限画布)** + **Lovart(AI 设计 Agent)** 为参照,服务于"定架构 + 定后端底座"
> 注：star 数为调研时近似值(worker 用 gh 拉取,个别有出入,仅作量级参考);worker 的部分激进建议(如"立刻迁 Leafer canvas""整体上 Dify")已被主 agent 按现状与最小复杂度原则过滤,见各节结论。

---

## 0. 结论先行

**三个参照物,各管一段:**
| 参照 | 学它什么 | 不学什么 |
|------|---------|---------|
| **Figma**(闭源) | 前端薄/后端厚、实时协作、文档模型 | 它的专业设计系统复杂度(MivoCanvas 不做通用设计工具) |
| **Lovart / loveart**(闭源 AI 设计 Agent) | **对话驱动 + 自动任务分解 + 产物沉淀到无限画布**的交互范式 | 无(这正是 MivoCanvas 的目标范式) |
| **tldraw**(开源,48k★) | 可直接读的工程范本:Editor/Store 分离、节点模型、@tldraw/sync | 不必整体迁移(MivoCanvas 画布已自成体系) |

**一句话架构主张**:MivoCanvas = **Lovart 的交互范式(对话式) × Figma 的画布形态(自由无限画布) × mivoserver 的后端底座(已成熟)**。当前该定的不是"换渲染引擎",而是 **交付范式 + 画布领域模型 + 前后端契约**。

---

## 1. 竞品全景(4 轴)

### 轴1 · 开源无限画布/设计工具(Figma 前端面)
| 项目 | ★ | 渲染 | 协作 | 定位 |
|------|---|------|------|------|
| **tldraw** | ~48k | DOM | ✅ @tldraw/sync(CRDT, Cloudflare DO) | 最接近 Figma 的画布 SDK,AI 友好 |
| excalidraw | ~120k+ | Canvas2D | 中心化转发+E2E 加密 | 最流行手绘白板,轻量 |
| penpot | ~55k | Canvas+SVG | ✅ 增量 diff | 开源 Figma,专业设计系统 |
| leafer-ui | ~4k | Canvas2D/WebGL | ❌ | 高性能画布引擎(**MivoCanvas 已装,当空壳**) |
| infinite-canvas | ~2.5k | Canvas | 本地 Agent+MCP | **野心最接近 MivoCanvas** 的 AI 画布,但早期不稳定 |
| konva / fabric.js | 14k / 31k | Canvas | ❌(库) | 底层 2D 渲染库 |

### 轴2 · AI 生成式画布 / agent+画布(Lovart 面)
| 项目 | ★ | 范式 | 定位 |
|------|---|------|------|
| **ComfyUI** | ~118k | 节点式 workflow | 最强生成后端,REST+WS,专家向 |
| tldraw + fal.ai | - | 自由画布+云生成 | tldraw 官方 AI 集成,流式生成落画布 |
| Krita AI Diffusion | - | 融入绘画流 | AI 作为绘画工作流一部分,ComfyUI 后端 |
| NodeTool | - | 节点+图层混合 | 开源 AI 工作空间,多 provider |
| draw-fast / fal Infinite Kanvas | - | 实时 LCM 画布 | 低延迟边画边生成 |

### 轴3 · 实时协作/同步底座
| 方案 | ★ | 模型 | 部署 | 定位 |
|------|---|------|------|------|
| **Yjs** | ~22k | CRDT | 库+provider(y-websocket/y-sweet) | 业界标准 CRDT |
| tldraw sync | (随 tldraw) | CRDT | Cloudflare DO | 画布专用,开箱即用 |
| y-sweet | ~1k | CRDT(Yjs) | 自托管 Rust+S3 | 最轻的自托管 Yjs 持久化 |
| hocuspocus | ~2.5k | CRDT(Yjs) | 自托管 Node | Yjs 后端框架 |
| liveblocks | ~4.6k | 中心化 API | 纯 SaaS | 最快上市,按量付费 |
| electric-sql | - | CRDT+Postgres | 自托管 Elixir | local-first + DB 同步 |

### 轴4 · AI 生成后端/中台(mivoserver 面)
| 项目 | ★ | 类别 | 定位 |
|------|---|------|------|
| **Dify** | ~138k | 全栈 AIGC 平台 | 最接近整体对标 mivoserver(FastAPI+Celery+多模型+Agent+工作流 UI) |
| **LiteLLM** | ~52k | LLM 网关 | 统一 100+ LLM 接口,成本追踪/故障转移 |
| Haystack | ~25k | 管道编排 | 声明式 DAG 管道,RAG 强 |
| Prefect | ~16k | 编排+Agent 运行时 | Python 优先,原生 Pydantic AI,有状态 Agent |
| TensorZero / Langfuse | 12k / - | LLMOps/可观测 | 网关+可观测+评估+实验 |

---

## 2. 交付范式定位(最关键的架构判断)

三种 AI 画布范式,MivoCanvas 该往哪站:

| 范式 | 代表 | 用户 | AI 自动化 | 说明 |
|------|------|------|----------|------|
| 节点式 | ComfyUI | 专家 | 低(人工连线) | 灵活但门槛高,不符合"服务美术/需求方" |
| **对话式** | **Lovart** | 创作者 | **高(Agent 自动拆解)** | 一句话→AI 拆步→多模型链路→产物落画布 |
| 自由画布 | Figma/tldraw | 设计师 | 无(工具靠人点) | 画布形态好,但 AI 是外挂 |

**Lovart 的范式细节(值得直接借鉴)**:对话驱动(自然语言表达需求)→ AI 自动任务分解(选模型、串链路)→ 所有中间/最终产物沉淀到**统一无限画布**→ 二轮编辑(放大/抠图/扩展/修复)。三层交互:Talk(对话)/ Tab(选项)/ Tune(微调)。

**MivoCanvas 的坐标**:**对话式(Lovart)为交互内核 + 自由画布(Figma)为产物容器**。这决定了架构必须把"agent 能自动编排生成 + 把产物落到画布"作为一等公民,而不是"画布上挂一个生成按钮"。

---

## 3. 前端引擎:结论

**不要现在换渲染引擎。** worker 建议"迁移到 LeaferJS canvas",但按现状(baseline 已确认 DOM 渲染工作正常、能嵌媒体)和最小复杂度原则,重写渲染层是过早优化——只有当"画布图层数飙到几百上千卡顿"成为实测瓶颈时才值得动。

真正该从 tldraw 借的是**两样与渲染无关的东西**:
1. **Editor / Store 分离** — 把"数据层(Store)"和"操作层(Editor:addShape/updateShape/select 等原子操作)"分开,让 **agent 和用户走同一套原子操作入口**。这是"agent 能写画布"(L1-e)的工程前提。MivoCanvas 现在是 Zustand 直接改,没有这层抽象。
2. **节点模型范式**(见下节)。

---

## 4. 画布领域模型 + 协作:分阶段(含"无悔决策")

**强共识:先服务端持久化,现在不要上 CRDT。** 单用户阶段 CRDT 只增复杂度不产生价值;前端从 Zustand 改到 Yjs API 改动巨大。

**但现在就该定死的"无悔"数据模型改造**(为未来协作铺路,且立刻就有服务端持久化收益):
| 维度 | MivoCanvas 现状 | 目标设计 | 为什么现在做 |
|------|----------------|---------|-------------|
| 节点存储 | 扁平数组 `nodes:[]` | `Map<id, node>` | 增量更新/同步的前提 |
| 节点 id | (有 id) | 稳定 UUID,不依赖下标 | 并发/引用安全 |
| z-order | 数组下标 | **Fractional Indexing**(参考 excalidraw) | 任意位置插入不重排,协作友好 |
| 嵌套 | groupId/sectionId | 显式 parentId/childrenIds | 分组/frame 同步 |

迁移路径:未来上协作时 `Map<id,node>` → `Y.Map<id, Y.Map>`,业务逻辑基本不变。

**协作分阶段:**
- **阶段1(现在,2-3周)**:mivoserver 加画布 CRUD API + 前端 Zustand persist 到服务端(debounce)。**离开 localStorage** 是任何协作的前提。
- **阶段2(有多人需求时,3-4周)**:上 Yjs + y-sweet(自托管最轻)或 Liveblocks(最快上市)。**不要早于真实需求**。

---

## 5. 后端底座:结论

**mivoserver 已成熟,分层补强,不整体替换。** worker 提了 Dify(全栈平台,最像对标),但它与 mivoserver 能力重叠(都是 FastAPI+Celery+多模型),整体迁移成本 > 收益,且 Dify 偏 LLM+RAG、mivoserver 偏多模态生成——不合并。

**具体取舍:**
| 层 | 建议 | 理由 |
|----|------|------|
| 多模态生图/视频/3D 路由 | **保留 mivoserver 自建 facade** | 已成熟,覆盖 LLM+图+视频+3D,重写不值 |
| 纯 LLM 路由(agent 用的对话模型) | 可选引入 **LiteLLM** 解耦 | 新增 LLM provider 从"改代码"变"改配置" |
| 对话式 agent 运行时 | 先在 mivoserver 现有 `agent/` 上做,不引重框架 | 待完整清单确认 agent/ 能力再定是否上 Prefect/Pydantic AI |
| 可观测 | 可选 Langfuse | 看生成质量/成本,轻量 |
| 工作流编排 | **暂不引入 Dify/Haystack** | 与 mivoserver 重叠,过早 |

---

## 6. 落到"定架构 + 定后端底座"的决策清单

**现在能拍板的(不依赖更多调研):**
1. **交付范式** = 对话式(Lovart)× 自由画布(Figma)。agent 自动编排 + 产物落画布是一等公民。
2. **前后端契约** = 前端薄 / 后端(mivoserver)厚 + REST(CRUD)+ 实时通道(WebSocket/SSE,承载 AI 任务流与 agent 对画布的变更推送)。
3. **画布领域模型无悔改造** = Map + 稳定 UUID + Fractional Indexing + 显式父子(§4 表)。
4. **前端加 Editor/Store 分离层**,让 agent 和用户共用原子操作入口。
5. **协作先持久化、不上 CRDT**;后端在 mivoserver 上补强、不整体换。

**仍需等 mivoserver 完整清单才能定的:**
- 画布领域后端物理落点(在 mivoserver 里扩模块 vs 独立画布服务)——看它 schema 耦合度。
- 对话式 agent 直接用 mivoserver `agent/` 还是补 LiteLLM/Prefect——看 agent/ 能力强度。

---

## 附录:值得亲自去读源码的 3 个范本

| 项目 | 读什么 | 为什么 |
|------|--------|--------|
| **tldraw**(github.com/tldraw/tldraw) | Editor API、shape/store 模型、@tldraw/sync | 最成熟的"AI 可编程画布"工程参考 |
| **infinite-canvas** | Agent↔画布 via MCP、node+edge 编排 | 野心最接近 MivoCanvas,看它怎么让 agent 操作画布 |
| **Dify**(github.com/langgenius/dify) | Agent + 工作流 DAG + WebSocket 流式 | 对标 mivoserver,看成熟 AIGC 平台的后端形态(借鉴不迁移) |

Lovart 是闭源产品,无源码可读,但其**交互范式**(对话→拆解→画布沉淀→二轮编辑)是 MivoCanvas 产品设计的直接标杆。
