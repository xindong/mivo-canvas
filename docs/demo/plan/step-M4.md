# MivoCanvas Demo · Step M4 Eagle 瀑布流素材库详细计划

## ① PHASE_GOAL

实现 M4：打开 MivoCanvas 素材库面板后，Vite 中间件读取 Eagle tag 目录和图片列表；面板顶部或侧边展示 Eagle tag 目录 / 分类列表，点击某个 tag 后瀑布流展示该 tag 下被 Eagle 索引的图片；图片区域用 CSS columns 瀑布流展示缩略图卡片，卡片不显示每图 tag；卡片支持点击查看 lightbox 大图、右键复制单图、批量多选复制多图；复制后的 Eagle asset 进入 MivoCanvas 内部剪贴板，画布 Cmd+V / paste 生成 image node(s)；素材卡保留 `dragstart` / `dataTransfer`，拖入可见画布后复用现有 `handleCanvasDrop` 创建 image node。

前置依赖：
- Eagle 本地 API 可访问，默认 `http://127.0.0.1:41595`，配置点已在 `vite.config.ts:8`。
- 现有 Vite dev middleware 已有 `/api/mivo/eagle/status|folders|assets|assets/:id/thumbnail|assets/:id/file`；M4 新增 tag 目录端点，并让 assets 支持按 tag 拉取。
- 素材卡拖拽继续使用现有 MIME：`application/x-mivo-local-asset`，现有 `MivoCanvas.tsx:62-92` parser 与 `MivoCanvas.tsx:327-347` drop 链路保持可用。
- 现有节点剪贴板在 `canvasStore.ts:47` / `canvasStore.ts:83-84` / `canvasStore.ts:1272-1316`；画布快捷键和 paste 入口在 `useCanvasInteractionController.ts:1293-1297`、`useCanvasInteractionController.ts:1371-1398`；M4 的素材复制必须挂到这条内部链路上，而不是新造全局 paste 监听。

非目标：
- 不新增 `/api/mivo/eagle/search`，不做搜索框，不保留旧搜索 SC。
- 不引入 masonry/react-masonry/virtual-grid 等第三方布局库。
- 不做 Eagle 登录/授权流。
- 不导入 Open Design Library/SQLite，不扫描或冷归档 Eagle 原始库。
- 不实现 Pinterest 真连接。

Anti-fill / 禁止项：
- 禁止把 `q`、`keyword`、`query` 作为 M4 主路径；tag 分类只走 Eagle tag 目录与 tag 参数，不做搜索。
- 禁止让 `workspaceView === 'assets'` 继续整页替换 canvas；M4 的拖拽和粘贴验收要求素材库面板和画布同屏。
- 禁止用 CSS grid 固定等高卡片冒充瀑布流；M4 布局必须是 CSS columns，卡片 `break-inside: avoid`。
- 禁止在每张图片卡片上显示 tag chips；tag 只能作为面板级目录 / 分类列表出现。
- 禁止把 tag 目录伪造成从当前卡片 DOM 提取的标签集合；优先用 Eagle `/api/tag/list` 的真实 tag 目录，失败时才退回从已加载 assets 的 `tags` 聚合。
- 禁止新增或修改 `handleCanvasDrop` 的导入语义来完成本阶段；卡片 payload 必须兼容现有 `parseLocalAssetDragPayload` 的 `name` + `url` 字段。
- 禁止从 `text/plain` 解析任意 URL 创建 node；drop 仍只接受现有自定义 MIME 或浏览器 File。
- 禁止用浏览器 OS 剪贴板承载多图；多图复制必须写 MivoCanvas 内部 Zustand 剪贴板，画布 paste 从内部剪贴板读 N 个 asset 并创建 N 个 node。
- 禁止因为 `navigator.clipboard.write` 失败而判定单图复制失败；OS 剪贴板只作为外部 app 便利能力，内部剪贴板写入成功才是 MivoCanvas 粘贴的依据。
- 禁止让 lightbox、tag 目录项、multi-select checkbox 的点击冒泡成拖拽或误选；这些交互都必须 `stopPropagation()`。

## ② 精确改动清单

### 2.1 Vite dev middleware：Eagle tag 目录 + 按 tag 拉素材

- `vite.config.ts`
  - 锚点：`EagleItem` 类型在 `vite.config.ts:72-84`，Eagle helpers 在 `vite.config.ts:92-135`，现有 Eagle endpoints 在 `vite.config.ts:239-352`。
  - 新增类型：
    - `type EagleTag = string | { name?: string; tag?: string; id?: string; count?: number }`
  - 新增 endpoint，放在 `/api/mivo/eagle/assets` 泛匹配前：
    - `GET /api/mivo/eagle/tags`
    - 调 Eagle `eagleApi<EagleTag[]>('/api/tag/list')`。
    - normalize 输出 `{tags:[{id,name,count?}]}`；`name` 取 `tag.name || tag.tag || tag`，`id` 可用 name。
    - 失败返回 `502`，body 为 Eagle 错误 message；前端可 fallback 到 assets 聚合 tags。
  - 保留现有 `GET /api/mivo/eagle/assets`，扩展可选参数：
    - `tag=<tagName>` 或 `tags=<tagName>`。
    - 有 tag 时给 Eagle `/api/item/list` 传 `tags=<tagName>`；无 tag 时保持现有 `limit/offset/folderId` 行为。
    - 仍输出 `tags: Array.isArray(item.tags) ? item.tags.filter(Boolean) : []`，但这个字段只用于内部筛选/复制元数据，不在卡片上展示。
  - 可选 fallback：若实测 Eagle `/api/item/list?tags=` 不生效，前端用 `/api/mivo/eagle/assets` 全量结果按 `asset.tags?.includes(selectedEagleTag)` 客户端过滤；计划首选后端按 tag 拉，因为能更准确展示该 tag 下被索引的素材。
  - 开发可验证点：访问 `/api/mivo/eagle/tags` 返回真实 tag 目录；访问 `/api/mivo/eagle/assets?tag=<tag>&limit=80` 返回该 tag 下图片，asset 仍含 `url`、`thumbnailUrl`、`tags` 字段。

### 2.2 Asset model：tag 目录类型与 asset tags 元数据

- `src/app/assetLibraryModel.ts`
  - 锚点：`AssetItem.tags?: string[]` 在 `assetLibraryModel.ts:17`，`EagleAssetsResponse` 在 `assetLibraryModel.ts:50-52`。
  - 新增：
    - `export type EagleTagItem = { id: string; name: string; count?: number }`
    - `export type EagleTagsResponse = { tags: EagleTagItem[] }`
  - `AssetItem.tags` 保留为数据字段，但不用于每图视觉展示。
  - 若实现时发现 `tags` 在 API → `eagleAssetFromApi` 过程中丢失，只在 `eagleAssetFromApi` 做归一化，不改 `AssetItem` 契约。
  - 开发可验证点：`eagleAssetFromApi` 后 `AssetItem.tags` 仍是数组；`EagleTagItem[]` 可直接驱动左侧/顶部 tag 目录。

### 2.3 LibraryWorkspace：tag 目录分类 + 无 per-card tag 展示

- `src/app/LibraryWorkspace.tsx`
  - 锚点：imports 在 `LibraryWorkspace.tsx:1-28`，`eagleAssetFromApi` 在 `LibraryWorkspace.tsx:49-53`，state 在 `LibraryWorkspace.tsx:125-145`，Eagle load 在 `LibraryWorkspace.tsx:250-280`，搜索框在 `LibraryWorkspace.tsx:415-425`，grid/card 在 `LibraryWorkspace.tsx:512-535`，详情 tags 在 `LibraryWorkspace.tsx:608-614`，`beginAssetDrag` 在 `LibraryWorkspace.tsx:342-354`。
  - 新增 state：
    - `const [eagleTags, setEagleTags] = useState<EagleTagItem[]>([])`
    - `const [selectedEagleTag, setSelectedEagleTag] = useState<string>()`
    - `const [eagleTagLoadState, setEagleTagLoadState] = useState<'idle'|'loading'|'ready'|'error'>('idle')`
  - 新增 loader：
    - `loadEagleTags()`：请求 `/api/mivo/eagle/tags`，成功写 `eagleTags`。
    - 如果 `/tags` 失败，fallback 为当前已加载 `eagleAssets.flatMap(asset => asset.tags || [])` 去重生成目录，并标记 error/partial 文案。
  - `loadEagleAssets` 请求参数改为：
    - `limit=120`（或沿用 80，优先保证 demo 有足够瀑布流素材）
    - `offset=0`
    - `folderId`（有选中文件夹时）
    - `tag=selectedEagleTag`（有选中 tag 时）
    - 不再读取 `query.trim()`，依赖数组移除 `query`。
  - tag 目录交互：
    - 在瀑布流面板顶部或 Eagle folder list 下方新增 `.eagle-tag-directory`。
    - 第一项是 `All`，点击清空 `selectedEagleTag`。
    - 目录项渲染 `eagleTags`，类名建议 `.eagle-tag-row` 或 `.asset-tag-chip`；显示 `tag.name` 和可选 `tag.count`。
    - 点击未选中 tag：`setSelectedEagleTag(tag.name)` 并重新加载 `/api/mivo/eagle/assets?tag=<name>`。
    - 点击已选中 tag 或 Clear：`setSelectedEagleTag(undefined)` 并恢复全部素材。
  - 搜索框处理：
    - `isAssets` 时不渲染 `library-searchbar`；plugins/skills 保持原搜索框。
    - 删除或不使用 assets 的 `searchPlaceholder='Search assets...'` 文案，避免 UI 仍暗示搜索。
  - 卡片结构从当前 `button.asset-tile` 改为支持多选/右键/lightbox 的结构：
    - 外层建议 `article.asset-masonry-card` 或 `div role="button" tabIndex={0}`，承接 `draggable`、`onClick`、`onDoubleClick`、`onDragStart`、`onContextMenu`、键盘 Enter/Space。
    - 图片仍使用 `thumbnailUrlFor(asset)`，`onLoad` 继续 `rememberDimensions`。
    - 卡片只显示缩略图、标题、尺寸/格式/大小；不渲染 `asset.tags`、不显示 `Untagged`。
    - 从详情面板删除 `selectedAsset.tags` 的可视化块（当前 `LibraryWorkspace.tsx:608-614`），避免 per-image tag 展示回流。
  - `library-section-heading` 文案：
    - 无 tag：显示 `All Eagle assets` 和总数。
    - 有 tag：显示 `Tag: ${selectedEagleTag}`、结果数和 Clear。
  - `beginAssetDrag` 保持现有 `localAssetDragType`，payload 继续至少包含：
    - `name`
    - `url`
    - 可附加 `id`、`title`、`sourcePath`、`tags`、`width`、`height`，但不能破坏现有 parser。
  - 开发可验证点：Eagle source 下 DOM 中没有搜索 input；面板显示 Eagle tag 目录；卡片上没有每图 tag；点击 tag 目录项后 Network 命中 `/api/mivo/eagle/assets?tag=<tag>` 或 fallback 客户端过滤，瀑布流只剩该分类素材。

### 2.4 同屏素材面板：保证能拖到画布

- `src/App.tsx`
  - 锚点：workspace 条件渲染在 `App.tsx:152-164`。
  - 当前 `workspaceView === 'assets'` 会隐藏 canvas，导致无法完成“拖素材卡入画布”和“复制后粘贴到画布”。
  - 改为：
    - `workspaceView === 'canvas' || workspaceView === 'assets'` 时仍渲染 canvas workspace。
    - 当 `workspaceView === 'assets'` 时，在 canvas workspace 内追加资产面板，例如 `<LibraryWorkspace type="assets" variant="canvas-drawer" onOpenCanvas={() => setWorkspaceView('canvas')} />`。
    - plugins/skills 仍走原来的 full workspace。
  - 若当前 `LibraryWorkspaceProps` 只有 `type` / `onOpenCanvas`（锚点 `LibraryWorkspace.tsx:31-34`），新增 `variant?: 'workspace' | 'canvas-drawer'`，默认 `'workspace'`。
  - 开发可验证点：点击左侧 Assets 后，画布仍在右侧/底层可见，素材面板不是整页替代 canvas。

### 2.5 CSS：CSS columns 瀑布流，不引库

- `src/App.css`
  - 锚点：library layout 在 `App.css:816-1049`，detail panel 在 `App.css:1079-1283`，移动端调整在 `App.css:4732-4736`。
  - 保留现有 `.asset-grid` 给 local 或回退使用；Eagle source 用新类：
    - `.asset-masonry`
    - `.asset-masonry-card`
    - `.eagle-tag-directory`
    - `.eagle-tag-row` 或复用 `.asset-tag-chip`
    - `.asset-library-drawer`
  - `.asset-masonry` 使用：
    - `column-count: 3`
    - `column-gap: 12px`
    - `width: 100%`
  - responsive：
    - drawer 窄宽：`column-count: 2`
    - 移动端：`column-count: 1`
  - `.asset-masonry-card` 使用：
    - `break-inside: avoid`
    - `display: inline-block`
    - `width: 100%`
    - `margin: 0 0 12px`
  - 图片：
    - `width: 100%`
    - `height: auto`
    - 不强制固定高度，确保瀑布流高度差来自真实缩略图比例。
  - `.eagle-tag-row.active` 或 `.asset-tag-chip.active` 对应 `selectedEagleTag`，视觉上必须能看出当前分类。
  - 开发可验证点：DevTools 中 Eagle 列表容器 computed style 有 `column-count`；不同宽高缩略图形成错落瀑布，而不是等高网格；卡片 DOM 中没有 tag chip 容器。

### 2.6 画布 drop：复用现有 handleDrop

- `src/canvas/MivoCanvas.tsx`
  - 锚点：`localAssetDragType` / parser 在 `MivoCanvas.tsx:62-92`，`handleCanvasDrop` 在 `MivoCanvas.tsx:327-347`。
  - M4 不要求修改 `handleCanvasDrop`；只要 `LibraryWorkspace.beginAssetDrag` 写入的 payload 保留 `name` + `url`，现有 parser 会走 `importImageUrlToCanvas(payload.url, payload.name, position, addImportedImage)` 并创建 image node。
  - 如果实现过程中抽 shared MIME 常量，也只能做机械去重，不能改变 drop 支持范围。
  - 开发可验证点：从 Eagle 瀑布流拖卡片到画布空白处，`handleCanvasDrop` 走 payload 分支，新建 `data-node-type="image"` 节点。

### 2.7 Lightbox 大图预览

- `src/app/LibraryWorkspace.tsx`
  - 锚点：卡片渲染在 `LibraryWorkspace.tsx:512-535`，详情面板在 `LibraryWorkspace.tsx:566-625`。
  - 新增 state：
    - `const [previewAsset, setPreviewAsset] = useState<AssetItem>()`
  - plain click 卡片缩略图或标题时打开 lightbox；为避免与多选冲突，卡片左上 checkbox / Cmd / Shift 点击走选择逻辑，普通点击走预览。
  - 新增 `useEffect` 监听 Escape：`previewAsset` 存在时按 Esc 关闭；点击 overlay 遮罩关闭；点击大图本身 `stopPropagation()`。
  - lightbox 内容：
    - 大图 `<img src={previewAsset.url || thumbnailUrlFor(previewAsset)} />`
    - 标题、尺寸、来源、Copy、Add to canvas。
    - 不显示每图 tag，分类信息由面板 tag 目录承担。
  - 开发可验证点：点击 Eagle 卡片打开全屏 overlay；Esc 和点遮罩都关闭；关闭后素材面板选择/filter 状态不丢。

- `src/App.css`
  - 新增 `.asset-lightbox-backdrop`、`.asset-lightbox-panel`、`.asset-lightbox-image`、`.asset-lightbox-actions`。
  - overlay `z-index` 高于 drawer 和 context menu，背景半透明；大图 `max-width: min(92vw, 1280px)`、`max-height: 82vh`，不拉伸变形。
  - 开发可验证点：横图/竖图都完整可见，不遮住关闭按钮。

### 2.8 卡片多选与复制入口

- `src/app/LibraryWorkspace.tsx`
  - 锚点：state 在 `LibraryWorkspace.tsx:125-145`，卡片渲染在 `LibraryWorkspace.tsx:512-535`。
  - 新增 state：
    - `const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])`
    - `const [lastSelectedAssetId, setLastSelectedAssetId] = useState<string>()`
    - `const [assetCardMenu, setAssetCardMenu] = useState<{assetId:string;x:number;y:number}>()`
  - 选择规则：
    - 卡片左上 checkbox 点击：toggle 单张。
    - Cmd/Ctrl 点击卡片：toggle 单张。
    - Shift 点击卡片：在当前 `eagleAssets` 可见列表里从 `lastSelectedAssetId` 到当前卡片做 range select。
    - 普通点击非 checkbox 区域：打开 lightbox，不改变多选。
    - 切换 source / folder / tag 时保留仍在当前瀑布流里的 selected ids，过滤掉不可见 id。
  - 面板 heading 或 tag 目录旁新增批量操作条：
    - 未选择：显示素材数量。
    - 已选择：显示 `${selectedAssetIds.length} selected`、`Copy selected`、`Clear selection`。
  - 右键卡片：
    - `onContextMenu` 阻止浏览器菜单，打开轻量 menu；menu 只有 `Copy`。
    - 选择 `Copy` 时只复制该单图，不隐式复制当前多选集合；如果要复制多选，使用 `Copy selected`。
  - 开发可验证点：checkbox/Cmd/Shift 都能改变选中集合；普通点击仍打开 lightbox；右键菜单 Copy 可见且不打开浏览器原生菜单。

### 2.9 内部 asset 剪贴板 + 画布 paste

- `src/store/canvasStore.ts`
  - 锚点：`CanvasState.clipboardNodes` 在 `canvasStore.ts:47`，actions `copySelectedNodes` / `pasteClipboardNodes` 在 `canvasStore.ts:83-84`，实现于 `canvasStore.ts:1272-1316`。
  - 扩展同一个 Zustand store，不新建第二套全局 store：
    - 新增类型 `CanvasAssetClipboardItem = Pick<AssetItem, 'id'|'sourceId'|'name'|'title'|'url'|'thumbnailUrl'|'width'|'height'|'sourcePath'|'tags'>`，可放在 `assetLibraryModel.ts` 或新建纯类型文件，避免 store 直接依赖 React 组件。
    - `clipboardAssets: CanvasAssetClipboardItem[]`
    - `copyAssetsToClipboard(assets: CanvasAssetClipboardItem[]): void`
    - `pasteClipboardAssets(position?: {x:number;y:number}): Promise<void>` 或返回同步 action + 由 controller 调 helper；实现时选最少改动路径。
  - 内部剪贴板规则：
    - 复制 Eagle asset 时写 `clipboardAssets`，并清空或不消费 `clipboardNodes` 的优先级必须明确。
    - 画布 paste 时如果 `clipboardAssets.length > 0`，内部 asset clipboard 优先于 OS clipboard image 与 `clipboardNodes`，避免单图复制时 OS image 抢先生成一张无 source metadata 的节点。
    - 粘贴 N 张时以 viewport center 或传入 position 为中心，按 24-36px stagger 或简单网格排布，逐张调用现有图片导入链路生成 N 个 image node。
    - 图片导入链路优先复用 `MivoCanvas.tsx:344` 当前 `handleCanvasDrop` payload 分支同款 helper：`importImageUrlToCanvas(asset.url, asset.name, position, addImportedImage)`；不要为 clipboard asset 另写一套 image node 创建逻辑。
  - 开发可验证点：复制 3 张后 store 中 `clipboardAssets.length === 3`；执行 paste 后新增 3 个 image node，且被选中集合包含 3 个新节点。

- `src/canvas/useCanvasInteractionController.ts`
  - 锚点：现有 Cmd+C 在 `useCanvasInteractionController.ts:1293-1297`，OS image paste 在 `useCanvasInteractionController.ts:1371-1392`，node clipboard paste 在 `useCanvasInteractionController.ts:1394-1398`。
  - 修改 `handlePaste` 顺序：
    1. 如果 `isEditingTarget(event.target)` return。
    2. 若 `useCanvasStore.getState().clipboardAssets.length > 0`：`event.preventDefault()`，以 `viewportCenter()` 为起点粘贴 asset clipboard，return。
    3. 再处理 OS clipboard image（保留现有 `ClipboardEvent.clipboardData.items` 图片导入）。
    4. 最后处理现有 `clipboardNodes`。
  - Cmd+C 逻辑不用改成复制素材；素材面板的 `Copy selected` 直接写 internal asset clipboard。若焦点在素材面板内按 Cmd+C，可选调用同一 copy action，但不是 M4 必须。
  - 开发可验证点：单图右键复制后，即使 OS 剪贴板写入成功，画布 Cmd+V 也走 internal asset clipboard；多图复制后 Cmd+V 一次创建 N 个节点。

- `src/app/LibraryWorkspace.tsx`
  - 新增 copy helpers：
    - `copyAssetsToInternalClipboard(assets: AssetItem[])`：调用 `useCanvasStore.getState().copyAssetsToClipboard(...)` 或从 hook 取 action。
    - `copyOneAsset(asset)`：写内部剪贴板；随后 best-effort 写 OS 剪贴板。
    - `copySelectedAssets()`：只写内部剪贴板，不写 OS 剪贴板。
    - `writeSingleAssetToOsClipboard(asset)`：`fetch(asset.url)` → `createImageBitmap` → canvas 转 `image/png` Blob → `navigator.clipboard.write([new ClipboardItem({'image/png': pngBlob})])`；任何错误只 console warn 或 toast，不回滚内部剪贴板。
  - 开发可验证点：右键 Copy 后画布 paste 出 1 张；OS 写失败时仍可在画布 paste；多选 Copy selected 后画布 paste 出 N 张。

## ③ 顺序

1. **新增 Eagle tag 目录中间件**
   - 在 `vite.config.ts` 增 `GET /api/mivo/eagle/tags`，优先调用 Eagle `/api/tag/list`。
   - 扩展 `/api/mivo/eagle/assets` 支持 `tag=`，映射到 Eagle `/api/item/list?tags=<tag>`。
   - 开发可验证点：`/api/mivo/eagle/tags` 返回 tag 目录；`/api/mivo/eagle/assets?tag=<tag>` 返回该 tag 下素材。

2. **去掉 assets 搜索主路径**
   - 改 `LibraryWorkspace.tsx`：assets 模式不渲染 `library-searchbar`；`loadEagleAssets` 不再读取 `query`，请求不带 `q`。
   - 开发可验证点：打开素材库面板没有搜索输入框；Network 没有 `/search` 或 `q=`。

3. **建立 tag 目录分类状态**
   - 加 `eagleTags`、`selectedEagleTag`、`loadEagleTags()`、`toggleEagleTag(tagName)`。
   - 在瀑布流面板顶部或侧边渲染 Eagle tag 目录，包含 `All` 和真实 tag 项。
   - tag 目录项点击后重新加载 `/api/mivo/eagle/assets?tag=<tag>`；再次点击当前 tag 或 Clear 恢复全部。
   - 开发可验证点：点击目录中的 tag，瀑布流显示该 tag 下图片；再次点击或 Clear 后恢复全部。

4. **把 Eagle grid 改为无 per-image tag 的瀑布流卡片**
   - Eagle source 下用 `.asset-masonry` + `.asset-masonry-card` 渲染；local source 可暂时保留旧 `.asset-grid`。
   - 卡片显示缩略图、标题、尺寸/格式/大小，不显示每图 tag chips。
   - 开发可验证点：Eagle 图片以 CSS columns 错落排列；卡片 DOM 和视觉都没有 per-image tag。

5. **保持 dragstart/dataTransfer**
   - 在新卡片结构上挂回 `draggable`、`onDragStart={(event) => beginAssetDrag(asset, event)}`。
   - 目录项、checkbox、lightbox 按钮点击必须 `stopPropagation()`，避免误选/误拖卡片。
   - 开发可验证点：拖动卡片时 `dataTransfer.types` 含 `application/x-mivo-local-asset`；payload JSON 有 `name` 和 `url`。

6. **资产面板与画布同屏**
   - 改 `App.tsx:152-164` 和 `LibraryWorkspaceProps`，让 Assets 作为 canvas drawer/panel 出现。
   - 开发可验证点：Assets 打开时画布仍可见，能把卡片拖到画布 drop 区，也能复制后粘贴到画布。

7. **拖入画布建 image node**
   - 不重写 `handleCanvasDrop`；用现有 drop 链路验收。
   - 开发可验证点：释放鼠标后创建 image node，位置在释放点附近，图片内容来自 Eagle 卡片 URL。

8. **lightbox 大图预览**
   - 加 `previewAsset` 与 overlay，卡片普通点击打开预览。
   - Esc / 点击遮罩关闭，overlay 内按钮不冒泡。
   - 开发可验证点：点卡片显示大图；Esc 与点遮罩关闭；lightbox 不显示 per-image tags。

9. **卡片多选与右键复制**
   - 加 `selectedAssetIds`、`lastSelectedAssetId`、右键 Copy 菜单和批量 Copy selected。
   - checkbox/Cmd/Shift 管选择，普通点击管 lightbox。
   - 开发可验证点：右键单卡 Copy 写内部剪贴板 1 项；多选 N 张点 Copy selected 写内部剪贴板 N 项。

10. **接入内部 asset clipboard 到画布 paste**
   - 扩展 `canvasStore` 的现有剪贴板 slice，增加 `clipboardAssets` 和复制/粘贴 action。
   - 改 `useCanvasInteractionController.ts:1371-1398` 的 paste 优先级：asset clipboard → OS image → node clipboard。
   - 单图复制额外 best-effort 写 OS image/png，多图复制不写 OS。
   - 开发可验证点：单图/多图复制后在画布 Cmd+V 分别生成 1/N 个 image node。

11. **空态/错误态收敛**
   - Eagle 离线时继续显示 `Eagle unavailable`。
   - 当前 tag 无结果时显示 `No assets indexed with ${selectedEagleTag}` + Clear。
   - `/api/tag/list` 失败时显示 fallback/partial 状态，并可从已加载 assets 聚合 tag 目录。
   - 开发可验证点：断开 Eagle 不影响 local source；tag 目录失败不导致素材面板崩溃。

## ④ SC 验收

- **M4-SC1：Eagle tag 目录 + 瀑布流 + 卡片不显示每图 tag**
  1. `npm run dev`。
  2. 打开左侧 Assets，选择 Eagle libraries。
  3. 素材库面板与画布同屏。
  4. 面板顶部或侧边显示 Eagle tag 目录 / 分类列表，Network 有 `GET /api/mivo/eagle/tags`。
  5. 面板中 Eagle 图片以 CSS columns 瀑布流排列。
  6. 查看任意 Eagle 瀑布流卡片，卡片只显示缩略图、标题、尺寸/格式/大小等基础信息；没有 tag chips、`Untagged` 或每图 tags 文案。

- **M4-SC2：点击 tag 目录切换分类**
  1. 在 Eagle tag 目录点击一个 tag。
  2. Network 命中 `/api/mivo/eagle/assets?tag=<tag>`；若使用 fallback，则无新增后端 query 但有明确 fallback 状态。
  3. 瀑布流只显示该 tag 下被索引的图片。
  4. 点击 Clear 或再次点击同一 tag 后恢复全部 Eagle 素材。

- **M4-SC3：拖动素材卡到画布生成 image node**
  1. 保持 Assets 面板和 canvas 同屏。
  2. 从 Eagle 瀑布流拖一张素材到画布空白位置。
  3. 释放鼠标后出现一个 image node，位置在释放点附近。
  4. 选中新 node，DOM 上 `data-node-type="image"`；图片显示为刚拖入的 Eagle 素材。

- **M4-SC4：点击卡片查看大图**
  1. 在 Eagle 瀑布流里普通点击一张素材卡片缩略图或标题。
  2. 出现 lightbox 大图预览 overlay，显示大图、标题和基础信息，不显示 per-image tags。
  3. 按 Esc 或点击遮罩关闭 overlay，回到原瀑布流位置。

- **M4-SC5：右键单图复制 + 多选 N 张复制后粘贴到画布**
  1. 在 Eagle 瀑布流里右键一张素材卡片，点击 Copy；内部 `clipboardAssets.length === 1`，浏览器 OS 剪贴板 image/png 写入失败也不阻断。
  2. 聚焦画布按 Cmd+V / Ctrl+V，画布新增 1 个 image node，图片为刚复制的 Eagle 素材。
  3. 用 checkbox、Cmd/Ctrl 点击或 Shift 点击在瀑布流中选中 N 张 Eagle 素材。
  4. 点击 Copy selected；内部 `clipboardAssets.length === N`，不尝试把 N 张图写入 OS 剪贴板。
  5. 聚焦画布按 Cmd+V / Ctrl+V，画布一次新增 N 个 image node，节点错开排列且选中新建集合。

## ⑤ 风险回退

- **Eagle `/api/tag/list` 不可用**：保留 `/api/mivo/eagle/tags` endpoint，但前端 fallback 为已加载 assets 的 `tags` 聚合目录；UI 显示 partial/fallback 状态，SC 仍可验收分类切换。
- **Eagle `/api/item/list?tags=` 不生效**：前端在已加载 assets 上按 `asset.tags?.includes(selectedEagleTag)` 客户端过滤；若素材不足，增加 `limit` 或提示当前为已加载范围过滤。
- **CSS columns 与详情面板挤压**：先在 drawer 宽度下把 `column-count` 降到 2；窄屏降到 1，保证卡片和目录不溢出。
- **per-image tag 展示回流**：删除 `.asset-card-tags` 和详情面板 tags 块；只允许 tag 目录显示 tag。
- **tag 目录结果为空**：显示 `No Eagle tags found`，但仍展示 All assets 瀑布流和拖拽/复制能力。
- **拖拽丢 payload**：保留 `text/plain` 仅作展示/调试；drop 不从 `text/plain` 创建 URL 节点。若自定义 MIME 丢失，画布不创建节点并可 console warn。
- **plain click 预览与多选冲突**：把多选放在 checkbox/Cmd/Shift 路径，普通点击只打开 lightbox；选中态靠 checkbox 和卡片边框显示。
- **OS 剪贴板权限/格式失败**：只影响外部 app 粘贴；内部 asset clipboard 已写入即可在 MivoCanvas 画布粘贴。
- **多图 paste 性能慢**：按顺序导入，先保证 N 个节点可靠出现；必要时限制单次 Copy selected 上限如 24，并在 UI 显示上限。
- **内部 asset clipboard 与 node clipboard 冲突**：asset clipboard 在画布 paste 中优先；复制画布节点时清空 `clipboardAssets`，复制素材时不消费 `clipboardNodes` 或明确覆盖两者，避免用户粘贴到旧内容。
- **资产面板影响插件/技能页**：`variant='canvas-drawer'` 只用于 `type='assets'`；plugins/skills 继续原 full workspace。
