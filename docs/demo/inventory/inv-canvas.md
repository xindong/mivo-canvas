# MivoCanvas CODE-INVENTORY Part: Canvas / Interaction

> Snapshot: 2026-07-02. Source inspected under `src/canvas/**` plus necessary canvas store data-flow references.
> Authority docs read first: `docs/demo/DEMO-STATUS.md`, `docs/demo/review/context-handoff-2026-07-02.md`.
> Boundary: this file is an inventory only. No source files were changed. `_tmp/` was not touched.

## 画布层架构总览

### LeaferJS 与 DOM 渲染管线

- `MivoCanvas.tsx` 是画布主入口。它创建 `Leafer` 实例并挂载到 `.canvas-host`，负责 resize 和生命周期销毁。
- 当前可见节点渲染主要走 DOM 管线：`.dom-canvas-layer` 通过 `transform: translate(...) scale(...)` 承载 `CanvasNodeView`、selection bounds、snap guides、creation preview、crop/mask overlays。
- 渲染优化在 `MivoCanvas.tsx` 内完成：根据 viewport 和 `canvasRenderOverscanPx = 520` 计算 `renderedNodes`，但选中、裁剪、mask edit、右键菜单相关节点会被 pin 住，避免交互态卸载。
- 节点类型到渲染分支由 `nodeTypes/canvasNodeRegistry.ts` 的 `renderKindForNode` 决定，实际 DOM 视图由 `CanvasNodeView.tsx` 完成。

### 交互控制器如何分发

- `useCanvasInteractionController.ts` 是主交互控制器，接收 `shellRef`、当前 scene、可见 nodes、selection、mask edit 状态和外部回调。
- controller 通过 `canvasToolRegistry.ts` 和 `canvasToolHandlers.ts` 把 active tool 映射到 runtime tool，再分发 `onCanvasPointerDown`、`onNodePointerDown`、resize handle pointer down。
- pointer move/end 状态机集中在 controller 的 refs 中：pan、selection marquee、node move/resize、group resize、text/frame/markup creation、markup connector endpoint move、text width resize。
- `canvasInteraction.ts` 放纯函数和类型：viewport、pan、selection box、bounds、node resize/move、group resize、wheel delta 等。
- keyboard 和 clipboard 也是 controller 管：Space 临时 hand，V/H/T/F/A/L/R/O/P/N 切工具，Esc 取消交互或 mask edit，Cmd/Ctrl+C/D/Z，Delete，arrow nudging，paste image/clipboard nodes/clipboard assets。

### 工具注册机制

- `canvasToolRegistry.ts` 是工具清单：select、hand、text、frame、markup arrow/line/rect/ellipse/brush/note 可用；sticker/comment/image/video 已登记但 disabled。
- `CanvasToolDock.tsx` 从 registry 渲染左侧工具 dock，并把 markup shape 合成一个带 flyout 的主按钮。
- `canvasToolHandlers.ts` 只负责把 runtime tool 的 pointer 语义转给 controller context，业务状态不在 handler 中。
- 当前 registry 中没有 `import` tool，但 `canvasActionModel.ts` 的 `importAssetAtContext` 在缺少 canvasPosition/onImportAssetAt 时会 `setTool(runtime, 'import')`。该工具未在 registry 启用，属于半成品/潜在死分支。

### Overlay 生命周期

- mask overlay 生命周期：`CanvasAiActionBar` / `NodeActionMenu` / `SelectionQuickToolbar` 触发 `beginMaskEdit` -> `MivoCanvas` 设置 `maskEditNodeId` -> 对应 `CanvasNodeView` 在 image URL 已解析且 natural size 已知后挂载 `ImageMaskEditOverlay` -> overlay 提交 `ImageMaskSubmitPayload` -> `MivoCanvas.submitMaskEdit` 读取源图 blob、调用 `editMivoImage`、再 `commitGenerationResult` 创建右侧派生图。
- P3 前端触发侧：`MivoCanvas` 在 `maskEditNodeId` 变化时调用 `onMaskEditActiveChange(active)`；外层据此收起 AI panel。`maskCancelRequestId` 变化和 Esc 都会走 `cancelMaskEdit`。
- crop overlay 生命周期：`beginCropNode` -> `cropNodeId` -> `ImageCropOverlay` 挂载在 DOM canvas layer 内 -> commit 后调用 store `cropImageNode`，更新节点几何和 `imageCrop`，不做真实像素重采样。

## 功能闭环现状

- M2 mask 编辑前端交互：点选、框选、涂抹、undo/redo/clear、prompt submit、`regionCount`/`draftRef` 逻辑已按交接结论验证正确。当前清单标记为“已验证正确”。P1 慢的问题不在前端 mask 交互，而在 `/api/mivo/edit` 上游耗时。
- M6 底部 AI 操作栏：已接入画布底部固定入口，可选择、打开生成 panel、启动局部重绘。完成。
- 画布工具/选择/连线/裁剪/文本：源码层闭环完整，局部行为未在本次 inventory 重新跑 UI 验证，标记为未验证。
- P2 多选粘贴画布落点：controller paste 优先处理 `clipboardAssets`，调用 `pasteClipboardAssets(viewportCenter())`；store 按最多 3 列网格排布并选中新节点。交接结论为已修，本次仅读源码确认。

## 逐文件清单

### `src/canvas/MivoCanvas.tsx`

- 职责：画布主组件；创建 Leafer host；挂载 DOM canvas layer；连接 store、interaction controller、context menu、tool dock、AI action bar、crop/mask overlay。
- 关键导出/props/事件：导出 `MivoCanvas`、`ExternalAssetDropHandler`。props 包括 `onOpenDetails`、`onOpenGeneratePanel`、`onRegisterExternalAssetDrop`、`onMaskEditActiveChange`、`maskCancelRequestId`。事件包括 wheel、pointer down/move/up/cancel、drag over/drop、blank context menu。
- 代码现状：完成。Leafer 已初始化但当前节点渲染主要走 DOM；含 render overscan 和 pinned nodes；含 P3 mask active 回调；含 local asset/file drag-drop；含 crop/mask submit。
- 依赖数据流：读写 `useCanvasStore` 的 nodes、selection、import、crop、text/frame create、rename、`commitGenerationResult`；调用 `editMivoImage`、`readCanvasImageBlob`、asset import/download helpers；向 `useCanvasInteractionController` 注入可见节点和 mask cancel。
- 相关功能闭环状态：M2 触发和提交链路完成；P3 前端触发完成；M6 入口完成；P1 性能风险在 API 上游，前端仅显示 `重绘中...`，无真实进度/取消反馈深做。

### `src/canvas/CanvasNodeView.tsx`

- 职责：单个画布节点 DOM 渲染视图，覆盖 image/task/text/frame/ai-slot/annotation/markup/markdown/pdf/video；承载 selection handle、text editor、markup endpoint handle、mask overlay 挂载。
- 关键导出/props/事件：导出 `CanvasNodeView`。props 包括 `node`、selection/editing/locked 状态、handle 尺寸、mask 状态、viewportScale，以及 select/pointer/resize/text/mask/context menu/open details 回调。
- 代码现状：完成。文本和 markup 内嵌编辑器可用；markdown full mode 会根据 scrollHeight 自动更新 measured size；mask overlay 只在 `imageNode && maskEditActive && resolvedAssetUrl && naturalSize` 时挂载。
- 依赖数据流：`useResolvedAssetUrl(node.assetUrl)`；`renderKindForNode`；`ImageMaskEditOverlay`；`MarkdownPreview`；文本几何默认值。
- 相关功能闭环状态：主渲染闭环完成；mask overlay 生命周期条件明确；markdown auto-measure 和 video/pdf 展示本次未验证。

### `src/canvas/nodeTypes/canvasNodeRegistry.ts`

- 职责：节点类型注册表，定义 node type 到 render kind、默认尺寸、import behavior、capabilities 的映射。
- 关键导出/props/事件：导出 `canvasNodeRegistry`、`nodeTypeDefinitionFor`、`nodeDefinitionFor`、`capabilitiesForNode`、`renderKindForNode`、`defaultSizeForNodeType`、`importBehaviorForNodeType`、`isCanvasTextNode`、`isCanvasSectionNode`。
- 代码现状：完成。覆盖 image、task-placeholder、text、frame、ai-slot、annotation、markup、markdown、pdf、video。
- 依赖数据流：被 `CanvasNodeView`、store、action selection model 使用；capability 来源于 `nodeCapabilities.ts`。
- 相关功能闭环状态：动作模型和渲染分派基础完成；新增类型需同步 types/store/render/action 能力。

### `src/canvas/nodeTypes/nodeCapabilities.ts`

- 职责：画布对象能力枚举和基础能力集合。
- 关键导出/props/事件：导出 `CanvasObjectCapability`、`baseObjectCapabilities`、`organizationCapabilities`。
- 代码现状：完成。能力包括 selectable/movable/resizable/layerable/groupable/lockable/hideable/exportable、asset/image/text/frame/prompt/AI/edit/file/markup/task/slot/result 等。
- 依赖数据流：`canvasNodeRegistry.ts` 组合能力；`canvasSelectionModel.ts` 求 selection 的 common/any capability；`canvasActionModel.ts` 据此生成菜单动作。
- 相关功能闭环状态：能力驱动菜单闭环完成。

### `src/canvas/ImageMaskEditOverlay.tsx`

- 职责：局部重绘 mask 前端 overlay；提供点选、框选、涂抹、画笔尺寸、undo/redo/clear、prompt、submit/cancel 的完整交互。
- 关键导出/props/事件：导出 `ImageMaskEditOverlay`。props 为 `node`、`resolvedAssetUrl`、`naturalSize`、`viewportScale`、`submitting`、`onCancel`、`onSubmit`。提交 payload 为 `ImageMaskSubmitPayload`。
- 代码现状：已验证正确。`regionsRef` 保持已提交区域，`draftRef` 保持拖拽草稿，window pointermove/up/cancel 保证拖出节点仍能完成；DOM 上有 `data-region-count`；浮动 toolbar/prompt 通过 portal 挂到 canvas shell。
- 依赖数据流：依赖 `imageMaskGeometry.ts` 的坐标转换、bounds、mask blob、尺寸校验；由 `CanvasNodeView` 在图像节点内挂载；向 `MivoCanvas.submitMaskEdit` 提交。
- 相关功能闭环状态：M2 前端交互已验证正确；P1 慢调用不是该文件问题。已知体验风险：submit 期间只有按钮文案 `重绘中...`，无真实进度。

### `src/canvas/ImageCropOverlay.tsx`

- 职责：图像裁剪框 overlay；支持拖动裁剪框和四角 resize，Done/Cancel。
- 关键导出/props/事件：导出 `ImageCropBox`、`ImageCropOverlay`。props 为 `node`、`scale`、`onCommit`、`onCancel`。
- 代码现状：完成。内部使用 pointer capture 和 `dragRef`；初始 box 按节点尺寸 8% inset；最小裁剪 24。
- 依赖数据流：由 `MivoCanvas` 根据 `cropNodeId` 挂载；commit 调 store `cropImageNode`，store 更新节点 `x/y/width/height/imageCrop`。
- 相关功能闭环状态：裁剪前端闭环完成；本次未做 UI 验证；裁剪是显示裁剪模型，不产生新像素文件。

### `src/canvas/useCanvasInteractionController.ts`

- 职责：画布交互总控制器；把工具、pointer、keyboard、paste、viewport、selection、snap、text/frame/markup creation、move/resize/group resize、connector snap 串起来。
- 关键导出/props/事件：导出 `defaultViewportFor`、`TextResizeEdge`、`useCanvasInteractionController`。返回 viewport/snap/selection/tool states 和 begin/handle/fit/zoom/reset/edit text 等回调。
- 代码现状：完成但体量较大。viewport 写入 localStorage；scene 切换会重置交互 refs；Esc 在 mask edit 活跃时优先调用 `onCancelMaskEdit`；paste 优先处理 Eagle `clipboardAssets`，落点为 viewport center。
- 依赖数据流：大量读写 `useCanvasStore`；使用 `canvasInteraction.ts` 纯函数、`canvasToolHandlers.ts`、`canvasToolRegistry.ts`、`connectorGeometry.ts`、`textGeometry.ts`、`canvasAssetImport`。
- 相关功能闭环状态：选择/移动/缩放/创建/连线/文本/P2 粘贴画布侧完成；未重新 UI 验证。风险：controller 是高耦合热点，mask、text、markup、clipboard、viewport 都在同一文件内。

### `src/canvas/canvasInteraction.ts`

- 职责：画布交互纯模型和几何计算；不依赖 React/store。
- 关键导出/props/事件：导出 runtime tool、Viewport/Bounds/Point/state 类型，以及 `runtimeToolFor`、target 判断、坐标转换、viewport zoom/fit/pan、selection、bounds、node/group transform 等函数。
- 代码现状：完成。包含 min/max scale、selection drag threshold、node min/max size、frame/markup free resize 分支。
- 依赖数据流：被 controller 调用；内部依赖 `canvasGeometry.ts` 的 snap 函数。
- 相关功能闭环状态：交互基础完成；未单测覆盖，风险主要在复杂 resize/snap 边界。

### `src/canvas/CanvasToolDock.tsx`

- 职责：左侧画布工具 dock UI。
- 关键导出/props/事件：导出 `CanvasToolDock`，props `previewTool?: ToolId`。点击工具调用 `setActiveTool`；markup shapes 通过 flyout 选择并记忆上次 shape。
- 代码现状：完成。会显示 Space 临时 hand 的 preview；disabled 工具不可点击。
- 依赖数据流：读写 `useCanvasStore.activeTool`；读取 `canvasToolRegistry`、`markupShapeToolIds`。
- 相关功能闭环状态：可用工具 UI 完成；disabled 工具只是占位。

### `src/canvas/canvasToolHandlers.ts`

- 职责：runtime tool 到 controller begin 函数的 pointer 分发。
- 关键导出/props/事件：导出 `CanvasToolHandlerContext`、`CanvasToolHandler`、`canvasToolHandlers`。
- 代码现状：完成且薄。select/hand/text/frame/markup 五类 runtime handler。
- 依赖数据流：由 controller 根据 `runtimeToolFor` 选择；handler 不直接碰 store。
- 相关功能闭环状态：工具分发完成。

### `src/canvas/canvasToolRegistry.ts`

- 职责：工具定义、快捷键映射、markup tool 到 markup kind 的映射。
- 关键导出/props/事件：导出 `CanvasToolDefinition`、`markupShapeToolIds`、`MarkupShapeToolId`、`canvasToolRegistry`、`isCanvasToolEnabled`、`toolForKeyboardShortcut`、`markupKindForTool`。
- 代码现状：基本完成。select/hand/text/frame/markup 系列启用；sticker/comment/image/video disabled。没有 `import` tool 定义。
- 依赖数据流：被 dock/controller/action model 使用。
- 相关功能闭环状态：现有工具闭环完成；`import` 工具缺位是已知半成品/潜在错误路径。

### `src/canvas/CanvasAiActionBar.tsx`

- 职责：M6 底部 AI 操作栏。
- 关键导出/props/事件：导出 `CanvasAiActionBar`。props 包括 `selectedNode`、`maskEditActive`、`onOpenGeneratePanel`、`onStartMaskEdit`、`onCancelMaskEdit`。
- 代码现状：完成。按钮：选择、生成、局部重绘。局部重绘仅 image 且未 hidden 时启用；mask 活跃时选择按钮会先 cancel mask。
- 依赖数据流：读写 `useCanvasStore.activeTool`；回调由 `MivoCanvas` 注入。
- 相关功能闭环状态：M6 已交付；mask edit 入口完成；本文件不负责 AI 请求。

### `src/canvas/CanvasContextMenu.tsx`

- 职责：context menu 外壳和 viewport fit。
- 关键导出/props/事件：导出 `CanvasContextMenu`，props `x/y/children`。内部监听 ResizeObserver、window/visualViewport resize/scroll。
- 代码现状：完成。会 clamp 到 visual viewport，给 `.node-action-menu` 设置 maxHeight。
- 依赖数据流：承载 `NodeActionMenu`；不碰 store。
- 相关功能闭环状态：菜单定位完成；移动端/visualViewport 行为本次未验证。

### `src/canvas/NodeActionMenu.tsx`

- 职责：右键菜单内容渲染，支持子菜单 portal、swatch、line preview、danger/selected/disabled 状态。
- 关键导出/props/事件：导出 `NodeActionMenu`。props 覆盖 primary node、selectedNodes、canvasPosition 和各类 UI/store 回调。
- 代码现状：完成。动作来自 `contextMenuGroupsFor(runtime)`；子菜单根据 viewport 左右翻转。
- 依赖数据流：`useCanvasActionRuntime` 注入 store 和 UI callbacks；`canvasActionModel.ts` 生成 action groups。
- 相关功能闭环状态：右键动作闭环完成；含局部重绘入口 `onStartImageMaskEdit` 和裁剪入口。

### `src/canvas/SelectionQuickToolbar.tsx`

- 职责：选择态悬浮快捷工具条；单节点/多选动作；单 text 节点转交 `TextFormatToolbar`。
- 关键导出/props/事件：导出 `SelectionQuickToolbar`。props 包括 selectedNodes/bounds、editingTextNodeId、scale、viewportOffset、open/edit/rename/crop/mask/download callbacks。
- 代码现状：完成。菜单 children 支持 palette/segmented/icon-grid/list；Esc 可关闭 open menu；toolbar 位置随 scale 反缩放。
- 依赖数据流：`quickToolbarGroupsFor(runtime)` 和 `useCanvasActionRuntime`；由 `MivoCanvas` 在非 crop、非 mask edit 时挂载。
- 相关功能闭环状态：快捷工具条完成；image 的 AI Edit 子菜单含 `Select area` 局部重绘入口。

### `src/canvas/TextFormatToolbar.tsx`

- 职责：单个 text 节点的格式快捷工具条。
- 关键导出/props/事件：导出 `TextFormatToolbar`，props `node`、`scale`。操作字号、bold、align、颜色。
- 代码现状：完成。字号 12-72；颜色 presets 固定；每次样式变更用 `textGeometryFor` 重算宽高。
- 依赖数据流：调用 `useCanvasStore.updateTextStyle`；依赖 `textGeometry.ts` 默认值和测量。
- 相关功能闭环状态：文本格式闭环完成；仅 text 节点由 selection toolbar 入口显示。

### `src/canvas/canvasGeometry.ts`

- 职责：节点移动/resize 吸附与 snap guide 计算。
- 关键导出/props/事件：导出 `ResizeCorner`、`SnapGuide`、`CanvasRect`、`getSnappedPosition`、`getSnappedResize`、`getSnappedFreeResize`。
- 代码现状：完成。snap threshold 8；普通节点保持 aspect ratio resize，frame/markup free resize。
- 依赖数据流：被 `canvasInteraction.ts` 使用，再由 controller 渲染 snap guides。
- 相关功能闭环状态：吸附基础完成；未单测验证极端重叠/大尺寸边界。

### `src/canvas/connectorGeometry.ts`

- 职责：markup arrow/line 和节点之间的 connector snap/binding 几何。
- 关键导出/props/事件：导出 connector anchor 列表、阈值、`isConnectorNode`、`isConnectableNode`、`connectorAnchorPointFor`、`connectorBindingPointFor`、`nearestConnectorBindingForPoint`。
- 代码现状：完成。支持 center/top/right/bottom/left；inside edge threshold；同距离时偏向更上层节点。
- 依赖数据流：controller 在创建/拖动 connector endpoint 时调用；store 的 normalize 会根据 binding 重新计算 connector markup 节点几何。
- 相关功能闭环状态：连线吸附闭环完成；本次未 UI 验证。

### `src/canvas/textGeometry.ts`

- 职责：文本节点默认样式和文本宽高估算。
- 关键导出/props/事件：导出默认字体参数、`TextAlignment`、`textGeometryFor`。
- 代码现状：完成。浏览器环境使用 canvas 2D measureText，非浏览器 fallback 估算；支持 CJK、空格、数字大写粗略宽度。
- 依赖数据流：controller text edit/resize、TextFormatToolbar、CanvasNodeView 使用默认值。
- 相关功能闭环状态：文本创建/编辑/格式闭环完成；复杂字体实际渲染误差未验证。

### `src/canvas/imageMaskGeometry.ts`

- 职责：mask 选区几何、node/image pixel 坐标转换、mask bounds、mask PNG blob 生成。
- 关键导出/props/事件：导出 `ImageMaskPoint`、`ImageMaskRegion`、`ImageMaskBounds`、`ImageMaskSubmitPayload`、`maxMaskCanvasPixels`、`maxMaskCanvasEdge`、`validateMaskCanvasSize`、`displayRectForImage`、`nodePointToImagePixel`、`imagePixelToNodePoint`、`boundsForRegions`、`buildEditMaskBlob`。
- 代码现状：完成并随 M2 前端验证链路确认。最大边 6000、最大 24M pixels；mask 画布黑底，选区用 destination-out 透明区域。
- 依赖数据流：`ImageMaskEditOverlay` 用于显示/转换/提交；`MivoCanvas.submitMaskEdit` 把 payload 交给 API。
- 相关功能闭环状态：M2 几何和 mask blob 侧已验证正确。注意：`buildEditMaskBlob` 参数含 `imageCrop` 但函数内部未使用；当前 overlay 已在点位转换时折算 crop，因此不是已知 bug，但参数容易误导。

### `src/canvas/actions/canvasActionModel.ts`

- 职责：统一定义 context menu 和 quick toolbar 的动作模型。
- 关键导出/props/事件：导出 `CanvasActionGroup`、`CanvasActionItem`、`CanvasActionRuntime` 类型，以及 `contextMenuGroupsFor`、`quickToolbarGroupsFor`。
- 代码现状：完成但较大。覆盖 blank create/import/select all/show hidden、single inspect/copy/duplicate/generate/crop/AI edit/section style/markup style/export/delete、multi group/ungroup/align/distribute/layer/lock。
- 依赖数据流：输入 `CanvasActionRuntime`；使用 selection capability 判断动作可见性；AI edit 入口调用 runtime 的 generate/begin mask/edit note 等。
- 相关功能闭环状态：菜单/快捷工具条动作闭环完成；图像 `AI Edit -> Select area` 接到 mask edit。已知半成品：`importAssetAtContext` fallback 会设置不存在的 `import` tool。

### `src/canvas/actions/canvasActionTypes.ts`

- 职责：动作模型类型定义。
- 关键导出/props/事件：导出 `LayerMove`、`CanvasActionItem`、`CanvasActionGroup`、`CanvasActionRuntime`。
- 代码现状：完成。Runtime 类型显式列出所有 store action 和 UI 回调需求。
- 依赖数据流：被 `canvasActionModel.ts`、`useCanvasActionRuntime.ts` 和 menu/toolbar 组件使用。
- 相关功能闭环状态：动作模型类型基础完成。

### `src/canvas/actions/canvasSelectionModel.ts`

- 职责：把当前 selection 转为能力上下文。
- 关键导出/props/事件：导出 `CanvasSelectionKind`、`CanvasSelectionContext`、`createCanvasSelectionContext`、`hasCommonCapability`、`hasAnyCapability`，并 re-export `CanvasObjectCapability`。
- 代码现状：完成。对 selected nodes 求 capability 交集和并集，区分 blank/single/multi。
- 依赖数据流：调用 `capabilitiesForNode`；被 action model 作为动作可见性和 enabled 依据。
- 相关功能闭环状态：selection capability 闭环完成。

### `src/canvas/actions/useCanvasActionRuntime.ts`

- 职责：把 Zustand store action、selection context、UI 回调包装成 `CanvasActionRuntime`。
- 关键导出/props/事件：导出 `useCanvasActionRuntime`。options 包括 primaryNode、selectedNodes、canvasPosition 和 UI callback 集。
- 代码现状：完成。若 `selectedNodes` 未传且 primary node 已在 selection 中，会从 store 当前 selection 扩展 context；`pasteClipboardNodes` 会绑定 `canvasPosition`。
- 依赖数据流：大量读取 `useCanvasStore` action/state；调用 `createCanvasSelectionContext`。
- 相关功能闭环状态：菜单和 toolbar 与 store 的连接层完成。

## 已知风险 / 半成品

- P1 局部重绘上游慢仍未本质解决：本层只有 submitting 状态和按钮文案，无真实进度、取消后的用户可见状态、重试策略。
- `canvasToolRegistry.ts` 没有 `import` 工具，但 `canvasActionModel.ts` 存在 fallback `setTool(runtime, 'import')`，属于半成品路径。
- `useCanvasInteractionController.ts` 是多功能热点文件，改动 mask、paste、keyboard、text、markup、viewport 任一链路都可能互相影响。
- `ImageCropOverlay`/`cropImageNode` 是非破坏性显示裁剪，不会生成裁剪后的真实 asset；若后续 AI 需要按裁剪后像素作为输入，需要确认 `assetBlobForNode/readCanvasImageBlob` 是否按 `imageCrop` 输出。
- 本次 inventory 未重新跑 build/e2e/UI smoke；验证结论来自权威交接文档和源码阅读。
