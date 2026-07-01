# M1 右下角首次生图对话框步骤计划

## PHASE_GOAL
把现有 `AIToolPanel` 改成画布右下角的首次生图对话框：不做居中 modal，不改左侧 `ProjectSidebar` 的项目分类 / 创建项目 / 对话区分画布结构，避开未来 M6 的居中底部 loveart 式通用工具条；空画布 prompt 一键出图，上传参考图 + prompt 走图生图，结果按 master 调用流交给 M5 `commitGenerationResult(...)` 存 IndexedDB、建新节点 + edge，原节点不覆盖。

## UI 布局
| 约束 | 落地方式 |
|---|---|
| 首次生图对话框放画布右下角 bottom-right，不居中 | `AIToolPanel` 继续作为 `src/App.tsx:155-158` 的 `work-surface` 浮层 sibling；`.ai-panel` 相对画布容器使用 `position:absolute; right:var(--ai-panel-offset); bottom:12px; top:auto;`，禁止 `left:50%`、`top:50%`、`transform:translate(-50%,-50%)`。 |
| 保留左侧 ProjectSidebar 形态 | step-M1 不触碰、不移除 `src/App.tsx:128-150` 的 `ProjectSidebar` / `ProjectSidebarControls`；不改 `src/App.css:87-149` 的 `.project-sidebar`、`.project-sidebar.closed`、`.project-sidebar.drawer` 结构。项目分类 / 创建项目 / 对话区分画布入口保持现状。 |
| 避开 M6 居中底部通用工具条 | M1 对话框只占右下角 `--ai-panel-w` 宽度；M6 loveart 式工具条保留画布居中底部位置（`left:50%; bottom:12px` 的方向）。两者横向错开：对话框右下，工具条居中底部。 |

## 精确改动清单
| 文件 / 符号 | 改动 |
|---|---|
| `src/types/generation.ts:3-16` | 保留 `GenerationAdapter` 给旧 mock 兼容；新增 `MivoImageRatio = '1:1' \| '3:2' \| '2:3' \| '16:9' \| '9:16'`、`MivoImageQuality = 'low' \| 'medium' \| 'high'`、`MivoGenerateRequest`、`MivoEditRequest`、`MivoImageResponse = {images:{b64:string}[]}`。 |
| 新建 `src/lib/mivoImageClient.ts` | 新增 M1/M2 共用的前端 fetch client，不读任何 key。导出 `generateMivoImage(request)` 调 `/api/mivo/generate` JSON；导出 `editMivoImage(request)` 调 `/api/mivo/edit` multipart；导出 `assetBlobForNode(node)`。这是唯一 image API client，M2 也从这里 import，禁止再建 `mivoImageEditClient.ts`。 |
| `src/lib/mivoImageClient.ts` `editMivoImage` | FormData 字段固定区分：`image` 是主图；`mask` 是独立 PNG part，仅 M2 传；`reference[]` 是额外参考图 best-effort，兼容 M0 的 `reference` 读取但 M1/M2 统一发送 `reference[]`。M1 图生图第一张参考图作为 `image`，剩余参考图才作为 `reference[]`；M2 局部重绘的 mask 不得塞进 `reference[]`。 |
| `src/lib/mivoImageClient.ts` `assetBlobForNode` | 对 `mivo-asset:` 先用 `readImportedAssetFile`（`src/lib/assetStorage.ts:294-309`）；其它 `assetUrl` 用 `fetch(assetUrl)`，支持 Eagle/local 同源 URL；失败时抛 `Unable to read source image for generation`。 |
| `src/lib/assetStorage.ts:249-281` `saveGeneratedAsset` | 不在 M1 新增；该 helper 已由 M5 提供并只由 `commitGenerationResult(...)` 调用。M1 拿到 `{images:[{b64}]}` 后不直接存图、不直接建 node/edge。 |
| `src/store/canvasStore.ts:39-49` `CanvasState` | 把 `generateBesideNode`、`generateIntoAiSlot`、`generateImageEdit` 的签名改为可 `await`：返回 `Promise<void>`；参数增加 `options?: { imgRatio?: MivoImageRatio; quality?: MivoImageQuality; model?: string; referenceFiles?: File[] }`。`generateFromAnnotation` 可暂保留原签名，M2 再接 mask。 |
| `src/canvas/actions/canvasActionTypes.ts:110-114` | 同步 action runtime 类型；右键菜单调用处继续 `void runtime.generateBesideNode(...)`，不阻塞菜单关闭。 |
| `src/store/canvasStore.ts:1783-1808` `generateVariations` | M1 不改 variations 真实生成；M5 已加 edge 后，M1 保持该 mock 仅用于 Inspector 的旧按钮。 |
| `src/store/canvasStore.ts:1883-1949` `generateBesideNode` | 替换 `mockResultAssetUrl(state.nodes)`：先确定 source；若 source 是 image 或 `options.referenceFiles?.length`，调用 `editMivoImage`，其中 image = source image blob 或第一张 reference file；否则调用 `generateMivoImage`。拿到 response 后只调用 `await commitGenerationResult({sourceNodeId: source.id, resultImages: response.images, prompt: resultPrompt, model, kind:'generate'})`；禁止在本 action 内手写 node/edge。 |
| `src/store/canvasStore.ts:1950-2028` `generateIntoAiSlot` | 替换 mock：slot 作为派生 source；无参考图走 `generateMivoImage`；有参考图走 `editMivoImage`，image = 第一张 reference file，剩余文件放 `reference[]`。拿到 response 后调用 `await commitGenerationResult({sourceNodeId: slot.id, resultImages: response.images, prompt: resultPrompt, model, kind:'generate', placement:'right'})`；slot 保留，不被结果覆盖。 |
| `src/store/canvasStore.ts:1809-1882` `generateImageEdit` | 对 `prompt-edit/remove-background/outpaint/upscale` 先接真实全图 edit 或 generate fallback；成功后同样调用 `commitGenerationResult({sourceNodeId: source.id, resultImages: response.images, prompt, model, kind:'edit'})`。M2 的 mask 参数以后由 M2 overlay 调 shared client + 同一 commit action，不走旧 annotation mock。 |
| `src/store/canvasStore.ts:1830-1836` 与 `1896-1902` | 结果放位、width/height、IndexedDB asset metadata 均由 M5 `commitGenerationResult(...)` 负责；M1 只负责 source/slot 选择、调用 shared client、维护 task loading/error。 |
| `src/store/canvasStore.ts:1867-1873`、`1934-1940`、`2013-2019` task | 生成开始前插入 running task：`status:'running', progress:20, nodeIds:[]`；成功后更新为 done + result id；失败更新为 failed，保留错误 prompt 不建结果节点。 |
| `src/App.tsx:128-157` app layout | 保留 `ProjectSidebar` 在 `:128-141` 的渲染和 `ProjectSidebarControls` 在 `:142-150` 的关闭态入口；`AIToolPanel` 继续作为 `work-surface` 内、`MivoCanvas` 后面的浮层 sibling（`:155-158`），不移动到全局 modal root，不覆盖左侧 sidebar。 |
| `src/app/AIToolPanel.tsx:12-13` imports | 移除 `saveImportedAsset` 的直接导入；新增 `useEffect`，新增 `MivoImageRatio/MivoImageQuality` 类型 import。 |
| `src/app/AIToolPanel.tsx:21-48` state / `handleFile` | 新增 `referenceFiles: Array<{id,file,previewUrl}>`、`imgRatio` 默认 `1:1`、`quality` 默认 `medium`、`isGenerating`、`generationError`。`handleFile` 改为只放入 reference 槽并生成 ObjectURL，不再直接调用 `addImportedImage`。 |
| `src/app/AIToolPanel.tsx:61-65` `createSlotNearSelection` | 改为返回 `slotId`：`const slotId = addAiSlotNode(...); return slotId`，供空画布一次点击后继续生成。 |
| `src/app/AIToolPanel.tsx:67-84` `runPrimaryGeneration` | 改成 `async`：trim prompt 为空则显示错误；selected `ai-slot` 调 `await generateIntoAiSlot(id,prompt,{imgRatio,quality,referenceFiles})`；selected `annotation` 仍走 `generateFromAnnotation`；selected 其它节点走 `await generateBesideNode(id,prompt,options)`；无 selection 时先 `const slotId = createSlotNearSelection()` 再 `await generateIntoAiSlot(slotId,prompt,options)`。成功后清空 `referenceFiles`。 |
| `src/app/AIToolPanel.tsx:183-190` dropzone | 增加 `onDrop/onDragOver/onPaste`；支持一次加入多张 `image/png,image/jpeg,image/webp`；显示 preview chips 和删除按钮。 |
| `src/app/AIToolPanel.tsx:243-257` runner options | 把静态 `1张/1:1/medium` 改为按钮组：数量固定显示 `1张` disabled；ratio 在 5 个值中切换；quality 在 `low/medium/high` 中切换，active 状态写到 class。 |
| `src/app/AIToolPanel.tsx:258-265` generate button | `disabled={isGenerating}`；loading 文案为 `生成中...`；失败时在按钮上方渲染 `.ai-generation-error`。collapsed 面板 `:112` 的生成按钮也用 `void runPrimaryGeneration()`。 |
| `src/App.css:24-28` layout vars | 保留 `--project-w` / sidebar grid；新增或复用 `--ai-panel-w`、`--ai-panel-offset`、`--floating-gap` 来定位右下角对话框。不要把 `.mivo-app` 改成无 sidebar 的单列布局。 |
| `src/App.css:87-149` `.project-sidebar` | 不改 selector 结构和宽度机制；M1 的 CSS 只改 AI 对话框，不改 `.project-sidebar`、`.project-sidebar.closed`、`.project-sidebar.drawer`。 |
| `src/App.css:3700-3722` `.canvas-controls` | 保持右下角缩放控件已有避让 AI 面板逻辑；若 M1 对话框高度缩短，仍让 `.canvas-controls` 用 `right: calc(var(--ai-panel-offset) + var(--ai-panel-w) + var(--floating-gap))` 在 AI 对话框左侧。 |
| `src/App.css:3767-3782` `.ai-panel` | 把主对话框明确定位为右下角浮层：`position:absolute; right:var(--ai-panel-offset); bottom:12px; top:auto; width:min(var(--ai-panel-w), calc(100% - 28px)); max-height:min(680px, calc(100% - 28px));`。不得加 `left:50%`、`top:50%`、`transform:translate(-50%,-50%)` 这类居中 modal 样式。 |
| `src/App.css:3767-3782` `.ai-panel` | 为 M6 居中底部工具条预留横向关系：M1 对话框贴右，M6 工具条应贴 `left:50%; bottom:12px`；M1 不实现 M6，但不得占用画布底部居中区域。 |
| `src/App.css:3960-3992` `.ai-dropzone` 后 | 新增 `.ai-reference-list`、`.ai-reference-chip`、`.ai-reference-thumb`、`.ai-reference-remove`；chip 固定高度，长文件名 ellipsis。 |
| `src/App.css:4059-4093` `.ai-runner` 后 | 新增 `.ai-run-options button.active`、`.ai-generate:disabled`、`.ai-generation-error`、`.ai-generation-status`。移动端沿用 `src/App.css:4706-4713` 的面板宽度，不新增布局断点。 |

## 依赖与落地顺序
1. 先完成 M0；M1 fetch 客户端只依赖 `/api/mivo/generate` 和 `/api/mivo/edit`，不处理 llm-proxy key。
2. 先完成 M5 的 `edges`、`commitGenerationResult(...)`、`saveGeneratedAsset`、非破坏写入；M1 只调用 `commitGenerationResult`，不在 UI 或 `generate*` action 里手写 node/edge。
3. 新建共享 `src/lib/mivoImageClient.ts`，包含 `generateMivoImage`、`editMivoImage`、`assetBlobForNode`；M2 必须复用同一模块。
4. 改 `canvasStore` action 签名和实现：先 `generateIntoAiSlot`，再 `generateBesideNode`，最后 `generateImageEdit`。
5. 改 `AIToolPanel` 的 reference staging、async `runPrimaryGeneration`、ratio/quality 控件。
6. 调整 `.ai-panel` 为右下角首次生图对话框；确认 `ProjectSidebar` 仍在左侧，未来 M6 居中底部工具条的中线区域不被 M1 占用。
7. 补 reference / loading / error CSS；只在浏览器点 SC，不需要新增路由。

## SC 验收
| master SC | 浏览器怎么点 | 看到什么算通过 |
|---|---|---|
| M1-Layout 右下角对话框 / sidebar / M6 位置关系 | 打开 canvas workspace，保持左侧 sidebar 展开；展开 AI 工具；若 M6 工具条已落地，同时显示居中底部工具条。 | 首次生图对话框出现在画布右下角，不在屏幕中心；不遮挡左侧 ProjectSidebar 的项目分类 / 创建项目 / 对话区分画布入口；不遮挡居中底部 M6 通用工具条。 |
| M1-SC1 空画板 prompt 出真实图 | 打开空画布；在右下角首次生图对话框输入 `a watercolor icon of a tiny robot gardener`；ratio 保持 `1:1`、quality `medium`；点 `立即生成`。 | 同一次点击后画布出现一个 AI slot 和一张真实图片节点；图片 URL 是 `mivo-asset:*` 存到 IndexedDB；Network 有 `/api/mivo/generate`；store 里新增 edge `from=slotId,to=resultId,type='generate'`；结果图不是 `realCaseImages` mock；结果节点被选中。 |
| M1-SC2 参考图 + prompt 图生图 | 在右下角首次生图对话框的 dropzone 点击或拖入一张 PNG/JPEG/WebP；看到 reference chip；输入 `turn this into a soft vinyl toy render`；点 `立即生成`。 | Network 有 `/api/mivo/edit` multipart，FormData 包含 `image`、`prompt`、`imgRatio`、`quality`；如果多参考图存在，额外文件字段名是 `reference[]`，没有 `mask` 字段；画布出现基于参考图的新图片节点；reference chip 成功后清空。 |
| M5 联动：M1 结果非破坏 + edge | 执行 M1-SC1 或 M1-SC2 后，拖动 slot 或 selected source。 | 原 slot/source 仍在；新图片是单独节点；M5 派生 edge 从 slot/source 指向结果，拖动任一端时线端点跟随。 |

## 风险与回退
| 风险 | 处理 / 回退 |
|---|---|
| reference staging 改掉了原“上传即导入”习惯 | M1 面板只负责生成；素材导入仍由画布 drop 和 M4 素材库承担。回退时把 `handleFile` 恢复为 `saveImportedAsset -> addImportedImage`，不影响 M0。 |
| `assetBlobForNode` fetch 远程图片 CORS 失败 | 优先支持 `mivo-asset:`、`/api/mivo/eagle/*/file`、`/api/mivo/local-assets/*` 这些同源 URL；失败时在面板显示错误，不建结果节点。 |
| 生成失败后画布留下 running task | 每个 async action 用 `try/catch`，catch 中把同一 `taskId` 更新为 `failed`；不插入 image node，不插入 edge。 |
| 空画布没有 source node 但 M5 edge 要 `from` | `runPrimaryGeneration` 无 selection 时先创建 `ai-slot`，再生成到 slot；edge 的 `from` 为 slot id，结果图不覆盖 slot。 |
| 多参考图上游不接受 `reference[]` | shared `editMivoImage` 先保证第一张作为 `image`；其它 `reference[]` 标为 best-effort。如果 M0/llm-proxy 拒绝，catch 显示错误，回退为只发送第一张 reference；`mask` 字段只属于 M2，不能用来承载 reference。 |
| 右下角对话框与未来 M6 居中底部工具条重叠 | M1 只占右下角 `--ai-panel-w` 宽度；不使用底部居中定位。若小屏宽度不足，优先保持对话框在右侧并让 M6 自己在 M6 阶段缩短宽度或上移。 |
| M1 误改左侧 ProjectSidebar | 对照 `src/App.tsx:128-150` 和 `src/App.css:87-149`；发现 sidebar 结构或宽度机制变化时回退这些改动，只保留 `AIToolPanel` 和 `.ai-panel` 相关修改。 |
