GD_REVIEW_DECISION: APPROVED

# P5 代码审查 #2：代码质量 + 安全 + 健壮性

## 已检查范围

| 检查面 | 结论 | 证据 |
|--------|------|------|
| 构建 | 通过 | `npm run build` 通过；仅有 Vite chunk >500 kB 提示。 |
| 密钥安全 | 通过 | `rg -n -o "MIVO_IMAGE_API_KEY|VITE_MIVO|llm-proxy|MIVO_IMAGE|image-key" dist` 无输出；`rg -n -o "Bearer" dist` 无输出；`git ls-files \| grep -iE '\.env|secret|image-key'` 无输出。 |
| API 契约 | 部分通过 | `vite.config.ts:728-729` 只在 Node 侧 `loadEnv(mode, process.cwd(), '')` 读取 `MIVO_IMAGE_API_KEY`；`vite.config.ts:301-314`、`vite.config.ts:369-375` 只在中间件上游请求中拼 Authorization；前端只命中 `/api/mivo/generate`、`/api/mivo/edit`。 |
| 派生模型 | 通过 | `src/store/canvasStore.ts:2023-2147` 的 `commitGenerationResult` 只追加新 image node + edge；M1 `generateBesideNode`/`generateIntoAiSlot` 在 `src/store/canvasStore.ts:2296-2303`、`src/store/canvasStore.ts:2381-2389` 调用它；M2 mask 在 `src/canvas/MivoCanvas.tsx:300-316` 调用它。 |
| 类型/代码风格 | 通过 | `rg "@ts-ignore|@ts-expect-error"` 无输出；`rg "\bany\b"` 仅命中 UI 文案；LeaferJS 仍只保留 `src/canvas/MivoCanvas.tsx:413-447` 空壳初始化，DOM 渲染未替换。 |

## Findings

### P2-1 生成/编辑链路没有超时，异常上游会让任务永久 pending

问题：前端 client 和 Vite 中间件都直接 `fetch`，没有 `AbortController`、`signal` 或统一超时封装。上游 llm-proxy 如果连接成功但长时间不返回，`isGenerating` 和 store task 会一直停在 running，用户无法得到失败态。

证据：
- `src/lib/mivoImageClient.ts:28-40` 的 `/api/mivo/generate` 请求无 `signal`。
- `src/lib/mivoImageClient.ts:58-61` 的 `/api/mivo/edit` 请求无 `signal`。
- `vite.config.ts:301-314`、`vite.config.ts:369-375` 的上游 `/generations`、`/edits` 请求也无 `signal`。
- `rg -n "AbortController|AbortSignal|signal:|timeout|requestTimeout" src vite.config.ts` 没有命中生成/编辑链路。

影响：M1 文生/图生、M2 局部重绘在上游卡住时不会进入已实现的 failed task/error UI；这正好漏掉本轮要求的“超时”失败处理。

最小修复：在 `src/lib/mivoImageClient.ts` 和 `vite.config.ts` 各加一个小型 `fetchWithTimeout`/`AbortController` 封装；前端超时抛出明确错误，Node 侧上游超时返回 504 JSON；保持非 200 和空响应现有处理。

验收：用本地 mock/测试让 `/api/mivo/generate` 或上游 fetch 永不 resolve，超时后 UI task 变 failed、按钮恢复可点，`npm run build` 仍通过。

### P2-2 空 b64 字符串会被当成有效图片并生成坏节点

问题：服务端响应归一化和前端响应校验只检查字段类型为 string，没有检查非空；`commitGenerationResult` 随后会把空 b64 解码为空 Blob 并写入 IndexedDB，画布上出现不可用 image node，而不是进入失败态。

证据：
- `vite.config.ts:246-258` 只要 `b64_json` 或 `b64` 是 string 就进入 `images`，空字符串不会被过滤。
- `src/lib/mivoImageClient.ts:16-20` 只校验 `typeof image.b64 === 'string'`。
- `src/store/canvasStore.ts:725-735` 对 `image.b64 || ''` 执行 `atob`，空字符串会得到 0 字节 Blob。

影响：上游返回 `{"data":[{"b64_json":""}]}` 或中间件返回 `{"images":[{"b64":""}]}` 时，M1/M2 会“成功”建出坏结果节点，破坏用户对非破坏派生结果的可信度。

最小修复：`normalizeMivoImages` 和 `validateMivoImageResponse` 都要求 `b64.trim().length > 0`；`blobFromCommittedGenerationImage` 在没有 `blob` 且 b64 为空时直接 throw；必要时捕获非法 base64 并转成明确错误。

验收：模拟空 b64 响应时不创建新节点，任务进入 failed 并展示错误；有效 b64 仍能保存为 `mivo-asset:` 并创建派生 edge。

### P2-3 M2 mask 对超大原图没有像素上限，可能在浏览器内存/Canvas 限制处失败

问题：局部重绘 mask 直接按原图 natural size 创建同尺寸 canvas，没有像素数或边长上限；超大 Eagle/本地图进入 M2 时，会先在浏览器分配整张 mask，再到中间件 40 MB 限制，失败点不可控。

证据：
- `src/canvas/CanvasNodeView.tsx:711-715` 从 `<img>` 读取 `naturalWidth/naturalHeight`。
- `src/canvas/ImageMaskEditOverlay.tsx:227-238` 提交时直接把 `naturalSize` 传给 `buildEditMaskBlob`。
- `src/canvas/imageMaskGeometry.ts:179-181` 直接 `canvas.width = naturalSize.width`、`canvas.height = naturalSize.height`，没有上限或降级路径。
- 中间件只在 `vite.config.ts:13`、`vite.config.ts:190-197` 对已经生成后的 multipart body 做 40 MB 上限，不能保护前端建 mask canvas 的内存峰值。

影响：大尺寸素材执行 M2 时可能卡死、抛出浏览器 canvas 限制异常，或生成超大 PNG 后才 413，用户只看到不可预测的局部重绘失败。

最小修复：在 `ImageMaskEditOverlay`/`buildEditMaskBlob` 前加 `MAX_MASK_PIXELS` 和最大边长检查；超限时明确阻止提交并提示先压缩/导入低分辨率版本。若要自动降采样，必须同步降采样 source image 和 mask，保持 image/mask 像素尺寸一致且透明区域语义不变。

验收：构造 12000x12000 测试图时不分配 full-size mask canvas，UI 给出明确错误；普通尺寸图仍输出与原图同像素尺寸、透明=要修改的 PNG mask。

## 通过项

- 密钥未进前端 bundle：dist 中没有 `MIVO_IMAGE_API_KEY`、`VITE_MIVO`、`llm-proxy`、`MIVO_IMAGE`、`image-key`、`Bearer`。
- `MIVO_IMAGE_API_KEY` 没有 `VITE_` 前缀；`vite.config.ts:728-729` 仅在 Node 配置闭包读取并注入中间件。
- 生成/编辑没有第二套前端 HTTP 实现；`src/store/canvasStore.ts` 和 `src/canvas/MivoCanvas.tsx` 都通过 `src/lib/mivoImageClient.ts` 的 `generateMivoImage`/`editMivoImage`。
- `/v1/images/edits` multipart 字段分清：前端 `src/lib/mivoImageClient.ts:48-56` 分别 append `image`、可选 `mask`、`reference[]`；中间件 `vite.config.ts:357-367` 也分别转发 `image`、`mask`、`reference[]`。
- M5 AI context 未漏派生关系：`src/store/aiCanvasWorkflow.ts:88-200` 过滤可视 content node，纳入 `edges`，并用 `linkKeys` 对 edge/parent/aiWorkflow/connector 去重。
- M4 Eagle 不在线降级存在：`src/app/LibraryWorkspace.tsx:330-359` 失败时置 `connected:false`、清空 assets/folders 并进入 error state；`src/app/LibraryWorkspace.tsx:927-933` 展示不可用状态。
- M4 复制粘贴走内部 clipboard：`src/app/LibraryWorkspace.tsx:457-463` 写入 store，`src/canvas/useCanvasInteractionController.ts:1380-1387` paste 优先消费 `clipboardAssets`，`src/store/canvasStore.ts:1514-1555` 批量创建 image nodes。

## 剩余风险

- 右键菜单/快捷工具栏里的 async 生成入口使用 `void` 调用，失败时底层 task 会变 failed，但调用端没有 catch，可能留下 unhandled rejection：`src/canvas/actions/canvasActionModel.ts:109-115`、`src/canvas/actions/canvasActionModel.ts:140-146`、`src/app/AIToolPanel.tsx:320-354`。建议后续统一用带错误收敛的 action runner。
- 旧 demo 路径仍有 mock：`src/store/canvasStore.ts:2157-2192` 的 variations 和 `src/store/canvasStore.ts:2429-2508` 的 annotation 结果仍用 mock/本地 case image。M1/M2 核心路径已走真实 client，本项未作为阻塞，但若 P5 要求所有 AI 菜单都真实生成，需要单独收口。
- `src/app/LibraryWorkspace.tsx:493-494` 对 OS clipboard 失败写 `console.warn`；它不阻断内部多图 clipboard，但会在权限拒绝时产生控制台噪音。

## 计数

- P1: 0
- P2: 3

## Round 2

GD_REVIEW_DECISION: APPROVED

复审对象：当前分支 `demo/canvas-ai`，HEAD=`c4d9ac5`。本轮只读源码并执行 `npm run build` / dist 安全 grep；未启动 dev server，未修改源码。

### 已复核结论

| 上轮项 | Round 2 结论 | 证据 |
|--------|--------------|------|
| P2-1 生成/编辑链路没有超时 | 已修复 | 前端统一 `fetchMivoWithTimeout`：`src/lib/mivoImageClient.ts:6-40`，`generateMivoImage` / `editMivoImage` 分别传 `signal`：`src/lib/mivoImageClient.ts:65-104`；Node 侧上游统一 `fetchUpstreamWithTimeout` 并在超时返回 504：`vite.config.ts:15-80`、`vite.config.ts:328-353`、`vite.config.ts:396-414`。UI 侧主生成可取消：`src/app/AIToolPanel.tsx:131-178`、`src/app/AIToolPanel.tsx:432-448`；M2 局部重绘也传 abort signal：`src/canvas/MivoCanvas.tsx:313-348`。 |
| P2-2 空 b64 被当成有效图片 | 已修复 | 中间件只收非空 b64：`vite.config.ts:268-286`；前端 response 校验要求 `image.b64.trim().length > 0`：`src/lib/mivoImageClient.ts:51-59`；落盘前再次拒绝空/非法 base64：`src/store/canvasStore.ts:723-740`。 |
| P2-3 M2 mask 超大原图无像素上限 | 已修复 | `maxMaskCanvasPixels=24_000_000`、`maxMaskCanvasEdge=6000`：`src/canvas/imageMaskGeometry.ts:27-35`；生成 mask 前调用校验：`src/canvas/imageMaskGeometry.ts:183-194`；提交前也先拦截并显示错误：`src/canvas/ImageMaskEditOverlay.tsx:262-278`。mask 语义仍是黑底 + `destination-out` 绘制区域，透明区域为要修改区域：`src/canvas/imageMaskGeometry.ts:198-204`。 |
| 安全回归 | 通过 | `npm run build` 通过，仅有 Vite chunk >500 kB 提示；`rg -n -o "MIVO_IMAGE_API_KEY|VITE_MIVO|llm-proxy|MIVO_IMAGE|image-key|Bearer" dist` 无输出；`git ls-files \| grep -iE '\.env|secret|image-key'` 无输出。密钥仍只在 `vite.config.ts:755-756` Node 配置闭包读取，并只在中间件上游请求写 Authorization：`vite.config.ts:331`、`vite.config.ts:399`。 |

### 新增/残留 Findings

无 P1/P2 残留。

### 剩余风险

- P3：AI panel 里的次级 workflow 按钮仍用 `void generateIntoAiSlot(...)` / `void generateBesideNode(...)` 直调：`src/app/AIToolPanel.tsx:347-381`。底层 client 已有 timeout，不会永久 pending；但调用端仍没有统一 toast/catch，失败主要落在任务状态里，后续可统一 action runner。
- P3：本轮 build 是在当前工作树执行；工作树已有非本报告产生的 `src/canvas/ImageMaskEditOverlay.tsx` 未提交改动。该改动不影响上述 P2 结论，但提交前应由 owner 确认是否纳入。

### Round 2 计数

- P1: 0
- P2: 0
