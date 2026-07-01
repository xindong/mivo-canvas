# MivoCanvas Demo · Step M2 锚点二改详细计划

## ① PHASE_GOAL

实现 M2：选中一张 image node 后，用户能用点选、框选、涂抹三种锚点方式标出局部区域，输入 prompt，前端合成与原图同像素尺寸的 PNG mask（**透明=要改，不透明=保留**），通过 M1/M2 共用的 `src/lib/mivoImageClient.ts` 提交 M0 契约的 `POST /api/mivo/edit` multipart：`image` + `mask` + `prompt` + `imgRatio` + `quality` + `model` + 可选 `reference[]`，拿到真实 b64 后调用 M5 `commitGenerationResult({kind:'edit', ...})` 创建派生新 image node + `CanvasEdge{type:'edit'}`，原图不覆盖。

前置依赖：
- M0 已提供 `POST /api/mivo/edit`，并接受 `image`、`mask`、`prompt` 分字段；不要把 `mask` 当 `reference[]`。
- M5 已提供显式派生模型：`ImageNode.sourceNodeId`、`ImageNode.generation{prompt,model,maskBounds?,createdAt}`、`edges: CanvasEdge[]`、`CanvasEdge = {id, from, to, type:'generate'|'edit', prompt, createdAt}`，以及唯一写入派生结果的 store action `commitGenerationResult(payload)`。若 M5 尚未落地，M2 只能做到 overlay + mask 导出自验，提交阶段必须等待。

非目标：
- 不做 M3 图片审核。
- 不改 llm-proxy API 形状。
- 不引入 Open Design iframe/srcdoc/comments 管线。
- 不用现有 annotation note 代替 mask；annotation 只能保留为旧功能。

Anti-fill / 禁止项：
- 禁止继续用 `beginImageEditPrompt(..., 'area-edit')` 完成 M2；`select-area-edit` 必须进入 `onStartImageMaskEdit(nodeId)`。
- 禁止调用 `canvasStore.generateImageEdit` 的 mock 路径作为 M2 结果来源；M2 结果只来自 `POST /api/mivo/edit`。
- 禁止覆盖 source node 的 `assetUrl`、`assetId`、`generation`；成功后只能新增派生 node，并写 `Edge{from:sourceId,to:resultId,type:'edit'}`。
- 禁止把 `mask` 塞进 `reference[]` 或 prompt JSON；multipart 字段必须是独立 `mask` part。
- 禁止把屏幕显示截图当 mask；mask canvas 必须是原图自然像素尺寸，且 alpha 语义固定为 `透明=要改`、`不透明=保留`。
- 禁止在 M2 临时发明第二套 lineage 字段；派生关系只使用 M5 契约字段。

## ② 精确改动清单

### 2.1 新建模块

- `src/canvas/ImageMaskEditOverlay.tsx`
  - 新建 image-local overlay 组件，挂在 `CanvasNodeView` 的 image branch 里。
  - props 固定为：
    - `node: MivoCanvasNode`
    - `resolvedAssetUrl: string`
    - `naturalSize: {width:number;height:number}`
    - `viewportScale: number`
    - `onCancel(): void`
    - `onSubmit(payload: ImageMaskSubmitPayload): Promise<void>`
  - 本地 state：
    - `tool: 'point' | 'box' | 'brush'`
    - `prompt: string`
    - `regions: ImageMaskRegion[]`
    - `brushSizePx: number`，含义为“源图像素半径”，默认 48。
    - `status: 'editing' | 'submitting' | 'error'`
  - 所有 overlay pointer/input 元素加 `data-canvas-ui="true"`，并在 pointer handler 内 `event.stopPropagation()`，避免触发 `useCanvasInteractionController.ts:572-611` 的 node move。

- `src/canvas/imageMaskGeometry.ts`
  - 新建纯函数，避免在组件里散落坐标数学：
    - `displayRectForImage({nodeWidth,nodeHeight,naturalWidth,naturalHeight,imageCrop})`
    - `nodePointToImagePixel(point, displayRect, naturalSize, imageCrop?)`
    - `imagePixelToNodePoint(pixel, displayRect, naturalSize, imageCrop?)`
    - `boundsForRegions(regions): {x,y,width,height} | undefined`
    - `buildEditMaskBlob({naturalSize, imageCrop, regions}): Promise<Blob>`
  - `displayRectForImage` 必须匹配 `src/App.css:3536-3541` 的 `object-fit: contain`；当 `node.imageCrop` 存在时，匹配 `CanvasNodeView.tsx:479-487` + `src/App.css:3544-3546` 的 cropped fill。
  - `buildEditMaskBlob` 规则：
    - `canvas.width = naturalWidth`，`canvas.height = naturalHeight`。
    - 先 `fillRect(0,0,w,h)` 为不透明黑色或白色（颜色无关，alpha=255，表示保留）。
    - 对点/框/涂抹区域使用 `globalCompositeOperation = 'destination-out'` 清 alpha，得到透明区域（表示要改）。
    - 导出 `canvas.toBlob('image/png')`；禁止导出显示层截图。

- `src/lib/mivoImageClient.ts`
  - 复用 M1 已建的共享前端调用封装，不新建 `mivoImageEditClient.ts`：
    - `editMivoImage({ image, mask, prompt, imgRatio, quality, model, references }): Promise<{images:{b64:string}[]}>`
  - `FormData` 字段名必须精确：
    - `image`: `File | Blob`
    - `mask`: `Blob`，filename=`mask.png`，type=`image/png`
    - `prompt`: trimmed prompt
    - `imgRatio`: 从 source node 尺寸或 M1 控件传入，默认 `1:1`
    - `quality`: `medium`
    - `model`: `gpt-image-2`
    - `reference[]`: 可选，M2 第一版可以空数组；它只代表额外参考图，不能承载 mask
  - 错误行为：非 2xx 读 `response.text()`，抛出 `Mivo image edit failed: ${status} ${message}`，overlay 显示错误，不创建节点。

- `src/lib/canvasImageSource.ts`
  - 新建 helper：
    - `readCanvasImageBlob(node, resolvedAssetUrl): Promise<File>`
    - 对 `mivo-asset:*` 使用 `readImportedAssetFile()`，锚点见 `src/lib/assetStorage.ts:294-309`。
    - 对 `/api/mivo/eagle/assets/:id/file`、普通 URL、blob URL 使用 `fetch(resolvedAssetUrl || node.assetUrl)`。
    - filename 使用 `node.assetOriginalName || node.title + '.png'`，mime 使用 blob type 或 `node.assetMimeType || 'image/png'`。

### 2.2 修改现有文件

- `src/canvas/CanvasNodeView.tsx`
  - 锚点：组件 props 在 `CanvasNodeView.tsx:10-46`，image 渲染在 `CanvasNodeView.tsx:674-699`。
  - 新增 props：
    - `maskEditActive: boolean`
    - `maskEditSubmitting: boolean`
    - `viewportScale: number`
    - `onSubmitMaskEdit(nodeId, payload): Promise<void>`
    - `onCancelMaskEdit(): void`
  - 在 `CanvasNodeView.tsx:685-694` 的 `<img>` 上加 `ref` 和 `onLoad`，缓存 `naturalSize`；如果未加载，overlay 只显示 loading disabled state。
  - 在 `CanvasNodeView.tsx:695` 后、`</div>` 前挂 `<ImageMaskEditOverlay />`，只在 `node.type === 'image' && maskEditActive && resolvedAssetUrl && naturalSize` 时渲染。
  - 保持 `draggable={false}` 不变，防止和画布拖动冲突。

- `src/canvas/MivoCanvas.tsx`
  - 锚点：state 区 `MivoCanvas.tsx:102-126`，传 `CanvasNodeView` 在 `MivoCanvas.tsx:600-638`，context menu 在 `MivoCanvas.tsx:665-680`，quick toolbar 在 `MivoCanvas.tsx:649-662`。
  - 新增 state：
    - `const [maskEditNodeId, setMaskEditNodeId] = useState<string>()`
    - `const [maskEditSubmittingNodeId, setMaskEditSubmittingNodeId] = useState<string>()`
  - 新增 callbacks：
    - `beginMaskEdit(nodeId)`：校验 node 是 visible image，`selectNode(nodeId)`，`setContextMenu(null)`，`setCropNodeId(undefined)`，`setMaskEditNodeId(nodeId)`。
    - `cancelMaskEdit()`：清空 mask edit state。
    - `submitMaskEdit(nodeId, payload)`：读 source image blob → 调共享 `editMivoImage` → 拿 `{images:[{b64}]}` → 调 M5 `commitGenerationResult({kind:'edit', ...})`；不直接存 assetStorage、不直接拼 node/edge。
  - `CanvasNodeView` 增传：
    - `maskEditActive={node.id === maskEditNodeId}`
    - `maskEditSubmitting={node.id === maskEditSubmittingNodeId}`
    - `viewportScale={viewport.scale}`
  - 当 `maskEditNodeId` 存在时隐藏 `SelectionQuickToolbar`，避免工具条盖住 overlay prompt。

- `src/canvas/actions/canvasActionTypes.ts`
  - 锚点：runtime callbacks 在 `canvasActionTypes.ts:42-58`。
  - 新增 `onStartImageMaskEdit?: (nodeId: string) => void`。

- `src/canvas/actions/useCanvasActionRuntime.ts`
  - 锚点：options 在 `useCanvasActionRuntime.ts:7-21`，return 在 `useCanvasActionRuntime.ts:87-134`。
  - 透传 `onStartImageMaskEdit`。

- `src/canvas/NodeActionMenu.tsx`
  - 锚点：props 在 `NodeActionMenu.tsx:8-23`，runtime 调用在 `NodeActionMenu.tsx:41-55`。
  - 透传 `onStartImageMaskEdit`。

- `src/canvas/SelectionQuickToolbar.tsx`
  - 锚点：props 在 `SelectionQuickToolbar.tsx:9-21`，runtime 调用在 `SelectionQuickToolbar.tsx:49-58`。
  - 透传 `onStartImageMaskEdit`，这样 image quick toolbar 的 AI Edit > Select area 也能进入 overlay。

- `src/canvas/actions/canvasActionModel.ts`
  - 锚点：`imageAiEditActionsFor` 在 `canvasActionModel.ts:148-206`，image quick toolbar 在 `canvasActionModel.ts:1091-1115`。
  - 把 action `id:'select-area-edit'` 从当前 `beginImageEditPrompt(... 'area-edit' ...)` 改为：
    - `const nodeId = primaryNodeId(runtime); if (nodeId) runtime.onStartImageMaskEdit?.(nodeId)`
  - `Edit with prompt` 可暂时保留旧 prompt annotation 或后续 M1 接全图 edit；M2 不依赖它。
  - `remove-background/outpaint/upscale` 不在本步骤改，避免扩大 M2 风险。

- `src/canvas/useCanvasInteractionController.ts`
  - 锚点：options 在 `useCanvasInteractionController.ts:53-59`，Escape handler 在 `useCanvasInteractionController.ts:1235-1254`。
  - 增加可选参数 `maskEditNodeId?: string`、`onCancelMaskEdit?: () => void`。
  - Escape 优先：若 `maskEditNodeId` 存在，调用 `onCancelMaskEdit()` 并 return，不执行 `selectNode(undefined)`。
  - 保持 `runtimeToolFor` 不新增 runtime tool；overlay 吃事件，controller 只负责全局 Escape 和避免 canvas 状态残留。

- `src/types/mivoCanvas.ts`
  - 锚点：`MivoCanvasNode` 在 `mivoCanvas.ts:101-159`。
  - 如果 M5 已改出字段，则 M2 只消费；若未改，M2 不自行发明第二套。
  - M2 需要的 M5 字段是：
    - `sourceNodeId?: string`
    - `generation.maskBounds?: {x:number;y:number;width:number;height:number}`
    - `generation.createdAt?: number`
    - `edges: Edge[]` 在 snapshot/document/store 层。

- `src/store/canvasStore.ts`
  - 锚点：mock `generateImageEdit` 在 `canvasStore.ts:1809-1882`。
  - 不在 overlay 内直接拼 node；提交成功后只调用 M5 提供的唯一 action：`commitGenerationResult({sourceNodeId, resultImages: response.images, prompt, model:'gpt-image-2', kind:'edit', maskBounds})`。
  - M2 不新增平行 action，不复用 `generateImageEdit` 的旧 mock 路径创建结果。

- `src/App.css`
  - 锚点：image media 样式在 `App.css:3529-3546`，crop overlay 样式在 `App.css:3552-3575`，toolbar 样式在 `App.css:3079-3455`。
  - 新增 `.image-mask-edit-overlay`、`.image-mask-edit-stage`、`.image-mask-edit-toolbar`、`.image-mask-edit-prompt`、`.image-mask-edit-region`、`.image-mask-edit-brush-cursor`。
  - overlay 必须 `position:absolute; inset:0; z-index` 高于 image、低于 context menu；`pointer-events:auto`。

## ③ 顺序

1. **前置检查**
   - 确认 M0 `/api/mivo/edit`、共享 `src/lib/mivoImageClient.ts`、M5 `commitGenerationResult(...)` 已存在。
   - 开发可验证点：读源码看到 M0 endpoint 字段为 `image` / `mask` / `prompt`，shared client 中 `mask` 与 `reference[]` 是不同 FormData key，M5 `commitGenerationResult` 会写新 node + `edges`，否则停止 M2 提交部分。

2. **建立 mask edit session plumbing**
   - 改 `MivoCanvas.tsx`、`NodeActionMenu.tsx`、`SelectionQuickToolbar.tsx`、`useCanvasActionRuntime.ts`、`canvasActionTypes.ts`。
   - 先让右键 image → AI/Edit → Select area 或 quick toolbar → AI Edit → Select area 后，`maskEditNodeId` 变成该 image id。
   - 开发可验证点：浏览器选中 image，点 Select area，image 上出现一个空 overlay 外框；拖动 image 不发生，因为 overlay `stopPropagation()`。

3. **挂载 overlay 视觉壳**
   - 改 `CanvasNodeView.tsx`，在 image branch 内挂 `ImageMaskEditOverlay`。
   - overlay 先只显示三段工具按钮（Point / Box / Brush）、prompt textarea、Cancel / Generate 按钮。
   - 开发可验证点：overlay 只覆盖当前 image node；切换选中其他 node 不出现 overlay；Escape 关闭 overlay。

4. **实现 natural size 与显示区域映射**
   - 在 `CanvasNodeView` 的 `<img>` `onLoad` 记录 `naturalWidth/naturalHeight`。
   - 在 `imageMaskGeometry.ts` 实现 `displayRectForImage`：
     - 非 crop：按 `object-fit: contain` 算出 image 在 node 内的实际显示 rect，排除上下/左右留白。
     - crop：display rect 为整 node，像素映射先进入 `imageCrop{x,y,width,height}` 对应的原图归一化窗口。
   - 开发可验证点：临时 debug 文案显示 natural size 和 hover pixel；在 16:9、竖图、裁剪图上 hover 四角，像素坐标落在 `[0,naturalWidth]` / `[0,naturalHeight]`，点到 letterbox 留白不创建 region。

5. **点选工具**
   - `tool='point'` 时 click 生成 `ImageMaskRegion{type:'point', center:{x,y}, radius}`，坐标存源图像素。
   - 视觉上用小圆点 + 半透明影响半径显示。
   - 开发可验证点：点 image 中心，regions 长度 +1；Undo 删除；maskBounds 为点半径包围盒。

6. **框选工具**
   - pointerdown 记录 start pixel，pointermove 更新 preview rect，pointerup 提交 `ImageMaskRegion{type:'box', x,y,width,height}`。
   - 最小框小于 8 源图像素时丢弃。
   - 开发可验证点：拖出矩形、调整浏览器 zoom 后仍能命中相同图片区域；框只在图片显示 rect 内，不从 letterbox 起算。

7. **涂抹工具**
   - 复用 toolbox pixel-forge 思路：pointerdown 开始 stroke，pointermove 用线段插值连接上一点，pointerup 完成。
   - 存储 `ImageMaskRegion{type:'brush', points:[{x,y}], radius}`，points 为源图像素。
   - 用 rAF 合并 hover/stroke preview，避免每个 pointermove 触发 React 大量 setState。
   - 开发可验证点：连续涂抹不丢段，快速移动仍连续；Brush size 改变后新 stroke 使用新 radius。

8. **Undo / Redo / Clear**
   - overlay 内维护 `past/current/future`，只管理 regions，不写 canvasStore history。
   - 开发可验证点：点、框、涂抹混合后 Undo/Redo 顺序正确；Clear 后 Generate disabled。

9. **mask canvas 合成**
   - `buildEditMaskBlob` 从 regions 生成完整原图尺寸 mask。
   - 透明语义强制单测式自检：
     - 取点 region 中心像素 alpha 应为 0。
     - 未选区域 alpha 应为 255。
   - 开发可验证点：临时加 “Download mask” dev-only 按钮或 console URL，打开 PNG 看到选区透明，其余不透明；确认没有把源图颜色画进 mask。

10. **提交 `/api/mivo/edit`**
    - `submitMaskEdit` 读取 source image File，生成 mask Blob，调用共享 `editMivoImage`。
    - 请求字段固定为：`image`、`mask`、`prompt`、`imgRatio`、`quality`、`model`。
    - 开发可验证点：浏览器 Network 看到 multipart 包含 `image` 和 `mask` 两个不同 part；`mask` filename 是 `mask.png`；prompt 为空时按钮 disabled。

11. **派生新节点 + edge**
    - 成功返回 `{images:[{b64}]}` 后，调用 M5 唯一 action：
      - `commitGenerationResult({`
      - `sourceNodeId: source.id,`
      - `resultImages: response.images,`
      - `prompt,`
      - `model: 'gpt-image-2',`
      - `kind: 'edit',`
      - `maskBounds: boundsForRegions(regions),`
      - `placement: 'right'`
      - `})`
    - IndexedDB 存图、`generation.createdAt`、新 image node、`CanvasEdge{from:source.id,to:result.id,type:'edit'}` 和 `chooseAdjacentPlacement` 放位都由 M5 action 完成；M2 不复制这些逻辑。
    - 开发可验证点：提交后原图仍在，新图出现在右侧，选中新图；M5 edge 可视线存在；store 中 `edges` 有 from=原图 id、to=新图 id、type=`edit`。

12. **错误与并发**
    - submitting 时锁定工具、prompt 和 Generate；Cancel 不中止已发请求第一版可以只关闭 UI，但不能创建半成品节点。
    - 失败只显示错误并保留 regions/prompt，允许重试。
    - 开发可验证点：断网或让 `/api/mivo/edit` 返回 500 时不新增 node/edge，overlay 显示错误，原图不变。

13. **清理旧 mock 路径**
    - M2 的 Select area 不再走 `beginImageEditPrompt` 创建 annotation note。
    - `canvasStore.ts:1809-1882` 的 mock `generateImageEdit` 可留给其他旧按钮，但 M2 overlay submit 不调用它。
    - 开发可验证点：执行 M2 不出现 “Describe the image edit here” annotation note。

## ④ SC 验收

- **M2-SC1：局部重绘新图节点，原图仍在**
  1. `npm run dev`。
  2. 画布上准备一张真实 image node（M1 生成或导入均可）。
  3. 选中 image → AI Edit → Select area。
  4. 选择 Box，框住局部区域，输入 `把框内改成蓝色发光纹理`，点 Generate。
  5. 看到右侧出现新 image node，原 image node 仍存在且 assetUrl 未变。

- **M2-SC2：派生连线存在**
  1. 完成 M2-SC1 后观察画布有 source → result 的可见 edge。
  2. 打开 store devtools 或临时 console 检查 `edges.some(e => e.from===sourceId && e.to===resultId && e.type==='edit')` 为 true。

- **M2-SC3：点/框/涂抹都生成有效 mask**
  1. 分别用 Point、Box、Brush 三次提交不同 prompt。
  2. 每次 Network multipart 都有 `mask` part。
  3. dev mask 下载或 console alpha 检查确认选区 alpha=0、非选区 alpha=255。
  4. 三次结果均为新节点，不覆盖任何原节点。

## ⑤ 风险回退

- **mask 语义反了**：立即回退 `buildEditMaskBlob` 的 composite 方向；验收必须以 alpha 检查为准，不以肉眼效果猜。
- **object-fit / crop 映射偏移**：先禁用 crop 图进入 M2（按钮 disabled + 文案），保证非 crop 图可验收；后续单独修 crop 映射。
- **大图 mask 内存过高**：限制 `naturalWidth * naturalHeight <= 16_000_000`；超出时提示用户用 medium/1K 或先缩图，避免浏览器 OOM。
- **M0/shared client 或 M5 未完成**：M2 只保留 overlay/mask 自验，不接 submit，不创建自定义临时派生模型；等 `editMivoImage` 和 `commitGenerationResult` 都存在后再接提交。
- **overlay 干扰画布拖拽/选择**：回退到只允许从 context menu 进入 overlay，overlay 关闭后才恢复 canvas pointer；不新增全局 mask tool。
- **llm-proxy 返回全图变化过大**：保留 maskBounds 和 prompt 到 generation metadata，便于复盘；不要在前端尝试覆盖回原图局部。
