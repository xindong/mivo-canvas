GD_REVIEW_DECISION: APPROVED

# 计划审查 #2

## Findings

### [P1] `docs/demo/plan/step-M5.md:18` 缺少 M1/M2 共同依赖的派生结果提交 action

问题：M1/M2 都要求“调用 M5 helper/action”来一次性创建新 image node + edge，但 M5 的精确改动清单只新增 `edges` 类型/持久化，并改现有 mock `generate*` actions 写 edge，没有把这个 helper 加到 `CanvasState` 或给出函数名/参数。按当前计划执行，M2 前置检查会在“必须等待 M5 action”处停住，或各模块各自手写 node/edge，破坏 master 的共享调用流。

证据：M1 明确要求 `generateBesideNode`/`generateIntoAiSlot` “再调用 M5 helper 提交新 image node + edge”（`docs/demo/plan/step-M1.md:23-24`）且“M1 只调用 helper”（`docs/demo/plan/step-M1.md:46`）；M2 前置依赖写了“一个写入派生节点/edge 的 store action”（`docs/demo/plan/step-M2.md:9`），并要求 overlay 只调用例如 `addDerivedImageNode(...)`（`docs/demo/plan/step-M2.md:147-150`、`docs/demo/plan/step-M2.md:160-161`）。但 M5 只在 `CanvasState` 加 `edges`（`docs/demo/plan/step-M5.md:18-20`）并改 `generateVariations/generateImageEdit/generateBesideNode/generateIntoAiSlot/generateFromAnnotation`（`docs/demo/plan/step-M5.md:38-42`），没有新增共享提交 action；当前源码 `CanvasState` 也只有导入/剪贴板/生成 mock actions（`src/store/canvasStore.ts:83-100`、`src/store/canvasStore.ts:1783-2028`）。

具体修法：在 `step-M5.md` 精确补一项 store action，例如 `commitGeneratedImageResult(payload): string` 或 `addDerivedImageNode(payload): string`，写进 `src/store/canvasStore.ts` 的 `CanvasState` 类型、实现和验收。payload 至少包含 `sourceNodeId`、`assetUrl`、`title`、`width/height`、`generation`、`edgeType`、可选 `placement`/`taskId`；实现内部统一 `chooseAdjacentPlacement`、`sourceNodeId`、`generation.createdAt`、`edges:[...state.edges,newEdge]`、选中新节点、失败不建 edge。随后把 `step-M1.md` 和 `step-M2.md` 的“helper/action”统一改成这个确切名字。

### [P2] `docs/demo/plan/step-M4.md:299` M4 SC 编号与 master 不对应，验收清单会错位

问题：master 里 M4-SC3 是拖入画布、M4-SC4 是 lightbox、M4-SC5 是单图/多图复制粘贴；step-M4 把“不显示 per-image tag”命名为 M4-SC3，把拖入/大图/复制依次后移成 M4-SC4/M4-SC5/M4-SC6/M4-SC7。行为大体覆盖了，但编号错位会让明早按 master SC 勾验时把复制粘贴漏测或错测。

证据：master 的 M4-SC1..SC5 在 `docs/demo/plan/master-plan.md:61-65`；step-M4 的 SC 从 `docs/demo/plan/step-M4.md:286-326` 开始，其中 `M4-SC3` 是“图片卡不显示 per-image tag”（`docs/demo/plan/step-M4.md:299-302`），拖入是 `M4-SC4`（`docs/demo/plan/step-M4.md:304-308`），lightbox 是 `M4-SC5`（`docs/demo/plan/step-M4.md:310-313`），复制粘贴拆成 `M4-SC6/SC7`（`docs/demo/plan/step-M4.md:315-326`）。

具体修法：不改功能范围，只重排 step-M4 的验收表：`M4-SC1` 合并 tag 目录 + 瀑布流 + 卡片不显示 per-image tag；`M4-SC2` 保持 tag 切换；`M4-SC3` 改回拖入画布；`M4-SC4` 改回 lightbox；`M4-SC5` 合并右键单图复制和多选 N 张复制粘贴。额外细项可作为 `M4-extra`，不要占用 master SC 编号。

### [P2] `docs/demo/plan/step-M6.md:27` M6 未处理现有 zoom controls，底部中心 UI 有实际重叠风险

问题：M6 只核对了 `CanvasToolDock` 并存和 M1 右下对话框不遮挡，但现有 `.canvas-controls` 也在画布底部；当 AI panel 展开时它会被推到 AI 面板左侧，位置很容易落到画布底部中间。M6 再放 `left:50%; bottom:18px` 的 action bar，会和 zoom controls 在同一底部带上抢位置，浏览器 SC 里可能出现按钮重叠或难点。

证据：源码里 `.canvas-controls` 是 `position:absolute; right:14px; bottom:14px; z-index:5`（`src/App.css:3700-3704`），AI 面板展开时改成 `right: calc(var(--ai-panel-offset) + var(--ai-panel-w) + var(--floating-gap))`（`src/App.css:3716-3718`）；M6 计划新增 `.canvas-ai-action-bar { left:50%; bottom:18px; z-index:7; transform:translateX(-50%) ... }`（`docs/demo/plan/step-M6.md:27`），SC 只要求 M1/M6/sidebar 不重叠（`docs/demo/plan/step-M6.md:57`），没有把 `.canvas-controls` 纳入避让。

具体修法：在 `step-M6.md` 增加明确 CSS 改动和 SC：M6 存在时将 `.canvas-controls` 上移到 action bar 上方，例如 `.canvas-shell.has-ai-action-bar .canvas-controls { bottom: calc(18px + 54px + var(--floating-gap)); }`，或将 zoom controls 固定到 action bar 左侧但保持独立语义。验收必须同时显示 M1、M6、zoom controls，确认三者互不遮挡且 zoom 按钮可点。

### [P3] `docs/demo/plan/step-M5.md:73` 派生 edge 可视节点的 AI context 过滤仍是风险项而非精确改动

问题：M5 用 locked markup arrow node 投影 edge，但 `buildAiContextSnapshot` 的精确改动只说加入 `state.edges`，没有把 `isDerivationEdgeNode` 从 `visibleNodes`、summary 和 legacy connector links 中排除。当前源码会遍历全部 visible nodes 并把 connector node 写进 links/summary（`src/store/aiCanvasWorkflow.ts:84-148`），实现者如果只照精确清单改，AI context 可能出现 edge 数据 + markup connector 双份。

具体修法：把 `isDerivationEdgeNode` 过滤从风险项提升到精确改动：`visibleContentNodes = visibleNodes.filter(!isDerivationEdgeNode)` 用于 summary、nodes map 和 legacy links；`edges` 字段仍来自 `state.edges`。

### [P3] `docs/demo/plan/master-plan.md:8` master 顶部目标仍写 “Eagle 搜索拖入”

问题：PIPELINE 的最终验收和 M4 计划已经改成 tag 目录 + 瀑布流 + 复制粘贴，且明确不做搜索；master 顶部目标链仍写“Eagle 搜索拖入”，容易让后续 reviewer 误以为搜索仍是验收项。

证据：PIPELINE §0 写的是 tag 目录、瀑布流、右键复制、多选复制、拖入且“不做搜索”（`docs/demo/PIPELINE.md:8-12`）；step-M4 非目标也写“不做搜索框”（`docs/demo/plan/step-M4.md:13-14`）；master 顶部仍写“Eagle 搜索拖入”（`docs/demo/plan/master-plan.md:8`）。

具体修法：把 master line 8 改为“Eagle tag 目录 + 瀑布流 + 复制粘贴/拖入”，避免和 PIPELINE 真相源冲突。

## 已核对但未形成阻塞

- M0 key 安全机制可接受：计划要求 `.env.local` 的 `MIVO_IMAGE_API_KEY` 只由 `vite.config.ts` Node middleware `process.env` 读取，前端只 fetch `/api/mivo/*`（`docs/demo/plan/master-plan.md:36-40`、`docs/demo/plan/step-M0.md:12-20`），SC 也检查浏览器 Network 无 `Authorization`（`docs/demo/plan/step-M0.md:37`）。
- M2 mask 语义拆得足够细：计划固定“透明=要改，不透明=保留”（`docs/demo/plan/step-M2.md:5`），`buildEditMaskBlob` 先 alpha=255 再 `destination-out` 清选区 alpha（`docs/demo/plan/step-M2.md:54-58`），并要求 alpha 自检（`docs/demo/plan/step-M2.md:200-205`）。坐标映射也覆盖 `object-fit: contain` 和 crop（`docs/demo/plan/step-M2.md:46-58`、`src/App.css:3536-3546`、`src/canvas/CanvasNodeView.tsx:479-487`）。
- M4 内部剪贴板方案成立：现有 paste 入口可改为 asset clipboard 优先（`src/canvas/useCanvasInteractionController.ts:1371-1398`），`importImageUrlToCanvas` 已能把同源 Eagle file URL fetch 成 File 再 `saveImportedAsset` 落图（`src/lib/canvasAssetImport.ts:396-419`）。
- anti-fill 检查未发现阻塞占位词；`rg "完善|优化|增强|系统性"` 仅命中 step-M4 的非必须 Cmd+C 说明和普通标题/依赖用语。

## Round 2

GD_REVIEW_DECISION: APPROVED

### 复核范围

| 检查项 | 结论 | 证据 |
|---|---|---|
| M5 共享派生 action | 通过 | `step-M5.md` 已把 `commitGenerationResult(...)` 写入 PHASE_GOAL、`CanvasState`、实现步骤和 SC（`docs/demo/plan/step-M5.md:3-4`、`:21`、`:41`、`:61-72`）；M1/M2 都明确只调用该 action，不手写 node/edge（`docs/demo/plan/step-M1.md:24-27`、`:47`，`docs/demo/plan/step-M2.md:5`、`:102`、`:149`、`:212-224`）。 |
| M4 SC 编号 | 通过 | master 的 M4-SC1..SC5 为 tag 目录+瀑布流+不显示每图 tag、tag 切换、拖入、lightbox、复制粘贴（`docs/demo/plan/master-plan.md:63-67`）；`step-M4.md` 已按同一编号排列（`docs/demo/plan/step-M4.md:286-316`）。 |
| M6 zoom 避让 | 通过 | `step-M6.md` 明确新增 `.canvas-ai-action-bar ~ .canvas-controls { bottom: calc(18px + 54px + var(--floating-gap)); }` 上移 zoom controls，并把 M1/M6/zoom 同屏可点击纳入验收（`docs/demo/plan/step-M6.md:29`、`:50`、`:59`、`:69`）。 |
| M5 AI context 过滤 | 通过 | `step-M5.md` 已把 `edges` 加入 `AiContextState`/snapshot，并在 `buildAiContextSnapshot` 精确改动中要求过滤有效端点、输出显式 `edges`、用 `isDerivationEdgeProjectionNode` 排除可视 edge markup 对 summary/nodes/legacy links 的污染（`docs/demo/plan/step-M5.md:11`、`:18-19`、`:47`、`:64`、`:79`）。当前源码仍是 M5 前基线，确实没有 edges 输入（`src/store/aiCanvasWorkflow.ts:8-13`、`:84-187`），计划已覆盖需改点。 |
| Eagle 搜索文案 | 通过 | master 顶部目标已改为 “Eagle tag 目录 + 瀑布流 + 复制粘贴/拖入”（`docs/demo/plan/master-plan.md:8`），M4 也明确不新增 `/api/mivo/eagle/search`、不做搜索框（`docs/demo/plan/step-M4.md:13-14`、`:21`、`:86-88`、`:234-236`）。master 未发现 “Eagle 搜索” 残留。 |
| M2 mask 语义与 anti-fill 抽查 | 通过 | M2 仍固定 `透明=要改，不透明=保留`，mask 先 alpha=255 再对选区 `destination-out` 清 alpha，SC 要求 alpha=0/255 自检（`docs/demo/plan/step-M2.md:5`、`:21-22`、`:56-57`、`:200-205`、`:249-252`）。未发现会阻塞 SC 的空泛 anti-fill。 |

### 前序 finding 逐条状态

- P1 `step-M5` 缺共享派生提交 action：已修复。`commitGenerationResult(payload)` 已成为 M5 唯一提交入口，且 M1/M2 调用名一致。
- P2 `step-M4` SC 编号错位：已修复。`step-M4` 的 M4-SC1..SC5 与 master 对齐。
- P2 `step-M6` 未避让 zoom controls：已修复。计划和验收都覆盖 `.canvas-controls` 上移与可点击。
- P3 M5 AI context edge 过滤只在风险项：已修复。已提升到精确改动清单。
- P3 master “Eagle 搜索拖入” 残留：已修复。master 目标链已改为 tag 目录 + 瀑布流 + 复制粘贴/拖入。

### 残留 / 新增 findings

无。

### 抽查结论

所有 master SC 均有浏览器可点/可看的验收路径；M1/M2/M5 的非破坏生成链路已统一到 `commitGenerationResult(...)`；M4 保留 tag 目录、CSS columns、lightbox、复制粘贴和拖拽的可验收闭环；M6 与 zoom controls 的布局冲突已有明确 CSS 和 SC。Round 2 未发现 P1/P2/P3 残留或新增问题。
