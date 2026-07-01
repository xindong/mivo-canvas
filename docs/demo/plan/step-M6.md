# M6 通用工具条步骤计划

## PHASE_GOAL
实现画布居中底部 floating loveart 式通用工具条，只承载 3 个 demo 入口：`选择/移动`、`生成`、`局部重绘`。工具条相对画布容器居中底部，不遮挡左侧 `ProjectSidebar`，与 M1 右下角首次生图对话框错开；`生成` 打开/聚焦 M1 右下对话框，`局部重绘` 进入 M2 锚点 mask overlay 流程，`选择/移动` 回到现有 select 工具。

## 精确改动清单
| 文件 / 符号 | 改动 |
|---|---|
| 新建 `src/canvas/CanvasAiActionBar.tsx` | 新增居中底部 AI 动作条组件。props 固定为 `{ selectedNode?: MivoCanvasNode; maskEditActive?: boolean; onOpenGeneratePanel(): void; onStartMaskEdit?: (nodeId: string) => void; onCancelMaskEdit?: () => void }`。组件内用 `useCanvasStore` 读取 `activeTool` 和 `setActiveTool`。 |
| `src/canvas/CanvasAiActionBar.tsx` `选择/移动` 按钮 | 用现有 select 工具：`setActiveTool('select')`；若 M2 overlay 正在编辑，先调用 `onCancelMaskEdit?.()`，避免 overlay 截获 pointer。按钮 active 条件是 `activeTool === 'select' && !maskEditActive`。 |
| `src/canvas/CanvasAiActionBar.tsx` `生成` 按钮 | 点击时 `setActiveTool('select')`，再调用 `onOpenGeneratePanel()`；不在 M6 内直接调用 `generateIntoAiSlot` / `generateBesideNode`，生成 prompt、reference staging、ratio/quality、IndexedDB 落图仍归 M1（见 `docs/demo/plan/step-M1.md:16-35`）。 |
| `src/canvas/CanvasAiActionBar.tsx` `局部重绘` 按钮 | 只在 `selectedNode?.type === 'image'` 时 enabled；点击时 `setActiveTool('select')`，再调用 `onStartMaskEdit?.(selectedNode.id)`。无选中 image 时 disabled，title 固定为 `Select an image first`。M2 overlay 入口沿用 `onStartImageMaskEdit(nodeId)` / `beginMaskEdit(nodeId)` 方案（见 `docs/demo/plan/step-M2.md:94-107`、`:109-128`）。 |
| `src/App.tsx:23-30` `App` state | 新增 `const [aiPanelFocusRequestId, setAiPanelFocusRequestId] = useState(0)`；新增 `openGeneratePanel = useCallback(() => { setAiPanelOpen(true); setAiPanelFocusRequestId((id) => id + 1) }, [])`。 |
| `src/App.tsx:152-158` canvas workspace | 把 `<MivoCanvas key={sceneId} onOpenDetails={...} />` 改为传 `onOpenGeneratePanel={openGeneratePanel}`；把 `<AIToolPanel open={aiPanelOpen} ... />` 改为传 `focusRequestId={aiPanelFocusRequestId}`。`AIToolPanel` 仍在 `work-surface` 内、右下角浮层位置由 M1 控制。 |
| `src/app/AIToolPanel.tsx:16-21` `AIToolPanelProps` | 增加 `focusRequestId?: number`。 |
| `src/app/AIToolPanel.tsx:21-48` component state / refs | 新增 `promptRef = useRef<HTMLTextAreaElement | null>(null)`；`useEffect(() => { if (open && focusRequestId) promptRef.current?.focus() }, [open, focusRequestId])`。 |
| `src/app/AIToolPanel.tsx:167-175` prompt textarea | 给 `<textarea>` 加 `ref={promptRef}`；M6 `生成` 按钮只负责打开/聚焦这里，后续 `立即生成` 仍走 `runPrimaryGeneration`（`src/app/AIToolPanel.tsx:67-84` / `:258-265`）。 |
| `src/canvas/MivoCanvas.tsx:16-22` imports | 新增 `import { CanvasAiActionBar } from './CanvasAiActionBar'`。 |
| `src/canvas/MivoCanvas.tsx:35-37` `MivoCanvasProps` | 增加 `onOpenGeneratePanel?: () => void`。 |
| `src/canvas/MivoCanvas.tsx:54-60` `isCanvasChromeTarget` | 在 selector 中加入 `.canvas-ai-action-bar`，同时 `CanvasAiActionBar` 根元素加 `data-canvas-ui="true"`，防止点击工具条触发画布 pointer/拖拽。 |
| `src/canvas/MivoCanvas.tsx:102-126` state / selected node | 在 M2 已落地后复用 `maskEditNodeId`、`beginMaskEdit(nodeId)`、`cancelMaskEdit()`；M6 只读取 `selectedNode = selectedNodeId ? visibleNodes.find(...) : undefined`。若 M2 尚未落地，`onStartMaskEdit` 先传 `undefined` 并保持按钮 disabled，直到 M2 plumbing 合入。 |
| `src/canvas/MivoCanvas.tsx:422-449` canvas shell render | 在 `<CanvasToolDock previewTool=... />` 后插入 `<CanvasAiActionBar selectedNode={selectedNode} maskEditActive={Boolean(maskEditNodeId)} onOpenGeneratePanel={onOpenGeneratePanel || (() => undefined)} onStartMaskEdit={beginMaskEdit} onCancelMaskEdit={cancelMaskEdit} />`。 |
| `src/canvas/CanvasToolDock.tsx:15-98` `CanvasToolDock` | 不改。现有 V/H/T/F/markup 工具坞继续只处理基础画布工具和 shortcuts。 |
| `src/canvas/canvasToolRegistry.ts:44-169` `canvasToolRegistry` | 不改。M6 的 `生成` / `局部重绘` 不新增到 `ToolId` registry，避免改变 `runtimeToolFor` 和键盘 shortcut 行为。 |
| `src/canvas/actions/canvasActionModel.ts:148-206` `imageAiEditActionsFor` | 不在 M6 中改；M2 已计划把 `select-area-edit` 接入 `onStartImageMaskEdit`。M6 的 `局部重绘` 直接复用 M2 的 `beginMaskEdit(nodeId)`，不是再走旧 `beginImageEditPrompt(..., 'area-edit')`。 |
| `src/App.css:1743-1756` `.work-surface` / `.canvas-shell` | 保持 `work-surface` 和 `canvas-shell` 为定位容器；M6 bar 挂在 `canvas-shell` 内，`position:absolute` 相对画布本体，不相对全局 viewport。 |
| `src/App.css:1823-1837` `.canvas-tool-dock` 后 | 新增 `.canvas-ai-action-bar`：`position:absolute; left:50%; bottom:18px; z-index:7; transform:translateX(-50%); display:flex; align-items:center; gap:6px; padding:7px; background:rgba(255,250,240,.92); border:1px solid var(--line); border-radius:999px; box-shadow:var(--shadow); backdrop-filter:blur(14px);`。 |
| `src/App.css:1839-1918` 工具按钮样式附近 | 新增 `.canvas-ai-action-bar button`、`.canvas-ai-action-bar button.active`、`.canvas-ai-action-bar button:disabled`；按钮尺寸固定 `42px`，含 icon + 可选文字；文字在小屏隐藏，避免挤压。 |
| `src/App.css:3700-3722` `.canvas-controls` zoom 控件 | 现有 zoom 控件在画布右下 `bottom:14px`，AI panel 展开时通过 `right: calc(var(--ai-panel-offset) + var(--ai-panel-w) + var(--floating-gap))` 挪到面板左侧。M6 增加 `.canvas-ai-action-bar ~ .canvas-controls { bottom: calc(18px + 54px + var(--floating-gap)); }`，让 zoom 控件上移到居中底部 action bar 上方；保持现有 right 避让 AI panel 的逻辑不变。 |
| OD UI 参考 | 样式只借鉴 OD `apps/web/src/components/PreviewDrawOverlay.tsx:960-983` 的底部 toolbar 核心样式、`:985-1118` 的关闭/框选/画笔/提交组合、`:1219-1250` 和 `:1280-1389` 的 tooltip / bottom dock；不搬 OD iframe / portal / comments 管线。 |
| `src/App.css:3767-3782` `.ai-panel` 关系 | 不改 M1 的右下角对话框定位。M6 bar 在底部中心，M1 panel 在右下角；若宽度小于 980px，CSS 只缩短 M6 文案/宽度，不把 M6 移到右下。 |
| `src/App.css:4706-4713` `@media (max-width: 980px)` | 增加 `.canvas-ai-action-bar { max-width: min(360px, calc(100% - 28px)); }`；隐藏按钮文字，仅保留 icon + `aria-label`。 |
| `src/App.css:4751-4767` `@media (max-width: 720px)` | 保持 `.canvas-tool-dock` 左上位置；新增 `.canvas-ai-action-bar { bottom: 12px; }`。若 M1 panel 打开造成窄屏重叠，优先由 M1 panel 自身滚动/覆盖处理，M6 不改为右下。 |

## 设计点：与现有工具坞并存还是整合
**方案：并存，不整合。**

现有 `CanvasToolDock` 是左侧竖向基础画布工具坞：从 `canvasToolRegistry` 渲染 `select/hand/text/frame/markup-*`（`src/canvas/CanvasToolDock.tsx:31-97`，`src/canvas/canvasToolRegistry.ts:44-169`），并直接写 `activeTool`。它服务 V/H/T/F/markup 这些编辑工具和 keyboard shortcut。

M6 是新的居中底部 AI 动作条，只承载 `选择/移动`、`生成`、`局部重绘` 三个 demo 入口。`选择/移动` 复用 `setActiveTool('select')`；`生成` 打开 M1；`局部重绘` 调 M2 overlay。把 M6 合进 `canvasToolRegistry` 会把 AI 动作伪装成 runtime tool，增加 `ToolId`、shortcut、interaction controller 的分支，不符合最小复杂度。位置上二者也不冲突：现有工具坞在左上/左侧（`src/App.css:1823-1837`），M6 在底部中心。

## 依赖与落地顺序
1. 先确认 M1 已有右下角对话框定位、`runPrimaryGeneration` 和 reference/ratio/quality 逻辑；M6 只打开/聚焦 M1，不复制 M1 生成逻辑。
2. 先确认 M2 已有 `beginMaskEdit(nodeId)` / `maskEditNodeId` / `cancelMaskEdit()`；若 M2 尚未落地，先实现 M6 壳和 `生成`，`局部重绘` 按钮保持 disabled，等 M2 合入后接线。
3. 新建 `CanvasAiActionBar.tsx`，先接 `选择/移动` 和 disabled 状态。
4. 改 `App.tsx`：新增 `openGeneratePanel` 和 `aiPanelFocusRequestId`，把回调传给 `MivoCanvas`，把 focus request 传给 `AIToolPanel`。
5. 改 `AIToolPanel.tsx`：加 `focusRequestId` 和 prompt textarea focus，不改 `runPrimaryGeneration`。
6. 改 `MivoCanvas.tsx`：挂载 `CanvasAiActionBar`，接 `onOpenGeneratePanel` 和 M2 `beginMaskEdit`。
7. 补 `.canvas-ai-action-bar` CSS，确认 `data-canvas-ui="true"` 和 `isCanvasChromeTarget` 都覆盖该 bar。
8. 补 `.canvas-ai-action-bar ~ .canvas-controls`，确认现有 zoom 控件上移后仍可点击，且仍按 AI panel 展开/折叠避让右侧面板。

## SC 验收
| master SC | 浏览器怎么点 | 看到什么算通过 |
|---|---|---|
| M6-SC1 居中底部出现工具条 | 打开 canvas workspace，保持左侧 `ProjectSidebar` 展开。 | 画布底部中心出现 floating bar，只有 `选择/移动`、`生成`、`局部重绘` 三个按钮；左侧现有 `CanvasToolDock` 仍在，ProjectSidebar 未被遮挡。 |
| M6-SC1 `生成` 触发 M1 | 点击 M6 `生成`。 | M1 右下角首次生图对话框打开；prompt textarea 获得焦点；工具条仍在底部中心，不遮挡 M1 右下对话框。 |
| M6-SC1 `局部重绘` 进入 M2 | 选中一个 image node，点击 M6 `局部重绘`。 | 当前 image 上进入 M2 mask overlay；能看到 M2 的点/框/涂抹工具和 prompt/提交区域；未选 image 时该按钮 disabled。 |
| `选择/移动` 回到基础画布操作 | 进入 M2 overlay 或任意非 select 工具后，点击 M6 `选择/移动`。 | `activeTool` 变为 `select`；现有左侧 `CanvasToolDock` 的 Select 按钮显示 active；可以拖动/选择画布节点。 |
| 与 M1/M6/zoom 布局不遮挡 | 同时显示 M1 右下对话框、M6 工具条和画布 zoom controls。 | M6 在底部中心，M1 在右下角，两者不重叠；zoom controls 位于 M6 上方或侧上方且四个 zoom 按钮可点击；ProjectSidebar 的项目分类 / 创建项目 / 对话区分画布入口仍可点击。 |

## 风险与回退
| 风险 | 处理 / 回退 |
|---|---|
| M6 点击触发画布拖拽或取消选择 | 根元素加 `data-canvas-ui="true"`；`isCanvasChromeTarget` 加 `.canvas-ai-action-bar`；按钮 handler 里 `event.stopPropagation()`。回退时先只保留视觉 bar，不接行为。 |
| 与现有 `CanvasToolDock` 职责混淆 | 不改 `canvasToolRegistry`，不新增 `ToolId`，M6 按钮只调用 action callback。若用户需要完整工具坞重排，另开 M6b，不在本 demo 最小闭环内做。 |
| M1 未提供 focus prop | `生成` 按钮先只 `setAiPanelOpen(true)`；`focusRequestId` 可随后补上，不影响打开 M1 的 SC。 |
| M2 未落地导致 `局部重绘` 无入口 | 按钮 disabled 并显示 `Select an image first` 或 `Mask edit is not ready`；M2 合入后再接 `beginMaskEdit`，不新建第二套局部重绘入口。 |
| M1 右下对话框与 M6 底部中心在窄屏重叠 | 桌面按 master 验收；`max-width: 980px` 下隐藏 M6 文案、缩短 bar 宽度。若仍重叠，优先保持 M6 底部中心和 M1 右下，不把 M6 移到右下。 |
| M6 与现有 zoom controls 重叠 | 使用 `.canvas-ai-action-bar ~ .canvas-controls` 把 zoom controls 上移到 action bar 上方；若窄屏仍压住 M1 panel，优先保留 zoom controls 可点击，允许把 zoom controls 再上移一档，不把 M6 移到右下。 |
| 图标/文字挤压 | 三个按钮固定尺寸，文字只在宽屏显示；所有按钮保留 `aria-label` 和 `title`，小屏只显示 lucide icon。 |
