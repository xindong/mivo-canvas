# MivoCanvas CODE-INVENTORY Part: 架构、状态、生成/编辑 API 链路

> 盘点日期：2026-07-02  
> 权威起点：`docs/demo/DEMO-STATUS.md`、`docs/demo/review/context-handoff-2026-07-02.md`  
> 源码范围：本文件仅覆盖任务指定的入口、状态、类型、图像 API、Vite Node 中间层、构建与 e2e 脚本。未读取或修改 `_tmp/`。  
> 验证说明：本轮盘点只读源码并落盘清单，未重新运行 `npm run build` 或 `npm run test:e2e`；构建/e2e 通过结论来自权威起点文档。

## 架构总览

MivoCanvas demo 是 Vite + React + TypeScript 应用，画布主交互由 React 组件和 LeaferJS 相关画布层承载，业务状态集中在 Zustand `useCanvasStore`。应用入口 `src/main.tsx` 只挂载 React 根；`src/App.tsx` 负责工作区框架、项目侧栏、右侧 AI 面板、素材抽屉、详情弹窗与 `MivoCanvas` 的外层编排。

核心数据模型是 `CanvasDocument`：每个 canvas 持有 `nodes`、`edges`、`tasks`、选择态。`MivoCanvasNode` 既承载图像/文本/批注/AI slot/导入文件等节点，也承载生成元信息 `generation`、AI 工作流元信息 `aiWorkflow`、以及 M5 衍生语义 `sourceNodeId`。`CanvasEdge` 是显式生成/编辑边，`canvasStore.ts` 会根据 edges 同步生成锁定的 markup 箭头节点，用可视 edge 闭合 M5 的 node/edge 模型。

生成/编辑主链路是：

```text
UI action
  -> useCanvasStore.generateBesideNode / generateIntoAiSlot / generateImageEdit / commitGenerationResult
  -> src/lib/mivoImageClient.ts
  -> Vite dev middleware in vite.config.ts: /api/mivo/generate or /api/mivo/edit
  -> upstream https://llm-proxy.tapsvc.com/v1/images/generations|edits
  -> response images[].b64
  -> saveGeneratedAsset(...)
  -> new image node + CanvasEdge + derivation edge markup node
```

Node 中间层只在 dev server 内存在，`MIVO_IMAGE_API_KEY` 只在 `vite.config.ts` 读取，不暴露给 Vite client。`/api/mivo/generate` 用 JSON 请求，代理上游超时约 110s；`/api/mivo/edit` 用 multipart 请求，代理上游超时 180s，客户端超时 185s。P1 edit 现状必须标记为 `MITIGATED_NOT_FIXED`：真实上游 edit 仍慢，权威交接记录实测约 54.6s 到 98s，本轮只是放宽等待窗口，不是性能修复。

当前功能闭环状态：

- M0 图像代理：数据/API 链路已交付；密钥隔离在 Node 中间层；本轮未重新验证。
- M1 文生图/图生图：store 到 client 到 Vite proxy 到结果落节点/edge 的链路已实现；图生图在有源图或 reference 时走 edit API，纯 prompt 走 generate API。
- M5 衍生模型：`CanvasEdge` + `sourceNodeId` + `aiWorkflow.sourceNodeIds` + 派生 markup edge 已实现；mock variation 与真实生成路径并存。
- P1 局部重绘 edit：mask 前端不在本清单 scope；本层只确认 edit client/proxy 超时窗口放宽，状态为 `MITIGATED_NOT_FIXED`。

## 文件/模块清单

### `src/main.tsx`

- 职责：React 应用入口，导入全局 `index.css`，用 `createRoot` 将 `App` 挂载到 `#root`，外包 `StrictMode`。
- 关键导出/接口/类型：无导出；直接渲染 `App`。
- 代码现状：完成。文件很薄，没有业务逻辑。
- 依赖与数据流：依赖 `react-dom/client`、`App.tsx`、`index.css`；下游由 `App` 承接全部应用编排。
- 功能闭环状态：对 M0/M1/M5/API 无直接逻辑，只提供应用启动闭环。

### `src/App.tsx`

- 职责：应用根组件。管理项目侧栏开合/peek/pin、workspace view、AI panel 开合、资产抽屉 drop、详情弹窗、mask 取消请求和 `MivoCanvas` 外层回调。
- 关键导出/接口/类型：默认导出 `App`；本地 `ProjectSidebarState`；使用 `ExternalAssetDropHandler`、`WorkspaceView`。
- 代码现状：完成。含 P3 修复：`handleMaskEditActiveChange(active)` 在进入 mask edit 时记录原 AI panel 状态并收起，退出时按原状态恢复，避免 mask 浮层和 AI panel 拥挤。
- 依赖与数据流：从 `useCanvasStore` 读取 `sceneId`；向 `MivoCanvas` 传 `onOpenGeneratePanel`、`onRegisterExternalAssetDrop`、`onMaskEditActiveChange`、`maskCancelRequestId`；向 `AIToolPanel` 传 open/toggle/focus；`LibraryWorkspace` 负责资产抽屉；`InspectorPanel` 负责详情。
- 功能闭环状态：M1 的 AI panel 开合入口完整；P3 已闭环；M0/API 不在此处直接调用；mask edit 的 API 触发在画布/状态层，不在本文件。

### `src/store/canvasStore.ts`

- 职责：Zustand 主 store。统一管理 canvases、active document 的 nodes/edges/tasks、选择态、剪贴板、undo/redo、导入、裁剪、文本/markup/section、AI slot、批注、生成和编辑结果落盘。
- 关键导出/接口/类型：导出 `useCanvasStore`、`scenes`、`CanvasGenerationOptions`、选择/分布相关类型。核心 action 包括 `generateVariations`、`generateImageEdit`、`generateBesideNode`、`generateIntoAiSlot`、`generateFromAnnotation`、`commitGenerationResult`、`getAiContextSnapshot`。
- 代码现状：主体完成，但混合了真实 API 路径和 mock 路径。`generateBesideNode`/`generateIntoAiSlot`/`generateImageEdit` 会真实调用 `generateMivoImage` 或 `editMivoImage`；`generateVariations` 和 `generateFromAnnotation` 仍使用 mock/demo 图片逻辑。persist version 为 7，状态存在 localStorage `mivo-canvas-demo`。
- 依赖与数据流：调用 `assetBlobForNode`、`editMivoImage`、`generateMivoImage`、`saveGeneratedAsset`；调用 `buildAiContextSnapshot`、`chooseAdjacentPlacement`；从 `demoScenes` 创建默认 scene；从 `mockGenerationAdapter` 生成 mock variants。UI 层的 `MivoCanvas`、`AIToolPanel`、action bar、context menu 等通过 store action 驱动状态变化。
- 功能闭环状态：
  - M1：闭环。生成任务先写 running task，API 返回后 `commitGenerationResult` 保存图片并创建结果 node/edge，失败则写 failed task 并继续抛错。
  - M5：闭环。`commitGenerationResult` 写 `sourceNodeId`、`parentIds`、`aiWorkflow.sourceNodeIds` 和 `CanvasEdge`；`syncDerivationEdgeNodes` 根据 edges 生成锁定的 arrow markup 可视边。
  - P1：API 数据侧可走 `editMivoImage`，但上游慢未解决；状态为 `MITIGATED_NOT_FIXED`。
  - 已知问题/半成品：variation 与 annotation 生成仍是 mock；task progress 固定为 20 -> 100/failed，没有真实进度。

### `src/store/aiCanvasWorkflow.ts`

- 职责：AI 工作流辅助模块。计算新结果节点相对源节点的避障放置位置，并从 store 状态构建 AI 上下文快照。
- 关键导出/接口/类型：`chooseAdjacentPlacement(...)`、`buildAiContextSnapshot(state)`。
- 代码现状：完成。`buildAiContextSnapshot` 会过滤隐藏节点和派生 edge markup 节点，汇总 summary、nodes、edges、links，并对 links 去重。
- 依赖与数据流：由 `canvasStore.ts` 调用。输入是 sceneId/nodes/edges/selection；输出给 AI context preview 或后续 agent 上下文。
- 功能闭环状态：M5 上下文序列化闭环；能表达 `parent`、`connector`、edge type、`aiWorkflow.operation` 等链接。未验证是否已接入真实 LLM 上下文消费方。

### `src/store/demoScenes.ts`

- 职责：定义 demo 初始场景、真实 demo 图片列表、节点工厂和 scene snapshot。
- 关键导出/接口/类型：`modelNames`、`realCaseImages`、`makeNode`、`scenes()`、`snapshotFromScene(sceneId)`。
- 代码现状：完成。`character-flow`、`variants`、`task-states`、`stress-test`、`asset-handoff`、`empty` 六个 demo scene；默认图片指向 `public/demo-assets/courage-*.jpg`。
- 依赖与数据流：被 `canvasStore.ts` 用于初始化 canvases、reset scene 和 mock fallback；被 `mockGeneration.ts` 复用 `makeNode`、`realCaseImages`。
- 功能闭环状态：支撑 demo 基线和 mock 结果。与真实生成 API 无直接通信。

### `src/store/mockGeneration.ts`

- 职责：提供 mock variation adapter，基于源节点生成 4 个 demo variation node 和 done task。
- 关键导出/接口/类型：`mockGenerationAdapter: GenerationAdapter`。
- 代码现状：半成品/降级路径。只覆盖 `generateVariations`，使用 `realCaseImages`，不走真实 API，不保存新 blob。
- 依赖与数据流：被 `canvasStore.generateVariations` 调用；生成的 nodes 仍包含 `aiWorkflow.kind='result'`、`operation='variation'`、`sourceNodeIds`，随后 store 写入 edges。
- 功能闭环状态：M5 mock 衍生闭环；M1 真实文生图/图生图不依赖它。

### `src/types/mivoCanvas.ts`

- 职责：画布领域核心类型定义。
- 关键导出/接口/类型：`ToolId`、`CanvasNodeType`、`CanvasAssetNodeType`、`CanvasEdgeType`、`CanvasMaskBounds`、`CanvasEdge`、`CanvasAiWorkflow`、`MivoCanvasNode`、`AiCanvasContextSnapshot`、`CanvasTask`、`MivoCanvasSnapshot`、`CanvasDocument`、`SceneDefinition`。
- 代码现状：完成。M5 数据结构已明确包含 node/edge 双模型：`MivoCanvasNode.sourceNodeId`、`parentIds`、`generation.maskBounds`、`aiWorkflow.sourceNodeIds` 和 `CanvasEdge { from,to,type,prompt,createdAt }`。
- 依赖与数据流：被 store、workflow、client 类型和画布组件广泛引用，是数据合约中心。
- 功能闭环状态：M0 无直接关系；M1/M5/P1 的数据骨架完整。已知限制是 `CanvasEdgeType` 只有 `generate|edit`，细分操作依赖 `aiWorkflow.operation`。

### `src/types/generation.ts`

- 职责：图像生成/编辑请求响应与生成 adapter 类型。
- 关键导出/接口/类型：`MivoImageRatio`、`MivoImageQuality`、`MivoGenerateRequest`、`MivoEditRequest`、`MivoImageResponse`、`GenerationAdapter`、`CommittedGenerationImage`、`CommitGenerationResultPayload`。
- 代码现状：完成。Client 请求类型支持 AbortSignal；edit 请求包含主图、mask、reference；commit payload 可携带 `maskBounds`、taskId、placement。
- 依赖与数据流：被 `mivoImageClient.ts`、`canvasStore.ts`、`mockGeneration.ts` 使用。`MivoImageResponse` 只要求 `images[].b64`，保存阶段再转 Blob。
- 功能闭环状态：M1/P1 API 类型闭环；不直接表达 upstream 原始 `data[].b64_json`，该归一化在 `vite.config.ts` 完成。

### `src/lib/mivoImageClient.ts`

- 职责：浏览器侧图像 API 客户端。封装 generate/edit 请求、超时、错误读取、响应校验和画布节点资产读取。
- 关键导出/接口/类型：`generateMivoImage(request)`、`editMivoImage(request)`、`assetBlobForNode(node)`。
- 代码现状：完成但 P1 仅缓解。`generateMivoImage` POST JSON 到 `/api/mivo/generate`，默认超时 `mivoRequestTimeoutMs = 110_000`；`editMivoImage` POST FormData 到 `/api/mivo/edit`，默认超时 `mivoEditRequestTimeoutMs = 185_000`；`assetBlobForNode` 优先读 IndexedDB/本地导入资产，失败再 fetch `assetUrl`。
- 依赖与数据流：被 `canvasStore.ts` 的真实生成/编辑 action 调用；向 Vite middleware 发请求；接收 `{ images: [{ b64 }] }` 后交给 store 保存。
- 功能闭环状态：
  - M0/M1：client 到代理的生成链路完整。
  - P1：客户端等待窗口放宽到 185s，状态 `MITIGATED_NOT_FIXED`；没有真实进度、取消 UI 只依赖传入 signal 的上层能力。
  - 已知问题：`assetBlobForNode` fetch public/demo asset 可行，但远端跨域资产是否可读取未在本轮验证。

### `vite.config.ts`

- 职责：Vite 配置 + dev server Node 中间层。提供 React 插件、本地素材 API、Eagle API proxy、Pinterest 占位状态、Mivo image generate/edit proxy。
- 关键导出/接口/类型：默认导出 `defineConfig(...)`；内部关键函数 `proxyMivoGenerate`、`proxyMivoEdit`、`fetchUpstreamWithTimeout`、`readLocalAssets`、`localAssetLibraryPlugin`。
- 代码现状：完成。`/api/mivo/generate` 校验 JSON prompt，映射 ratio/quality 到 size，转发到 `${mivoImageApiBase}/generations`；`/api/mivo/edit` 解析 multipart，要求 image/prompt，可带 mask/reference，转发到 `${mivoImageApiBase}/edits`。响应归一化支持 upstream `data[].b64_json` 和内部 `images[].b64` 两种形态。
- 依赖与数据流：
  - 读取环境变量 `MIVO_IMAGE_API_KEY`、`MIVO_ASSET_DIR`、`MIVO_EAGLE_API_URL`。
  - `/api/mivo/generate` 和 `/api/mivo/edit` 被 `src/lib/mivoImageClient.ts` 调用。
  - `/api/mivo/local-assets*`、`/api/mivo/eagle/*` 被素材库/导入链路调用。
- 超时/限制：
  - generate 上游超时 `mivoUpstreamTimeoutMs = 110_000`。
  - edit 上游超时 `mivoEditUpstreamTimeoutMs = 180_000`。
  - multipart 图片请求最大 40MB；JSON 请求最大 1MB。
- 功能闭环状态：
  - M0：图像代理闭环，API key 隔离在 Node 中间层。
  - M1：generate/edit 数据代理闭环。
  - P1：代理等待窗口放宽到 180s，状态 `MITIGATED_NOT_FIXED`。
  - 已知问题：这是 Vite dev middleware，不是独立生产 API 服务；生产部署路径未在本轮确认。

### `package.json`

- 职责：项目 npm 元数据、脚本、依赖版本声明。
- 关键导出/接口/类型：scripts：`dev`、`build`、`lint`、`preview`、`test:e2e`。
- 代码现状：完成。`build` 是 `tsc -b && vite build`；`test:e2e` 是 `node scripts/e2e-smoke.mjs`。
- 依赖与数据流：运行栈包括 React 19、Vite 8、TypeScript 6、Zustand 5、Leafer、Playwright。
- 功能闭环状态：支撑本层构建与 e2e；本轮未重新执行脚本。权威起点称 `npm run build` 与 `npm run test:e2e` 已通过。

### `tsconfig.json`

- 职责：TypeScript project references 根配置。
- 关键导出/接口/类型：引用 `./tsconfig.app.json` 和 `./tsconfig.node.json`。
- 代码现状：完成。根配置不直接 include 源码。
- 依赖与数据流：被 `tsc -b` 使用，串联 app 与 Vite node config 类型检查。
- 功能闭环状态：构建骨架完整，本轮未重新验证。

### `tsconfig.app.json`

- 职责：浏览器端 `src` TypeScript 配置。
- 关键导出/接口/类型：`target ES2023`、`lib ES2023/DOM`、`moduleResolution bundler`、`jsx react-jsx`、`noEmit`、`noUnusedLocals`、`noUnusedParameters`、`erasableSyntaxOnly`。
- 代码现状：完成。严格度偏高，能约束前端死代码/未用参数。
- 依赖与数据流：include `src`；被 `npm run build` 的 `tsc -b` 检查。
- 功能闭环状态：支撑 M1/M5/P1 前端类型闭环；本轮未重新验证。

### `tsconfig.node.json`

- 职责：Node/Vite 配置侧 TypeScript 配置。
- 关键导出/接口/类型：`types: ["node"]`、include `vite.config.ts`、`noEmit`、同样开启 unused/erasable/fallthrough 检查。
- 代码现状：完成。
- 依赖与数据流：保证 `vite.config.ts` 中 Node 中间层类型参与 `tsc -b`。
- 功能闭环状态：支撑 M0 Node proxy 类型检查；本轮未重新验证。

### `scripts/e2e-smoke.mjs`

- 职责：Playwright e2e smoke。自启动 Vite dev server、搭建本地素材 fixture 和 Eagle mock server，拦截 `/api/mivo/generate` 与 `/api/mivo/edit`，覆盖 UI、导入、素材库、生成、AI 上下文、mask edit 等大量回归。
- 关键导出/接口/类型：无导出；脚本入口式执行。内部读取 store 动态 module，定义 `readCanvasState`、`waitForCanvasState`、`verifyMaskEditFlow` 等 helper。
- 代码现状：完成但偏大。脚本会写 `test-artifacts/*` fixture 和截图；对真实图像 API 使用 Playwright route mock，不打真实上游。
- 依赖与数据流：
  - 启动 `npm run dev -- --host 127.0.0.1 --port ${MIVO_E2E_PORT || 5174} --strictPort`。
  - 设置 `MIVO_ASSET_DIR` 指向 fixture，`MIVO_EAGLE_API_URL` 指向 mock server。
  - 通过 route mock 检查 generate/edit 请求，尤其 edit 请求必须包含 `image:1` 和 `mask:1`。
- 功能闭环状态：
  - M1/M5：验证立即生成、slot 生成、annotation mock 生成、AI context links 去重。
  - P1：验证 vertical/horizontal source 上 point/box/brush 三种 mask edit 都创建新 image node 和 edit edge，并发起一次 `/api/mivo/edit`；但由于 route mock，不能证明真实上游耗时或成功率。
  - 已知问题：脚本覆盖面很广，失败定位成本可能较高；本轮未重新运行。

### `scripts/e2e-helpers.mjs`

- 职责：e2e 共享 helper。提供等待、server 探活、几何比较、library layout 读取与断言。
- 关键导出/接口/类型：`wait`、`waitForServer`、`rectsOverlap`、`nearlyEqual`、`createPageReaders`、`assertLibraryLayoutStable`。
- 代码现状：完成。纯 helper，无业务状态。
- 依赖与数据流：被 `scripts/e2e-smoke.mjs` 导入。
- 功能闭环状态：支撑 e2e 验证骨架；不直接参与 M0/M1/M5/P1 运行时链路。

## 关键现状与风险汇总

- `p1_edit_timeout = MITIGATED_NOT_FIXED`：源码确认 client/proxy 超时为 185s/180s；权威交接记录显示上游 edit 仍约 55s 到 98s，当前只是能等更久。
- 真实 API 与 mock 并存：M1 的 prompt/image 生成路径已走真实 client/proxy；variation 和 annotation 仍有 mock 路径，不能全部视为真实模型闭环。
- M5 数据模型闭合度较高：结果 node 同时写 `sourceNodeId`、`parentIds`、`aiWorkflow.sourceNodeIds`，edges 还能生成可视 markup arrow；但细分语义分散在 `CanvasEdge.type` 和 `aiWorkflow.operation` 两层。
- 构建/e2e 状态来自既有文档，本轮未重新执行；若要作为发布验收，还需重新运行 `npm run build` 和 `npm run test:e2e`。
- 本轮观察到工作区当前 git 状态不干净，且当前分支显示为 `demo/improve-hud...origin/demo/improve-hud`，与权威文档中的 `demo/canvas-ai @ 8fa20b9` 不一致；清单内容按当前工作区源码读取结果记录。
