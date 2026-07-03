# UI 验收返工 — 盘查报告汇总（Round 2）

> 2026-07-03 用户浏览器实测发现明显 UI bug，lead 派 3 个 gpt-5.5 xhigh worker 只读盘查。
> 本文件收集三份盘查原始结论，供 lead 汇总优先级用。修复派 gpt-5.5 xhigh 执行，lead 最终对照参考图真机验收。

## 用户已明确的目标形态（参考图诉求）

1. 输入框做成 lovart / 线上 Mivo 那样 —— **上下顶满**大输入区（参考图 2）
2. 模型选择器放**左下角**（当前静态 `GPT` chip 的位置），做成带模型标识的 **icon 按钮**，点开有 **Image / Video 两个 tab**（参考图 4、5）
3. 比例选择器 = 模型选择器**右边的独立 icon**，点开列当前模型合法比例
4. 输入框支持**上下滚动**查看上下文
5. **EnhanceParamCard 只读** —— agent 增强提示词过程里不该有比例/模型强度等玩家可操作控件（参考图 6）

---

## 盘查 A — audit-ui-layout（UI 形态/布局 vs 参考图）

Dev server 127.0.0.1:5200，Playwright 真机 + localStorage 注入长历史。截图产物在 `_tmp/audit-ui-out/`。

### 覆盖结论
- #1 输入框：**不达标**。当前 3 行小 textarea，未上下顶满。
- #2 模型选择器：**不达标**。左下角 `GPT` 是静态 span；真正模型选择被塞进参数弹层，且不是 Image/Video tab。
- #3 比例选择器：**不达标**。比例只在参数弹层里，没有模型右侧独立 icon 入口。
- #4 消息流滚动：桌面可滚（scrollHeight 3516 > clientHeight 467）；但窄屏布局破坏后滚动区域视觉不可用（见 #7）。
- #5 EnhanceParamCard：**不达标**。比例/质量 pill 是可点击按钮，会触发 regenerate。
- #6 通用溢出/响应式：严重弹层裁剪与窄屏错位。

### 问题清单

| # | 优先级(worker 评) | 问题 | 代码位置 | 截图 |
|---|---|---|---|---|
| A1 | P0 | 参数弹层被 `.ai-panel { overflow:hidden }` 裁剪，桌面只能看到弹层底部，比例/质量区域实际不可见 | `App.css:4434-4438` panel overflow / `App.css:6082-6097` popover absolute / `ChatComposer.tsx:221-223` popover 挂 composer 内 | `02-params-popover-desktop.png` |
| A2 | P1 | 输入框过小，非 lovart/线上大多行输入区，未上下顶满（composer 139px，textarea 74px，rows=3，min-height 64px，底部操作区另起一行） | `ChatComposer.tsx:172-183` rows=3 / `App.css:5922-5928` grid / `App.css:5986-5999` min/max height | `01-empty-desktop.png` |
| A3 | P1 | 左下角 `GPT` 是不可聚焦不可点击的静态 SPAN chip，非模型选择器 | `ChatComposer.tsx:137` modelLabel / `:185-196` span+settings / `App.css:6016-6028` | `01-empty-desktop.png` |
| A4 | P1 | 模型列表塞在 ComposerParamsPopover，结构是 Image/Video 纵向 group 非 tabs，且和比例/质量混同一弹层；Video 模型显示为 disabled 长 ID | `ComposerParamsPopover.tsx:56-134` / `:98-134` group / `modelCapabilities.ts:17-48` | `02-params-popover-desktop.png` |
| A5 | P1 | 比例选择无独立入口，只能经"生成参数"齿轮进入 | `ChatComposer.tsx:188-196` 单参数按钮 / `ComposerParamsPopover.tsx:57-78` ratio grid / `App.css:6114-6143` | `01/02.png` |
| A6 | P1 | EnhanceParamCard 比例/质量 chip 是操作控件会触发 regenerate，hover 变强按钮 | `EnhanceParamCard.tsx:37-47` regenerateWithParams / `:88-110` ratio/quality button / `App.css:5776-5784` | `05-enhance-chip-hover.png` |
| A7 | P0(窄屏) | 窄屏响应式严重错位：sidebar 仍占 240px，chat panel 压成 126px，子内容/弹层溢出视口外（390×844 下 panel width=126 但子元素 width=177 right=430>390） | `App.tsx:26-30` 默认 open / `App.css:30-31` 两列 grid / `:4428-4438` panel absolute / `:5483-5490`/`:5547-5602` 断点未处理 chat panel | `06/07-narrow.png` |
| A8 | P2 | ChatPanel 空态/短历史自适应收缩成底部小卡片（空态 276px 贴底），不像稳定右侧对话面板 | `App.css:4428-4438` 只有 max-height 无 height/min-height / `:5606-5608` | `01 vs 03.png` |
| A9 | P3 | 弹层无 Escape 关闭/焦点管理；模型 chip 不可键盘进入（只监听 document pointerdown） | `ComposerParamsPopover.tsx:45-52` / `ChatComposer.tsx:185-196` | `02.png` |

### worker 建议方向（供修复 worker 参考）
- A1：重构为独立 ModelPopover / RatioPopover，用 portal 或固定在 panel 可见区；滚动只交给 `.chat-message-list`，别让 `.ai-panel` 负责裁剪弹层。
- A2：composer 做成大输入容器，textarea flex/grid 占满上方主体，底部 icon toolbar 内嵌输入区底部；默认 min-height 120-160px 按 panel 高度响应。
- A3：`.chat-model-chip` 改 button，展示当前模型短名；点击打开模型弹层；补 hover/focus/active。
- A4：拆 `ModelSelectorPopover`，内部 tab state（Image=gpt-image-2/gemini-3-pro-image，Video=两个 seedance）；列表用友好名，不截断长 ID。
- A5：模型 button 右侧加独立 aspect-ratio icon button；弹层只列当前 `MODEL_CAPABILITIES[selectedModel].ratios`+auto；选完写 `paramOverrides.imgRatio`。
- A6：比例/质量改 span/只读 badge；移除卡片内 regenerate 入口。保留"深度思考/增强 Prompt"折叠可以，但不承载参数操作。
- A7：小屏自动 collapse/sidebar overlay；chat panel 改 fixed/inset 或独占右侧抽屉，宽度按 viewport 计算；composer actions 紧凑但不超出 panel。
- A8：展开态设稳定 height/min-height（如 `min(680px, calc(100% - 28px))` 或 full-height drawer），空态也保留消息区+大输入区比例。
- A9：拆分弹层时补 Escape close、`aria-expanded/controls`、弹层内首项聚焦/roving focus。

### 滚动专项（目标 #4）
- 桌面基本通过：`ChatMessageList.tsx:21-35` 有 scroll ref/auto-scroll，`App.css:5610-5617` `overflow-y:auto`，注入 29 条可从底滚到顶。
- 仅限桌面正常宽度；窄屏因 A7 布局裁剪，DOM 有 scrollHeight 但可视区被截断，实际不可用。

---

## 盘查 B — audit-func-bugs（功能完整性 + Source node not found 根因）

真机复现（5300 端口），证据在 `_tmp/audit-func-out/`（audit-results.json + 9 截图）。

### B1 [P0] Source node not found — 生成链路不是 scene-scoped
三条复现路径全中：① 文生图 pending 时切 scene 再切回；② 图生图 pending 时删源图；③ regenerate pending 时切 scene。
- 直接根因：`sendMessage`/`regenerateWithParams` 带了 sceneId，但画布写入全走 **active canvas**：
  - `chatStore.ts:184-194`/`:262-272` 先调生成 action；`canvasStore.ts:559-594` `patchActiveCanvas` 永远写 `state.sceneId`
  - await 结束后 `canvasStore.ts:2045-2054` `commitGenerationResult` 在**当前** nodes 里找 sourceNodeId → 用户已切 scene 就抛
  - chatStore 跨画布 guard（`:196-209`/`:274-282`）位置太晚，await 已先抛
  - catch 也写 active canvas（`canvasStore.ts:2437-2455`）→ 失败任务写错 scene，原 scene 的 AI Slot 卡 generating
- 修法：生成事务 scene/canvas scoped——slot 创建、running task、commit、failed/canceled 全带 sceneId patch `canvases[sceneId]`；源删除友好降级；跨 scene 完成给 notice。

### B2 [P1] retry 丢参考图（图生图重试变文生图）
- 复现：上传参考图 → edit 500 → 重试 → 请求从 `edit(image:1)` 变 `generate`
- 根因：File 只在 send 闭包里；message 不存 reference（`chatStore.ts:22-35`/`:105-114`/`:341-346`）
- 修法：发送前参考图存 asset storage，message 记 reference asset ids；retry 按原模型/参数/source/references 重放

### B3 [P1] regenerateWithParams 丢 source/reference（参考图结果重生成变纯文生图）
- 根因：只取 `targetMsg.enhance/text`，无 generation context 快照（`chatStore.ts:235-272`）

### B4 [P2] regenerateWithParams slot 位置 typo：`{x: slotX, y: slotX}`（`chatStore.ts:265-266`）

### B5 [P2] retry 复制 user message + 遗留失败 AI Slot
- 根因：retry = 删 assistant + 全新 send（`chatStore.ts:334-346`），非重跑原 attempt

### B6 [P2] generateBesideNode 宽松 fallback：显式 sourceNodeId 不存在时静默 fallback 到当前选中/第一个节点（`canvasStore.ts:2279-2285`）

### B7 [P2] mask 局部重绘继承同一 scene/source commit 风险（`MivoCanvas.tsx:302-333` + commit 依赖 active scene）——happy path 目前通过

### 已验证 OK
基本文生图双回流（node 0→3、edge 0→1、chat 有图）；模型切换+比例/质量覆盖 payload 正确（gemini+21:9+high）；mask happy path（image+mask 双文件、+node+edge+notice）。

---

## 盘查 C — audit-mask-anchor（锚点圆圈→黑点根因）

真机复现（5400 端口，抓包 dump 提交给 `/api/mivo/edit` 的 image/mask），证据在 `_tmp/audit-mask-out/`。

### 根因判定：B —— 点选锚点状态被当作实际 mask 区域提交（A「原图被 overlay 污染」排除）

- `received-image.png`：提交的原图干净（`alphaLt250=0`、`darkOpaque=0`），**没有**圆圈/黑点 —— 不是 SVG 圆圈被画进原图。
- `received-mask.png`：mask = 黑色不透明背景 + 一个**透明圆**，bbox `{x:244,y:198,w:96,h:96}` —— 正好是点选默认半径 48px 的直径。
- mask 语义（`imageMaskGeometry.ts:198-203`）：整张填黑后 `destination-out` 挖透明 → 透明 = 要重绘。**点选锚点的视觉圆 = 上游看到的编辑洞**。
- 上游在这个 96px 圆内重绘；提示词"换发色"不约束该小圆区域 → 常生成黑色实心点。

### 代码链路
| 环节 | 位置 |
|---|---|
| 点选默认半径 48px | `ImageMaskEditOverlay.tsx:135` |
| 点选直接 commit 为 region（无 UI-only/mask 分离） | `ImageMaskEditOverlay.tsx:346-348` |
| 同一 region 渲染为视觉圆圈 | `ImageMaskEditOverlay.tsx:87-94`/`:512-516` + `App.css:4064-4068` |
| 提交时同一 regions 进 buildEditMaskBlob | `ImageMaskEditOverlay.tsx:389-393` |
| point region 画成 mask 圆洞 | `imageMaskGeometry.ts:158-163`、`:198-203` |
| 原图读取无 DOM 截图路径（干净） | `canvasImageSource.ts:9-25`、`MivoCanvas.tsx:312-315` |
| proxy 不改像素 | `mivoImageClient.ts:87-105`、`vite.config.ts:392-410/420-428` |

### worker 修法方向
1. 点选锚点拆成 **UI-only annotation state**，不进 `regions`/`buildEditMaskBlob`/`ImageMaskSubmitPayload.mask`。
2. `buildEditMaskBlob` 只吃真实 mask 几何（框选、涂抹）。
3. 若保留"点选"入口：点选只做语义提示/分割种子，提交前必须转成真实目标区域 mask，或禁止 point-only 直接提交。
4. 保持 `readCanvasImageBlob` 的 asset-fetch 路径不动；加抓包回归：point anchor 提交时 mask 不应出现同半径圆洞。

---

---

## Lead 汇总优先级清单（2026-07-03 定稿）

### P0 — 功能信任破坏
| # | 问题 | 来源 |
|---|---|---|
| P0-1 | Source node not found：生成事务非 scene-scoped（切 scene/删源图必炸 + slot 卡死） | B1+B7 |
| P0-2 | mask 点选锚点被当 mask 圆洞提交 → 黑点印图 | C |
| P0-3 | 参数弹层被 .ai-panel 裁剪，桌面实际不可操作 | A1 |

### P1 — 目标 UI 形态（用户参考图）+ 上下文完整性
| # | 问题 | 来源 |
|---|---|---|
| P1-1 | Composer 大输入区顶满 + ChatPanel 稳定高度 | A2+A8 |
| P1-2 | 模型选择器 = 左下角 icon 按钮 + Image/Video tabs 弹层 | A3+A4 |
| P1-3 | 比例选择器 = 模型右侧独立 icon 弹层（内含质量段选） | A5 |
| P1-4 | EnhanceParamCard 全只读（删卡内 regenerate 入口；regenerateWithParams 无调用方则删除，B3/B4 随之消解） | A6+B3+B4 |
| P1-5 | retry 完整上下文（存 reference asset ids + generation 快照；不复制 user message；失败 slot 复用/清理） | B2+B5 |

### P2
| # | 问题 | 来源 |
|---|---|---|
| P2-1 | generateBesideNode 显式 source 严格校验，不静默 fallback | B6 |
| P2-2 | 新弹层补 Escape/焦点管理基础 a11y（随 P1-2/P1-3 顺带） | A9 |

### P3 / 本轮不做（deferred）
- A7 窄屏响应式：demo 目标桌面端，本轮只保证 ≥1024px 无溢出，完整响应式暂缓。

### 执行安排
单 worker（audit-func-bugs 转修复，gpt-5.5 xhigh）三阶段串行，规避多 worker 同仓 git 互踩：
S1 UI 形态（P0-3 + P1-1~4 + P2-2）→ S2 功能 scene-scoping/retry（P0-1 + P1-5 + P2-1）→ S3 mask 锚点（P0-2）。
每阶段独立 commit + build/lint 门 + 截图证据；e2e 断言同步更新；最后全量 e2e 绿。Lead 对照参考图逐条真机验收视觉结果。
