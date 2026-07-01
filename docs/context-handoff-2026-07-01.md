# MivoCanvas Context Handoff - 2026-07-01

## Authority Roots

- 项目根(前端,权威): `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
- 后端能力层(只读参考): `/Users/praise/AI-Agent/Claude/reference/projects/mivo-server`(= mivoserver / ai_server)
- 真实消费方参考(只读): `/Users/praise/AI-Agent/Claude/reference/projects/XD-AIGC-toolbox`(有 mivo-client.js)
- cindy/maker 引擎参考(只读): `/Users/praise/AI-Agent/Claude/reference/Cindy`

## Hard Boundaries

- MivoCanvas 的 git `origin` 指向 upstream(kirozeng/MivoCanvas)——**不可直接 push**;个人改动先 fork/新建 remote。
- `reference/` 下的 mivo-server / XD-AIGC-toolbox / Cindy 是**只读参考**,私有代码,勿改勿外传。
- **架构方向已定,勿重开**(除非有新证据推翻):见 `docs/architecture.md`。
- **不选 tldraw** 作前端引擎:其许可证与"开源 + 对标 Figma 的设计工具"冲突(生产需付费授权 or 画布挂 "made with tldraw" 水印 + telemetry + 不能相容开源许可)。已核实 LICENSE 原文。
- **Figma 导入是 Non-goal**(暂缓);导出 PNG/JPG/PDF 要做。
- 不把 mivoserver 的 message-centric 内核当产品核心(明确排除)。
- 未经用户显式授权勿写 `/Users/praise/.claude`(项目记忆已在本会话写好,无需再动)。

## Current State（已settled事实）

- **阶段 = "定架构"已收敛完成**;实现未开始。
- **产品定位(已写入项目记忆 `project_mivocanvas_vision`)**:MivoCanvas = 老 mivo 的产品形态迭代(对话式+无限画布,面向美术/设计师/策划);范式 人↔agent/图(锚点)对话;mivoserver 降为可复用能力层,非产品核心。
- **目标架构 v1 已定并落盘**(`docs/architecture.md`):画布文档为真相源(CRDT同步) + Agent编排 + mivoserver能力层 + 三个一等域(项目/资产、SkillHub、自动化) + 贯穿的飞书OAuth/RBAC身份权限。
- **用户已确认的关键需求**:①多人协作(要,尤其 Figma 式**锚点反馈留言**)+ 使用者画像(美术/设计/策划,布局不同,画像稍后做但架构留缝);②权限/共享走**公司飞书登录鉴权**(复用 mivoserver 飞书 OAuth+RBAC,可从组织信息派生画像);③导出 PNG/JPG/PDF,不导入 Figma;④SkillHub 仿 maker。
- **关键设计微调(已并入 architecture.md)**:锚点统一成 `Pin` 一等对象(kind=edit 喂agent / kind=comment 人际留言thread);L1 从第一天 CRDT 同步优先;身份权限直接复用 mivoserver 飞书栈。
- **前端现状(已盘点)**:Vite+React19+TS+Zustand;画布 DOM 渲染(LeaferJS 空壳);AI 全 mock;无后端集成;localStorage 持久化;节点扁平数组+绝对坐标+无旋转。
- **mivoserver 现状(已盘点)**:成熟 FastAPI 中台,多模型生图/视频/3D + 异步任务(Task+worker+SSE)+ MongoDB/PostgreSQL + OSS + 飞书OAuth+RBAC + scheduler + 自研多厂商 agent runtime + board(Konva)画布域。
- **fork 底座调研结论**:无单一银弹;组合。前端引擎(开源前提)MIT 方向 = Konva(自带嵌套变换+旋转,自建编辑器)或 Excalidraw(现成编辑器,嵌套变换要扩);L2 编排参考 CopilotKit+LangGraph;领域参考 asui-canvas / gpt-image-canvas。

## Key Artifacts

- `docs/architecture.md` - **目标架构 v1(权威,先读这个)**:四层+三域+身份线、L1 schema 草案、复用 mivoserver 映射、Non-goals。
- `docs/mivo-system-inventory.md` - 全栈盘点(mivoserver + XD-AIGC-toolbox),含前后端衔接现状。
- `docs/baseline-inventory.md` - 前端 MivoCanvas 现状基线(功能矩阵/实现程度)。
- `docs/reference-competitors.md` - 竞品/开源底座选型(tldraw/Excalidraw/Konva/CopilotKit 等)。
- `docs/cindy-replication-assessment.md` - cindy 全链路 + 复刻评估(探索支线,非核心目标)。
- 项目记忆 `project_mivocanvas_vision`(lizi_memory,type=project)- 产品定位权威。
- 全部 `docs/*.md` 当前**未 commit**(git untracked)。

## Open Findings / Risks

- **无阻塞性 P0/P1**。架构层面已 settled。
- **P2 实现级待定(不卡架构)**:①前端 MIT 引擎 Konva vs Excalidraw(到实现 L4 时定);②SkillHub 开放生态 vs 纯内部(定沙箱/审核)。
- **待办提醒**:本会话起了一个 orca 团队 + 3 个 gpt-5.5 worker(fork 调研已完成),**可能仍在空转,建议下个窗口 end_team 收工**。
- 用户偏好(重要):**要"说人话"、先给结论、别绕远、别过度上工具流程(plan mode/AskUserQuestion 卡片让用户反感过)**;要求先定架构再谈实现。

## Current Decision State

```text
architecture_v1 = DEFINED_AND_SAVED (docs/architecture.md)
product_vision  = SETTLED (memory: project_mivocanvas_vision)
implementation  = NOT_STARTED
open_impl_choices = [frontend_engine: Konva|Excalidraw, skillhub: open|internal]
next_phase = 分阶段实施路线 OR 定前端引擎
```

## Next Best Action

- **单一下一步**:二选一——① 按 `docs/architecture.md` 拆**分阶段实施路线**(哪几步/先后/每步验收);② 先定**前端引擎**(Konva vs Excalidraw)这个实现选择。
- **先读**:`docs/architecture.md`(架构权威),需要背景再读 `docs/mivo-system-inventory.md`。
- **不要做**:不要重开架构方向;不要选 tldraw;不要做 Figma 导入;不要直接 push origin;不要过度上 plan-mode/问答卡片,直接给结论。

## New Window Prompt

```text
继续 MivoCanvas 架构落地。

权威项目根目录：
/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas

先读取交接文件：
/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/docs/context-handoff-2026-07-01.md
再读架构权威：
/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/docs/architecture.md

硬边界：
- 架构方向已定,勿重开;前端引擎不选 tldraw(许可与开源冲突);Figma 导入是 Non-goal;origin 指向 upstream 不可直接 push。
- 说人话、先给结论、别绕远、别过度上工具流程。

当前目标：
架构已定稿,进入实现规划。

下一步（用户二选一）：
① 按 architecture.md 拆分阶段实施路线（步骤/先后/验收）；② 先定前端引擎 Konva vs Excalidraw。
另:本会话遗留一个 orca 团队+3个idle worker,建议 end_team 收工。
```
