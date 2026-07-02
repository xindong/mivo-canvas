# MivoCanvas CODE-INVENTORY part: 应用面板 + 素材/Eagle + 资源 lib

> 盘点日期：2026-07-02  
> 权威起点：`docs/demo/DEMO-STATUS.md`、`docs/demo/review/context-handoff-2026-07-02.md`  
> 源码快照：HEAD `8fa20b9`；当前本地分支观测为 `demo/improve-hud`，与任务指定 `demo/canvas-ai @ 8fa20b9` 提交一致。  
> 方法：只读源码盘点；未运行 build/e2e；运行态 Eagle、本地素材目录、Pinterest 连接均未现场验证。

## 应用外壳 + 素材链路总览

应用外壳由 `src/App.tsx` 组装：左侧 `ProjectSidebar` 负责 Canvas/Assets/Plugins/Skills 视图切换，中央 `MivoCanvas` 是画布主体验，右侧 `AIToolPanel` 是 M1 生成参数与主输入框，底部 `TaskQueue` 投影 store 中任务状态，`TopBar` 负责画布标题、复制/导出/导入 JSON 归档，`InspectorPanel` 作为详情弹层查看和操作选中节点。

素材库入口有两种形态：

- `workspaceView === 'assets'` 且仍在画布工作区时，`App.tsx` 把 `LibraryWorkspace type="assets" variant="canvas-drawer"` 作为 Eagle/本地素材抽屉覆盖在画布上。
- `workspaceView === 'plugins' | 'skills'` 时，`LibraryWorkspace` 作为整页 library workspace，但 plugins/skills 当前是静态产品原型列表。

Eagle 到画布的闭环数据流：

1. `LibraryWorkspace` 调 `/api/mivo/eagle/status`、`/folders`、`/tags`、`/assets?limit=120&offset=0&folderId=...`。
2. `vite.config.ts` dev middleware 转发到 Eagle 本地 API（默认 `http://127.0.0.1:41595`），并把 Eagle item 规范化为 `AssetItem`，其中 `url=/api/mivo/eagle/assets/:id/file`、`thumbnailUrl=/api/mivo/eagle/assets/:id/thumbnail`。
3. 抽屉中图片优先读 thumbnail，失败回退原图；双击或 lightbox 的 Add to canvas 走 `importImageUrlToCanvas(asset.url, ...)`，先 fetch 原图再存入 IndexedDB，最终调用 `canvasStore.addImportedImage` 变成画布 image node。
4. 拖拽走 `writeLocalAssetDragPayload` 写入 `application/x-mivo-local-asset`，`MivoCanvas` drop 侧用 `parseLocalAssetDragPayload` 读出，再 `importImageUrlToCanvas` 放到 drop 坐标。
5. 复制走 `copyAssetsToClipboard` 写入 store 的 `clipboardAssets`；画布全局 paste handler 优先检测 `clipboardAssets`，调用 `pasteClipboardAssets(viewportCenter())` 生成 image nodes。P2 已在 `canvasStore.pasteClipboardAssets` 修为网格排布：按 `ceil(sqrt(n))`、最多 3 列，依据每张素材的显示尺寸计算 cell，避免多选粘贴重叠。

本地素材目录到画布的闭环数据流：

1. `LibraryWorkspace` 调 `/api/mivo/local-assets`。
2. `vite.config.ts` 从 `MIVO_ASSET_DIR` 或 `~/Desktop/Images`、`~/Desktop/images` 读取一级图片文件，返回 base64url 编码 id 和 `/api/mivo/local-assets/:id` URL。
3. 双击/拖拽/详情添加同样经 `importImageUrlToCanvas` 导入，最终保存为 IndexedDB `mivo-asset:` 引用并进入 store。
4. 中间层文件读取有 root 边界校验：`/api/mivo/local-assets/:id` 会 decode 路径并用 `isInsideRoot` 防止越权读根目录外文件。

本地文件导入/粘贴/归档链路：

- 文件拖拽/选择走 `canvasAssetImport.ts`，支持 image、Markdown、PDF、video。图片/视频会读取尺寸，Markdown 会估算文档尺寸并在长文时进入 preview display mode。
- 浏览器剪贴板图片粘贴在 `useCanvasInteractionController` 中转成 File 后导入。
- `assetStorage.ts` 使用 IndexedDB `mivo-canvas-assets` 存 blob，以 `mivo-asset:<id>` 作为画布节点 `assetUrl`。
- `canvasArchive.ts` 导出时把快照中所有 `mivo-asset:` blob 序列化为 data URL；`TopBar` 导入时用 `snapshotValidation.ts` 校验 archive/snapshot，再 restore blob 后替换 store snapshot。

主要风险与半成品：

- Eagle 与本地素材中间层只在 Vite dev middleware 内实现，生产部署路径未见同等后端实现。
- Eagle 连接、缩略图、原图路径解析、本地目录读取均未在本次任务现场验证。
- Pinterest 只有 `/api/mivo/pinterest/status` 固定返回 `{ connected:false, mode:'prototype' }`，UI 也是 OAuth 交互原型。
- Plugins/Skills library 是静态原型列表，未接真实插件/技能管理。
- `LibraryWorkspace` 负责范围很大：本地素材、Eagle、Pinterest 原型、plugins/skills 静态列表、lightbox、context menu、多选和拖拽全部在一个组件内，后续改动冲突面较大。

## 文件清单

### `src/app/AIToolPanel.tsx`

- 职责：M1 右侧 AI 生成面板；主提示词输入、参考图上传/拖拽/粘贴、比例/质量参数、生成动作入口、AI context 预览。
- 关键导出/组件/接口：`AIToolPanel`；`AIToolPanelProps`；内部 `ReferenceFile`；固定 `ratioOptions`、`qualityOptions`。
- 代码现状：完成。支持展开/折叠态，折叠态仍保留上传与生成快捷按钮；用 `AbortController` 支持取消当前生成；卸载时 revoke reference preview URL。部分按钮如“实践范例”“风格转变”“表情包”、模型 select 是 UI 占位，无真实菜单。
- 依赖数据流：读 `nodes`、`selectedNodeId(s)`；调用 `addAiSlotNode`、`addAnnotationNode`、`generateBesideNode`、`generateIntoAiSlot`、`generateFromAnnotation`、`updatePrompt`、`updateTextNode`、`getAiContextSnapshot`。参考图以 File 形式传给 store 工作流，store 再进入 `aiCanvasWorkflow`/`mivoImageClient`。
- 相关功能闭环状态：文生图/图生图主链路已闭环；图生图依赖参考图列表；运行时 API 未在本次盘点复测。

### `src/app/TaskQueue.tsx`

- 职责：展示生成任务队列的轻量状态栏。
- 关键导出/组件/接口：`TaskQueue`；内部 `TaskIcon`。
- 代码现状：完成但范围很窄。只展示前 3 个 tasks，空态为 `No active task`；无任务取消、详情、重试入口。
- 依赖数据流：读 `useCanvasStore(state.tasks)`；任务由 AI 工作流和 store 写入。
- 相关功能闭环状态：任务状态投影闭环；复杂队列管理未实现。

### `src/app/LibraryWorkspace.tsx`

- 职责：M4 素材库工作区与 Eagle 抽屉宿主；同时承载本地素材、Eagle 素材、Pinterest 连接原型、Plugins/Skills 静态列表。
- 关键导出/组件/接口：`LibraryWorkspace`；props `type: 'assets' | 'plugins' | 'skills'`、`variant?: 'workspace' | 'canvas-drawer'`、`onOpenCanvas`。内部关键函数：`loadLocalAssets`、`loadEagleTags`、`loadEagleAssets`、`addAssetToCanvas`、`copyAssetsToInternalClipboard`、`copyOneAsset`、`copySelectedAssets`、`beginAssetDrag`、`toggleAssetSelection`、`selectAssetRange`。
- 代码现状：M4 Eagle 素材抽屉完成。支持 status/folders/tags/assets 加载；folder 切换；tag 目录和本地 fallback tag 统计；masonry 列表；checkbox 多选、cmd/ctrl 多选、shift 范围选择；右键 Copy；lightbox 预览；双击/按钮添加到画布；拖拽到画布；thumbnail 失败回退原图。Pinterest 是原型，占位文案明确说明真实连接要等 Mivo account services。Plugins/Skills 是静态 rows。
- 依赖数据流：fetch `/api/mivo/local-assets`、`/api/mivo/eagle/status|folders|tags|assets`、`/api/mivo/pinterest/status`；素材 add 走 `importImageUrlToCanvas` -> `assetStorage.saveImportedAsset` -> `canvasStore.addImportedImage`；拖拽写 `canvasAssetDrag` payload 给 `MivoCanvas`；复制写 `canvasStore.copyAssetsToClipboard`，粘贴由画布全局 paste 调 `pasteClipboardAssets`。
- 相关功能闭环状态：Eagle 单选/多选复制到画布链路闭环；P2 多选粘贴网格排布在 store 侧已修。Eagle runtime 未现场验证；Pinterest 未闭环。

### `src/app/assetLibraryModel.ts`

- 职责：素材库前后端数据模型与展示工具函数。
- 关键导出/组件/接口：`AssetSourceId`、`AssetItem`、`CanvasAssetClipboardItem`、`EagleTagItem`、`AssetSource`、`LocalAssetResponse`、`EagleFolder`、`EagleStatus`、`EagleAssetsResponse`、`EagleTagsResponse`、`EagleFoldersResponse`、`PinterestStatus`；`formatBytes`、`dimensionsLabel`、`thumbnailUrlFor`、`assetMatchesQuery`、`flattenEagleFolders`。
- 代码现状：完成。模型覆盖本地/Eagle/Pinterest 的通用字段；clipboard item 是 AssetItem 子集。
- 依赖数据流：`LibraryWorkspace` 用这些类型解析中间层响应；`canvasStore` 引用 `CanvasAssetClipboardItem` 保存内部素材剪贴板。
- 相关功能闭环状态：支撑本地/Eagle 数据闭环；Pinterest 类型仅服务 prototype status。

### `src/app/InspectorPanel.tsx`

- 职责：选中节点详情面板；展示预览、元信息、prompt、Markdown 详情、收藏、生成 variations、下载原始素材、复制 JSON/source。
- 关键导出/组件/接口：`InspectorPanel`；内部 `renderNodePreview`、`metaForNode`、`markdownStatsFor`、`detailsConfigFor`。
- 代码现状：完成。按 `renderKindForNode` 支持 image/task/video/pdf/markdown/text/annotation/section/markup/ai-slot。Markdown 可在 details 中切 rendered/raw，且可设置画布 display mode。`Make variations` 对 image/task 开放。
- 依赖数据流：读选中 node；调用 `updatePrompt`、`setMarkdownDisplayMode`、`toggleFavorite`、`generateVariations`；资源预览通过 `useResolvedAssetUrl`；下载通过 `downloadCanvasNodeOriginal`。
- 相关功能闭环状态：详情查看、资源下载、Markdown 预览闭环；具体 variations 生成依赖 store/AI API，未在本次盘点复测。

### `src/app/TopBar.tsx`

- 职责：顶部画布标题区与画布菜单；rename/duplicate/delete；复制 JSON、导出 JSON、导入 JSON。
- 关键导出/组件/接口：`TopBar`；内部 `downloadText`。
- 代码现状：完成。`Move to project` 是 disabled 占位。导出使用 `stringifyCanvasArchive`，导入先 `parseCanvasSnapshot`，再 `restoreCanvasImportAssets`，最后 `replaceSnapshot`。
- 依赖数据流：读 `nodes`、`tasks`、`sceneId`、`canvases`；调用 `renameCanvas`、`duplicateCanvas`、`deleteCanvas`、`getSnapshot`、`replaceSnapshot`；归档依赖 `canvasArchive`、`snapshotValidation`、`assetStorage`。
- 相关功能闭环状态：画布 JSON 归档闭环；导入错误会显示 `top-error`；未现场验证实际文件导入。

### `src/app/ProjectSidebar.tsx`

- 职责：左侧项目/画布导航、Assets/Plugins/Skills 入口、项目树和 settings 菜单。
- 关键导出/组件/接口：`WorkspaceView = 'canvas' | 'assets' | 'plugins' | 'skills'`；`ProjectSidebar`。
- 代码现状：完成 UI 主链路。项目组是静态 `projectGroups`；starter canvas 静态；用户新建的 canvas 以 standalone 动态列出。Search、New project、settings 菜单项基本为 UI 占位。
- 依赖数据流：读 `sceneId`、`canvases`；调用 `loadScene`、`createCanvas`；通过 props 通知 App 切换 view。
- 相关功能闭环状态：画布导航和创建 standalone canvas 闭环；项目管理/搜索未闭环。

### `src/app/ProjectSidebarControls.tsx`

- 职责：左侧 sidebar 关闭后的悬浮触发器，支持 hover peek 和 click open。
- 关键导出/组件/接口：`ProjectSidebarControls`。
- 代码现状：完成。120ms 延时 peek；touch pointer 不触发 hover；unmount 清理 timer。
- 依赖数据流：纯 props 回调：`onOpenProjectSidebar`、`onPeekProjectSidebar`、`onPeekEnabled`。
- 相关功能闭环状态：侧栏收起/窥视交互闭环。

### `src/lib/canvasAssetImport.ts`

- 职责：本地文件/URL 导入画布；统一支持 image、Markdown、PDF、video，并计算默认显示尺寸与 metadata。
- 关键导出/组件/接口：`AddImportedImage`、`AddImportedFileNode`、`canvasAssetNodeTypeForFile`、`canImportCanvasFile`、`markdownDocumentWidth`、`markdownPreviewHeight`、`markdownShouldUsePreviewMode`、`importFileToCanvas`、`importImageFileToCanvas`、`importImageFilesToCanvas`、`importFilesToCanvas`、`fileFromImageUrl`、`importImageUrlToCanvas`。
- 代码现状：完成。多文件导入会先 prepare 后按行布局，最大行宽 860；Markdown 高度估算并对长文/多图启用 preview；video metadata 最多等 2.2s。
- 依赖数据流：依赖 `saveImportedAsset` 持久化 blob；调用传入的 store action `addImportedImage`/`addImportedFileNode`。
- 相关功能闭环状态：拖拽/选择/URL 导入闭环；URL 导入依赖目标 URL 可被浏览器 fetch。

### `src/lib/canvasAssetDrag.ts`

- 职责：定义素材库到画布的 DataTransfer payload。
- 关键导出/组件/接口：`localAssetDragType = 'application/x-mivo-local-asset'`、`LocalAssetDragPayload`、`canReadLocalAssetDrag`、`parseLocalAssetDragPayload`、`writeLocalAssetDragPayload`。
- 代码现状：完成。payload 最低要求 `name` 和 `url`；写入时同时写 `text/plain` 作为退化文本。
- 依赖数据流：`LibraryWorkspace` 写 payload；`App` 和 `MivoCanvas` 读 payload 并导入。
- 相关功能闭环状态：本地/Eagle 素材拖拽到画布闭环。

### `src/lib/assetStorage.ts`

- 职责：浏览器端素材 blob 存储、读取、序列化和恢复。
- 关键导出/组件/接口：`SerializedCanvasAsset`、`ImportedAssetFile`、`importedAssetUrl`、`isImportedAssetUrl`、`saveImportedAsset`、`saveGeneratedAsset`、`resolveAssetUrl`、`readImportedAssetFile`、`serializeImportedAsset`、`restoreSerializedAsset`。
- 代码现状：完成。使用 IndexedDB `mivo-canvas-assets`/`assets`；图片导入会尝试读取尺寸，并对 PNG/WebP 扫 alpha 判断透明；过大图片 alpha 扫描限制在 1200 万像素以内。
- 依赖数据流：导入链路写入；`useResolvedAssetUrl`、下载、归档、AI 读图链路读取；归档导出/导入进行 data URL serialize/restore。
- 相关功能闭环状态：本地 blob 生命周期闭环；依赖浏览器 IndexedDB 可用。

### `src/lib/assetDownload.ts`

- 职责：下载画布节点原始素材。
- 关键导出/组件/接口：`downloadCanvasNodeOriginal`。
- 代码现状：完成。`mivo-asset:` 先读 IndexedDB blob；普通 URL 直接 fetch；按 MIME 推断扩展名并清理非法文件名。
- 依赖数据流：`InspectorPanel` 调用；依赖 `readImportedAssetFile`。
- 相关功能闭环状态：下载能力闭环；跨源普通 URL 下载依赖 fetch 权限。

### `src/lib/canvasImageSource.ts`

- 职责：把画布 image node 转为可提交给生成/edit API 的 File。
- 关键导出/组件/接口：`readCanvasImageBlob`。
- 代码现状：完成。优先读 IndexedDB imported asset；否则 fetch `resolvedAssetUrl || node.assetUrl`。
- 依赖数据流：AI 生成/编辑链路读取选中图像源时使用；依赖 `assetStorage.readImportedAssetFile`。
- 相关功能闭环状态：导入图/远程图作为 AI 上下文闭环；远程图仍受 CORS/fetch 可达性影响。

### `src/lib/useResolvedAssetUrl.ts`

- 职责：React hook，将 `mivo-asset:` 内部 URL 解析成 object URL 供 img/video/iframe 使用。
- 关键导出/组件/接口：`useResolvedAssetUrl`。
- 代码现状：完成。对 object URL 做 cleanup；外部 URL 原样返回；asset 切换时避免旧 promise 写错状态。
- 依赖数据流：`InspectorPanel` 等预览节点资源时使用；依赖 `assetStorage.resolveAssetUrl`。
- 相关功能闭环状态：本地导入素材预览闭环。

### `src/lib/canvasArchive.ts`

- 职责：画布快照归档格式 v2 的创建、字符串化和导入素材恢复。
- 关键导出/组件/接口：`MivoCanvasArchive`、`createCanvasArchive`、`stringifyCanvasArchive`、`restoreCanvasImportAssets`。
- 代码现状：完成。只序列化 snapshot 中被节点引用的 `mivo-asset:` URL，去重后写入 archive `assets`。
- 依赖数据流：`TopBar` 导出/复制调用；导入时与 `snapshotValidation` 配合恢复 IndexedDB assets 后替换 snapshot。
- 相关功能闭环状态：含本地素材的 JSON 归档闭环；未复测大文件体积表现。

### `src/lib/snapshotValidation.ts`

- 职责：解析并校验 canvas snapshot 或 archive JSON。
- 关键导出/组件/接口：`ParsedCanvasImport`、`parseCanvasSnapshot`。
- 代码现状：完成。校验 node/task/edge/workflow/markup/crop/mask/serialized asset 等结构；支持旧 `version:1` snapshot 和新 `kind:'mivo-canvas-archive', version:2` archive。
- 依赖数据流：`TopBar` 导入 JSON 前调用；成功时返回 `{ snapshot, assets }`。
- 相关功能闭环状态：归档导入防坏数据闭环；是结构校验，不校验业务引用完整性。

### `src/lib/demoImages.ts`

- 职责：生成 demo 场景用的内存 data URL 占位图。
- 关键导出/组件/接口：`createDemoImage`。
- 代码现状：完成。用 canvas 绘制 character/environment/variant/asset 四类图，按 options JSON cache。
- 依赖数据流：demo scenes/节点初始化使用；不参与 Eagle/本地素材链路。
- 相关功能闭环状态：demo 视觉素材闭环。

### `src/lib/imageSizing.ts`

- 职责：统一导入图片的画布显示尺寸计算。
- 关键导出/组件/接口：`ImageDimensions`、`ImportedImageMetadata`、`importedImageDisplaySize`。
- 代码现状：完成。最长边限制 360，最短边通过 scale 下限保护；无尺寸时 fallback `230x302`。
- 依赖数据流：`canvasAssetImport`、`canvasStore.pasteClipboardAssets`、store 导入节点尺寸计算都会用。
- 相关功能闭环状态：导入/Eagle 粘贴显示尺寸闭环。

### `src/lib/MarkdownPreview.tsx`

- 职责：Markdown 渲染组件。
- 关键导出/组件/接口：`MarkdownPreview`。
- 代码现状：完成。使用 `react-markdown` + `remark-gfm`；空内容显示 `_Empty Markdown document_`；通过 `density` 控制 CSS 类。
- 依赖数据流：`InspectorPanel` 和画布 markdown 节点渲染侧使用。
- 相关功能闭环状态：Markdown 文件导入后的预览闭环。

### `vite.config.ts` 中间层素材路由

- 职责：Vite dev server 内的 Mivo 本地素材/Eagle/Pinterest/API 代理中间层。
- 关键导出/组件/接口：`localAssetLibraryPlugin`；素材相关 helper：`localAssetRoots`、`encodeAssetPath`、`decodeAssetPath`、`isInsideRoot`、`eagleApi`、`eagleThumbnailPathFor`、`sendEagleThumbnailFallback`、`eagleOriginalPathFor`、`readEagleItem`、`readLocalAssets`。
- 代码现状：
  - `/api/mivo/local-assets`：读取 `MIVO_ASSET_DIR` 或桌面 Images/images 的一级图片文件，去重 realpath，返回 root 和 assets。
  - `/api/mivo/local-assets/:id`：decode base64url 文件路径，校验在允许 roots 内，读文件并按文件头/MIME 返回。
  - `/api/mivo/eagle/status`：并发读 Eagle `/api/application/info` 与 `/api/library/info`，失败也返回 JSON `{ connected:false, message }`。
  - `/api/mivo/eagle/folders`：转发 Eagle `/api/folder/list`。
  - `/api/mivo/eagle/tags`：转发 `/api/tag/list` 并兼容 string/object tag。
  - `/api/mivo/eagle/assets`：转发 `/api/item/list`，支持 `limit`、`offset`、`folderId`、`tag/tags`，只保留图片扩展名，规范化成前端 `AssetItem` 字段。
  - `/api/mivo/eagle/assets/:id/thumbnail`：读 Eagle thumbnail path；失败时尝试回退原图，再失败返回 SVG placeholder。
  - `/api/mivo/eagle/assets/:id/file`：用 item info + thumbnail 所在目录推断原图路径，读原图返回；失败 404。
  - `/api/mivo/pinterest/status`：固定返回 prototype status。
- 依赖数据流：`LibraryWorkspace` 直接 fetch 这些路由；返回的 `url`/`thumbnailUrl` 被 `<img>`、导入、拖拽、复制使用。
- 相关功能闭环状态：dev 环境 Eagle、本地素材闭环；生产环境未见对应实现。Eagle 原图路径依赖“thumbnail 所在目录 + item name/ext 或目录扫描”策略，遇到 Eagle 库结构变化可能失效。
