# MivoCanvas Demo · 总计划（master plan）

> 生成：2026-07-01 晚。规划法：采用 /gd-plan 的结构（目标链 + 步骤 + SC + anti-fill），根植本 demo 目标（非 Project GD goal-source），跳过 Project-GD 专属治理机器。
> 输入：`docs/demo/reuse-inventory.md`（复用清单，权威）+ `docs/demo/PIPELINE.md`（范围/约束）。
> 每步详细计划见 `docs/demo/plan/step-M*.md`。

## 目标链
- **DEMO_GOAL**：明早开浏览器可验收的 MivoCanvas AI 画布 demo，跑通三条链路（文生图/图生图、锚点局部重绘、Eagle tag 目录 + 瀑布流 + 复制粘贴/拖入）。
- **CHAIN_GOAL**：在不改前端交互框架（Vite+React19+TS+Zustand+DOM 渲染）、UI 参照现有 MivoCanvas 的前提下，把 6 个模块从 mock 接成真实、非破坏、可演示。
- **PHASE_GOAL**：见下方 6 个模块（M0/M1/M2/M4/M5/M6），各自 PHASE 目标 = 其 SC 全绿。
- 非目标：M3 图片审核（明早）、登录流、引擎迁移、Figma 导入、gemini 强依赖。

## 前端布局原则（硬约束，UI 骨架不动）
- **左侧 ProjectSidebar 形态保留**：项目分类 / 创建项目 / 「对话区分画布」的形态一定保留，不改结构、不移除。
- **自由画布技术方案不变**（React DOM + Zustand + 现有交互，LeaferJS 空壳不动）。
- **居中底部：通用工具条（M6，参考 loveart）**——floating 居中底部 bar；内容以 `docs/demo/research-toolbar.md` 结果为准，demo 最低挂「生成(M1) / 局部重绘(M2)」入口。
- **右下角：首次生图对话框（M1）**——空画板出图的 prompt 框放画布 bottom-right（不居中）。
- 工具条（居中底部）与首图对话框（右下）位置错开、不互相遮挡；均不覆盖左侧 sidebar。
- `step-M6.md`（通用工具条）纳入执行 DAG；**M6-SC1** 居中底部出现工具条且「生成」按钮可触发 M1、「局部重绘」进入 M2 流程。

## 模块 DAG 与执行次序（串行为主，防文件冲突）
```
Wave1: M0 生成接入(地基)  ──►  Wave2: M5 派生数据模型  ──►  Wave3: M1 主对话框
                                                              │
                                              Wave4: M2 锚点二改(最难) ──► Wave5: M6 通用工具条
                                                              │
                                              Wave4b: M4 Eagle 瀑布流素材库(可与 M2 部分并行)
```
- **M0 先做**：所有生成的地基，不通则 M1/M2 无法验收。
- **M5 紧随**：node/edge 派生数据模型 + store 结构，M1/M2 的结果都要落成"派生新节点+edge"。
- **M1**：最短可演示链路（空画板出图），验证 M0+M5 打通。
- **M2**：风险最高（mask 自建 + 坐标映射），步骤最细，中途多次 dev 验证。
- **M4**：相对独立（瀑布流 library UI + **tag 目录**切换分类 + 看大图 + 复制/多选复制→粘贴到画板 + 中间件读 eagle tag 目录+图片），可在 M2 进行时并行（不同文件）。
- **M6**：完整验收排在 M2 plumbing 之后；`生成` 依赖 M1 右下角对话框，`局部重绘` 依赖 M2 的 `beginMaskEdit(nodeId)`。
- 冲突控制：M0/M5 改 `vite.config.ts` / `canvasStore.ts` / `types/*` —— 必须串行落地并各自 commit 后再进下一波。

## 共享契约（所有步骤遵守，避免各写各的）
### M0 中间件 API（vite dev middleware，Node 侧读 key）
- `POST /api/mivo/generate`（JSON）: `{prompt, imgRatio, quality, n, model}` → `{images:[{b64}]}`（同步）。转发 `https://llm-proxy.tapsvc.com/v1/images/generations`。
- `POST /api/mivo/edit`（multipart）: `image`(原图 PNG/JPEG) + `mask`(可选, PNG RGBA 同尺寸, 透明=改) + `prompt` + `imgRatio` + `quality` + `model` + `reference[]`(可选) → `{images:[{b64}]}`。转发 `/v1/images/edits`。
- key：`.env.local` 的 `MIVO_IMAGE_API_KEY`（gitignored，**禁 VITE_ 前缀**）；`vite.config.ts` 用 `loadEnv(mode, process.cwd(), '')` 在 Node config 阶段读取后注入中间件闭包，前端永不见 key。
- `model` 默认 `gpt-image-2`；`imgRatio`+`quality`→`size` 按 reuse-inventory §M0 映射表；`quality∈{low,medium,high}` 默认 medium。
- 可选：`POST /api/mivo/generate` 试 `model:gemini-3-pro-image`，通则前端加选项，不通仅 gpt-image-2。

### M5 数据模型（types/mivoCanvas.ts + canvasStore）
- 结果节点：`ImageNode` 增 `sourceNodeId?: string`（**kind='edit' 必填→必连一条 edge；kind='generate' 从空画板可空=root 节点无 edge，这是设计非旁路**）、`generation?: {prompt, model, maskBounds?, createdAt}`。
- 派生边：`edges: Edge[]`，`Edge = {id, from:nodeId, to:nodeId, type:'generate'|'edit', prompt, createdAt}`。
- **非破坏铁律**：生成/编辑永远产**新节点** + 连一条派生 edge；原图/原节点绝不覆盖或原地替换。
- 结果放位：复用现有 `chooseAdjacentPlacement`（aiCanvasWorkflow）。

### 生成调用流（M1/M2 共用）
前端共享 `src/lib/mivoImageClient.ts` → 调 M0 中间件 → 拿 `{images:[{b64}]}` → 调 M5 唯一 store action `commitGenerationResult(...)` → 在 action 内存 IndexedDB（assetStorage）→ 建派生 image node（+edge）→ 选中新节点。M1/M2 禁止各自手写 node/edge 逻辑；替换 `canvasStore` 现有 mock `generate*` action 时也走同一提交入口。

## 每模块 SC（浏览器可验收，anti-fill：必须是可点可看的具体行为）
- **M0-SC1** `curl`/M1 触发 `/api/mivo/generate` 返回真实 b64 PNG（非 mock）。
- **M0-SC2** `/api/mivo/edit` 传 image+mask 返回真实编辑图。
- **M0-SC3** key 不出现在 `vite build` 产物 / 前端 network 请求里（Node 侧代理）。
- **M1-SC1** 空画板→主对话框输入 prompt→点生成→画布出现 1 张真实图。
- **M1-SC2** 传参考图+prompt→出现基于参考图的图生图结果。
- **M2-SC1** 选中图→点/框/涂抹标出区域→输入 prompt→出现局部重绘的**新**图节点，**原图仍在**。
- **M2-SC2** 新图与原图之间有可见派生连线（edge）。
- **M2-SC3** 点/框/涂抹三种交互都能生成有效 mask 并影响重绘区域。
- **M4-SC1** 打开素材库面板→展示 Eagle **tag 目录**（分类列表）+ 瀑布流图片；卡片**不显示**每图 tag。
- **M4-SC2** 点击 tag 目录里某个 tag→瀑布流显示该 tag 下被索引的素材（分类切换）。
- **M4-SC3** 拖动素材卡到画布→生成 image node。
- **M4-SC4** 点击卡片→查看大图（lightbox）。
- **M4-SC5** 右键单图复制→画布粘贴出 1 个节点；多选 N 张复制→粘贴出 N 个节点（多图走 app 内部剪贴板）。
- **M5-SC1** M1/M2 产物均为新节点，原节点无覆盖；派生 edge 存在且随节点移动。
- **M6-SC1** 居中底部出现工具条；`生成` 打开/聚焦 M1 右下角对话框；`局部重绘` 在选中 image 时进入 M2 mask overlay；工具条不遮挡 M1、左侧 ProjectSidebar 或画布 zoom controls。

## Review 门
- P3 计划双审：2× gpt-5.5 xhigh 全维度审本 master + 各 step plan（拒绝只读，给可执行修订），claude+gpt 双 APPROVED 才进 P4。
- P5 代码双审：2× gpt-5.5 xhigh 实跑 dev + 审代码，双 APPROVED。
- 每模块完成即 `npm run dev` 自验对应 SC。

## 步骤计划清单（详见各 step 文件）
- `step-M0.md`（生成接入）· `step-M1.md`（主对话框）· `step-M2.md`（锚点二改）· `step-M4.md`（Eagle 瀑布流）· `step-M5.md`（派生模型）· `step-M6.md`（通用工具条）
