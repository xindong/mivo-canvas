# MivoCanvas Demo · 复用/重写可执行清单（P1 产出）

> 生成：2026-07-01 晚。合成自 3 份研究（`research-open-design.md` / `research-toolbox.md` / `research-mivoserver.md`）+ 前端基线（`../baseline-inventory.md`）+ 已验证 llm-proxy 契约。
> 用途：P2 /gd-plan 的输入。每条标注 `复用(来源 file:line)` 或 `自建/重写(原因)`。
> 三仓路径：OD=`reference/projects/open-design`，TB=`reference/projects/XD-AIGC-toolbox`，MS=`reference/projects/mivo-server`。

## 结论先行
- **无单一可整体 fork 的东西**；demo = 现有 MivoCanvas 前端 + 5 个模块，各自「抄交互底座 + 自建画布/mask/派生语义」。
- **最大自建项 = M2 的 mask 合成**（全三仓都没有"在原图上叠透明 mask 喂 edits"的现成代码）与 **M5 派生 Edge**（三仓都无 image-node/edge 图模型）。
- **最省项 = M4**（现有 vite 中间件已有 Eagle 代理）与 **M0**（llm-proxy 同步、tap-avatar-frame 有 multipart 底座）。

## 现有 MivoCanvas 接入点（在这些文件上改，交互框架不动）
- `src/store/canvasStore.ts` — 5 个 mock 生成 action 待替换为真实调用：`generateVariations`/`generateImageEdit`/`generateBesideNode`/`generateIntoAiSlot`/`generateFromAnnotation`（约 :1793/1845/1912/1969/2052）。
- `src/app/AIToolPanel.tsx` — `runPrimaryGeneration()` 是生成触发 UI（M1 主对话框基于它扩/或新建常驻框）。
- `src/canvas/CanvasNodeView.tsx` — image 节点 DOM 渲染（M2 mask overlay 挂这里）。
- `src/canvas/useCanvasInteractionController.ts` — 交互中枢（M2 锚点工具接入）。
- `src/canvas/actions/canvasActionModel.ts` — 右键菜单声明式模型（M3「审核」入口日后加）。
- `vite.config.ts` `localAssetLibraryPlugin`（:221 起）— M0 生成代理 + M4 Eagle 都挂这套 dev 中间件（已有 `/api/mivo/eagle/*`）。
- `src/types/mivoCanvas.ts` + `src/types/generation.ts` — 节点/Edge 类型、`GenerationAdapter`（现只声明 1 方法）。
- `src/lib/assetStorage.ts`(IndexedDB) — 结果图落地；`src/store/aiCanvasWorkflow.ts` `chooseAdjacentPlacement` — 空位放置（真实算法，直接用）。

---

## M0 生成接入（llm-proxy 薄代理）
**复用**
- multipart 手写 boundary 调 `/v1/images/edits` 底座 → TB `tools/tap-avatar-frame/server.js:92-158`。
- b64 结果落盘/转 dataURL → TB `tap-avatar-frame/server.js:189-240`。
- multipart 解析（区分字段名） → TB `tap-avatar-frame/server.js:649-701`（`parseMultipart`，保留字段名+临时路径）。
- `imgRatio`/`quality`→`size` 映射表 → MS `api/src/ai_api/tasks/gptimage.py:33-59`（见下表，直接抄进中间件）。
- 「key 只在 Node 侧读、前端不见」边界 → OD `apps/daemon/src/routes/media.ts:487-492`（同源校验思路）。

**自建/重写**
- 两个 dev 中间件端点：`POST /api/mivo/generate`(JSON→`/v1/images/generations`)、`POST /api/mivo/edit`(multipart image+mask+prompt→`/v1/images/edits`)。同步返回 `data[].b64_json`。
- key 从 `secrets/image-key.raw` 迁到 `.env.local`(`MIVO_IMAGE_API_KEY=`，gitignored)，中间件 `process.env` 读，**禁止 `VITE_` 前缀**（不进 bundle）。
- prompt 只做 `trim()`（MS `facade/gptimage.py:173-176` 的轻清洗即可，不上 SmartPrompt）。

**size 映射表（gpt-image-2，抄自 MS）**
| imgRatio | low | medium | high |
|---|---|---|---|
| 1:1 | 1024x1024 | 2048x2048 | 2880x2880 |
| 3:2 | 1536x1024 | 3072x2048 | 3504x2336 |
| 2:3 | 1024x1536 | 2048x3072 | 2336x3504 |
| 16:9 | 1824x1024 | 2048x1152 | 3840x2160 |
| 9:16 | 1024x1824 | 1152x2048 | 2160x3840 |
未知比例回落 1:1；quality 限 `low|medium|high` 默认 medium 且显式传。

---

## M1 主对话框（文生图 / 图生图）
**复用**
- 上传/拖拽/粘贴/预览/FormData 交互底座 → TB `tap-avatar-frame/index.html:2844-3075`（源图+多参考图）、`:1850-1898`（文件校验+FileReader 预览+拖拽）。
- 「有上传走 edit / 无上传走 generate」分支 → TB `tap-avatar-frame/index.html:1920-1953`。
- prompt+附件+参数分层 contract → OD `apps/web/src/components/ChatComposer.tsx:205-234`（借鉴结构，不搬实现）。
- 生成模式/比例/质量控件位置 → OD `home-hero/media-surfaces.ts:47-100`。

**自建/重写**
- 常驻主对话框组件（UI 参照现有 MivoCanvas 风格）：prompt 输入 + 参考图槽 + 比例/质量 + 生成按钮。
- 结果落画布：调 M0 → b64 存 IndexedDB → 建 image node（`chooseAdjacentPlacement` 放位）→ 替换 `canvasStore` 对应 mock action。
- 参考图走浏览器 File/ObjectURL，**不走 OD 的 project 文件系统**（OD ChatComposer `uploadFiles/ensureProject` 不搬）。

---

## M2 锚点二改（点/框/涂抹 mask → 局部重绘，最难，自建为主）
**复用（交互底座）**
- 点/框/涂抹 + 归一化坐标 + undo/redo + rAF 重绘 + 「区域工具+prompt 同屏提交」范式 → OD `apps/web/src/components/PreviewDrawOverlay.tsx`（数据模型 :11-52、归一化 :227-235、矩形/画笔 pointer :291-343、多框合并 bounds :489-525、底部工具条 :985-1073）。
- 单框/多框编辑器（图片原始像素坐标） → TB `xd-town-hair-generator/public/lib-bbox-editor.js`（单框）、`xd-fashion-trend-studio/public/lib-bbox-editor.js`（多框 建/选/移/缩/删）。
- 画笔像素写入主循环 → TB `pixel-forge/index.html:858-901`（pointer 绘制）、`:915-926`（hover brush 预览）。
- canvas→PNG Blob → TB `tap-avatar-frame/index.html:2435-2443`（但 mask 要用 `maskCanvas.toBlob('image/png')`，别截显示层）。

**自建/重写（核心）**
- **mask 合成层**：把点/框/涂抹统一渲染到一张**与原图同像素尺寸**的透明 canvas，**透明=要改、不透明=保留**（MS `common/.../tools/openai.py:286-343` 确认此语义，且**不强制正方形**），导出 PNG。这是全三仓都没有的关键自建件（OD 的 `compositeWithBackground` 是红框截图，方向相反，不能用）。
- overlay 挂到 MivoCanvas image 节点（`CanvasNodeView`/交互层），**不走 OD 的 iframe/srcdoc/postMessage/comments 管线**。
- 提交：原图 blob + mask PNG + prompt → M0 `/api/mivo/edit`（multipart 三字段分开：`image`/`mask`/可选`reference[]`，别把 mask 塞进参考图列表）→ 结果建**派生新图节点 + Edge**（见 M5），原图不覆盖。

---

## M4 Eagle 素材库（瀑布流展示 图片+tag + 拖入画布；不做搜索）
**复用**
- 现有 vite 中间件已有 Eagle 代理 `/api/mivo/eagle/status|folders|assets|thumbnail|file`（baseline §3.3，dev-only，真实）+ `LibraryWorkspace` 已有 Eagle 文件夹树/网格/导入。
- 搜索/网格/上传面板布局 → TB `ro-story-studio/public/index.html:1156-1174`(tabs+搜索框+grid)、`:2314-2410`(搜索过滤+grid+素材卡)、`:2793-2825`(拖拽/粘贴)。
- 素材选择器 UX（search debounce/multi-select/filter） → OD `LibraryPicker.tsx:61-207`、`LibrarySection.tsx`（面板/多选/拖拽，换数据源即可）。
- `EagleAsset` 最小字段参考 → OD `packages/contracts/src/api/library.ts:13-39`（取 id/url/name/width/height/tags/folder 子集）。

**自建/重写**
- **瀑布流 + tag 目录**：中间件读 Eagle **tag 目录**（优先 Eagle `/api/tag/list`，或从已加载 assets 的 tags 聚合）+ 图片列表（asset 带所属 tags 用于筛选）；前端 **masonry（CSS columns，不引库）** 展示缩略图（**卡片不显示每图 tag**）+ 一个 **tag 目录/分类列表**；点某 tag → 瀑布流显示该 tag 索引的素材。**不做搜索框**。
- 素材卡 **`dragstart`/`dataTransfer`** → 拖入画布建 image node（全三仓无现成 dragstart，自建；MivoCanvas 已有 `handleDrop` 导入链路可接）。
- **看大图 + 复制/粘贴**：卡片点击→lightbox 大图；右键→复制（单图）；多选→批量复制；粘贴到画布建 N 个节点。**多图走 app 内部剪贴板**（浏览器 OS 剪贴板一次只能可靠放 1 张）；复用现有节点 Cmd+C/V 剪贴板 + paste 导入 + `handleCanvasDrop`。
- **不**把 Eagle 素材复制进任何本地库/SQLite（OD `applyLibraryAsset` 不搬），只引用 Eagle 原路径/预览 URL。

---

## M5 画布派生模型（节点 + Edge 派生链，自建）
**复用**
- 几乎无直接可复用：OD 的历史是 project/conversation/run（`packages/contracts/src/api/projects.ts`、`chat.ts`），**无 image-node/edge/mask/派生链字段**，只可借鉴「生成结果归属」思路（`createdByRunId`/`prompt`/`sourceNodeIds`）。
- 现有 MivoCanvas 已有节点 + connector + 非破坏裁剪 + `aiWorkflow` 元数据雏形（baseline），在此扩展。

**自建/重写**
- 数据模型：`edges[{from,to,type:'generate'|'edit',prompt,maskBounds?,createdAt}]` + 结果节点 `sourceNodeId`/`derivedFrom`（`types/mivoCanvas.ts`）。
- 非破坏：原图/原节点永不覆盖，每次生成/编辑产**新节点** + 连一条派生 Edge（`canvasStore`）。
- 画布上可视化派生连线（复用现有 connector 渲染）。

---

## 明确跳过（三仓里不碰的）
- MS：Task/消息投影、OSS、credentialSource、baidu 分支、翻译润色、HMAC、NANOBANANA（gemini 备选仅 llm-proxy 支持时才接，今晚默认不接）。
- OD：daemon/project/iframe/artifact/run 架构、SQLite Library、多 provider 配置面板、Excalidraw SketchEditor。
- TB：异步轮询任务状态机（demo 同步即可）、ArtDAM/Immich 素材后端。

## 给 P2 的关键约束提醒
- 执行以**串行为主**：M0→M1→(M4 可与 M2 并行，文件重叠少)→M2→M5 贯穿。M0 是所有生成的地基，先做。
- M2 是风险最高模块（mask 自建 + 坐标映射），计划要给它最细的分步 + 中途可 dev 验证。
- gemini-3-pro-image：构建 M0 时顺手用 key 实测 `model:gemini-3-pro-image` 打 llm-proxy；通则加选项，不通则仅 gpt-image-2。
