# 连接性矩阵 · API 调用与资产层分区（src/canvas + src/lib）

> 盘查范围：src/canvas/actions/*、src/canvas/maskEdit*、src/canvas/ImageMaskEditOverlay、
> src/lib/{mivoTaskClient,mivoImageClient,assetStorage,assetUrlLease,canvasAssetImport,
> useResolvedAssetUrl,authClient,authHeaders,regionDescribe,maskEditCompose,canvasImageSource,
> assetDownload,persistIdbStorage,demoImages}。
> 不含 src/store、src/app（由别的 worker 盘）。chatMaskEditFlow.ts / generationSlice.ts /
> remoteDebugReporter.ts 落在 src/store，仅在此标注跨区调用边界。
>
> 迁移后连接点术语：/api/canvas | /api/projects | /api/user-state | /api/assets | /api/mivo/*（生图端点保持）| /api/auth | 不需后端。
> 归属层：L1 文档内核 / L2 编排 / L4 渲染 UI / lib 服务。

## ① 前端发起 BFF 网络调用点（逐个列出）

| 功能/调用点 | 现状（打哪个端点 or 存哪） | 迁移后连接点 | 归属层 | per-user 化是否需要 | 现有测试覆盖 | 迁移风险 |
|---|---|---|---|---|---|---|
| SSO 身份获取 `fetchMe` `src/lib/authClient.ts:42` | `GET /api/auth/me`（nginx 网关 auth.dsworks.cn 的 SSO cookie 会话，401=未登录） | `/api/auth`（保持） | lib 服务 | 需要（已隐式：同源 cookie 带会话；网关层 per-user） | authClient.test.ts | 低：网关 cookie 模型不变；前端纯 fetch 薄壳 |
| 生图任务提交 `submitGenerationTask` `src/lib/mivoTaskClient.ts:147` | `POST /api/mivo/tasks/generate` 202 {taskId}，JSON body；带 `X-Mivo-Api-Key`+`X-Gateway-Key`+`Idempotency-Key` | `/api/mivo/*`（保持） | lib 服务 | 需要：当前只带 API key，无 user-id；鉴权后须加 per-user 身份 | mivoImageClient.test.ts（边界 mock） | 中：401→markUnauthenticated 逻辑（mivoTaskClient.ts:44-49）需与 per-user 会话对齐 |
| 局部重绘任务提交 `submitEditTask` `src/lib/mivoTaskClient.ts:212` | `POST /api/mivo/tasks/edit` 202 {taskId}，multipart（image/mask/markedImage/reference + maskBounds/subjects/prompt）；同上 headers | `/api/mivo/*`（保持） | lib 服务 | 需要：同 generate | maskEditGeneration.test.ts（32K，覆盖 submit+poll+self-heal） | 中：multipart 内含图片 blob，per-user 后须校验资产归属 |
| 变体批量任务 `submitVariationsTask` `src/lib/mivoTaskClient.ts:243` | `POST /api/mivo/tasks/variations` 202 {taskId,batchId,count} | `/api/mivo/*` | lib 服务 | 需要 | mivoImageClient.test.ts | 低 |
| 任务轮询 `pollTask` `src/lib/mivoTaskClient.ts:269` | `GET /api/mivo/tasks/:id` 200 TaskView \| 404 unknown-task | `/api/mivo/*` | lib 服务 | 需要（任务须按 user 隔离，防跨用户读任务） | maskEditGeneration.test.ts | **高**：服务端任务 registry 须 per-user 命名空间，否则 404/越权；client 404→status:'unknown' 回退（:274-283）保持 |
| 任务取消 `cancelTask` `src/lib/mivoTaskClient.ts:311` | `DELETE /api/mivo/tasks/:id` 200 \| 404（best-effort，swallow） | `/api/mivo/*` | lib 服务 | 需要（防跨用户取消） | maskEditGeneration.test.ts | 中：跨用户取消须服务端鉴权拒绝 |
| 同步生图（旧路径）`generateMivoImage` `src/lib/mivoImageClient.ts:132` | `POST /api/mivo/generate`（200 body）；**未带 authHeaders()**（:135-137 只设 Content-Type） | `/api/mivo/*` | lib 服务 | 需要：当前无 key header，依赖网关/ env 兜底 | mivoImageClient.test.ts | 中：与 tasks API 鉴权不一致，迁移时统一补 authHeaders |
| 同步局部重绘（旧路径）`editMivoImage` `src/lib/mivoImageClient.ts:173` | `POST /api/mivo/edit`（200 body）；**未带 authHeaders()** | `/api/mivo/*` | lib 服务 | 需要 | mivoImageClient.test.ts | 中：同上 |
| Prompt 增强 `enhanceMivoPrompt` `src/lib/mivoImageClient.ts:196` | `POST /api/mivo/enhance`，带 authHeaders()；调用方 chatStore.ts:312/579 | `/api/mivo/*` | lib 服务 | 需要 | mivoImageClient.test.ts | 低 |
| 源图 blob 读取 `assetBlobForNode` `src/lib/mivoImageClient.ts:218-227` | 先 `readImportedAssetFile`（IDB），miss 则 `fetch(node.assetUrl)`；调用方 generationSlice.ts:264/393/485/766 | `/api/assets/:id`（迁移后） | lib 服务 | 需要（资产须 per-user 鉴权） | mivoImageClient.test.ts | **高**：见 ③，mivo-asset: 伪 URL → 服务端资产 ID 的全链路重写 |
| 局部重绘结构化整理 `composeMaskEditBody` `src/lib/maskEditCompose.ts:19` | `POST /api/mivo/compose-mask-edit`，JSON，带 authHeaders()；调用方 maskEditSubmit.ts:62（buildMaskEditSubmission） | `/api/mivo/*` | lib 服务 | 需要 | 无单测（仅 maskEditGeneration.test.ts 间接） | 低：失败静默回退 null（:25-32），per-user 不阻塞出图 |
| 锚点识别 `describeRegionCrop` `src/lib/regionDescribe.ts:262` | `POST /api/mivo/describe-region`，multipart（crop+context），带 authHeaders()；调用方 useMaskAnchorRecognition.ts:117 | `/api/mivo/*` | lib 服务 | 需要 | regionDescribe.test.ts | 低：失败回退空候选（:276-285） |
| 外链图 CORS 代理 `canvasImageSource.ts:84/94/106` | `GET /api/mivo/proxy-image?url=<enc>`（直 fetch 失败/!ok 时兜底）；readCanvasImageBlob 链路 | `/api/mivo/proxy-image`（保持）或 `/api/assets/proxy` | lib 服务 | 视情况：代理本身不持用户数据，但 per-user 后须带会话 | canvasImageSource.test.ts（9K） | 中：fallback 链复杂（直 fetch→proxy→proxy-on-!ok），per-user 会话须穿透两层 |
| 标注图原图加载 `loadOriginalBitmap` `src/lib/regionDescribe.ts:46` | `fetch(url, {signal})`（url 为 resolvedAssetUrl 同源 blob，非 BFF） | 不需后端（同源 blob） | lib 服务 | 否 | regionDescribe.test.ts | 低 |
| 节点原图下载 `downloadCanvasNodeOriginal` `src/lib/assetDownload.ts:67` | `fetch(node.assetUrl)`（非 mivo-asset: 分支）；mivo-asset: 走 IDB | `/api/assets/:id`（迁移后） | lib 服务 | 需要（per-user 资产鉴权） | 无 | 中：下载链与资产迁移耦合 |
| URL→File 导入 `fileFromImageUrl` `src/lib/canvasAssetImport.ts:409` | `fetch(url)` → blob → File；用于 importImageUrlToCanvas | `/api/assets`（迁移后） | lib 服务 | 否（导入动作本身，结果才落资产） | 无 | 低 |
| Debug 日志上报 `remoteDebugReporter.ts:46`（**src/store，跨区**） | `POST /api/mivo/debug-logs`（defaultEndpoint） | `/api/mivo/debug-logs` 或 `/api/user-state/debug-logs` | L2 编排（store） | 需要（日志按 user 归档） | 属 store 区 | 低（不属本分区，仅标注边界） |
| 服务端持久化接线点 `syncToServer` `src/lib/persistIdbStorage.ts:133` | **当前空实现**，注释标 P4c 上线后改 `POST /api/persist` | `/api/user-state`（zustand persist 服务端化） | lib 服务 | 需要（per-user 状态） | persistIdbStorage.test.ts | 中：IDB 退为离线缓存层，server-authoritative merge |

> 注：`generateMivoImage`/`editMivoImage`（同步路径）的真实调用方在 `src/store/generationSlice.ts`（不在本分区），但客户端 lib 在此区。当前 generationSlice 已主要切到 tasks 异步流（submitGenerationTask/submitEditTask），同步路径是否仍有调用需在 store 区确认。

## ② 鉴权做完后，哪些调用需带 per-user 身份/key（现在 key 怎么传）

现状 key 传态（`src/lib/authHeaders.ts:16-22`）：
- `X-Mivo-Api-Key`（mivo_ MCP key）→ `useSettingsStore.getState().mivoKey`，浏览器侧 IDB 持久化（settingsSlice）。驱动 BFF `server/lib/keys.ts resolvePlatformCtx` + per-key token bucketing。
- `X-Gateway-Key`（sk- 网关 key）→ `useSettingsStore.getState().gatewayKey`。驱动 llm-proxy 调用（enhance / describe-region / compose-mask-edit via resolveGatewayKey）。
- 二者缺省 → BFF 回退 env（MIVO_PLATFORM_KEY / MIVO_LLM_API_KEY），legacy 单部署 env-key 仍工作。
- 调用方式：`authHeaders()` 在每个调用点 headers 里展开（per-call 读 store，非 hook），mivoTaskClient/enhance/compose/describe-region 都用；**但 generateMivoImage/editMivoImage 同步路径未带 authHeaders()**（见 ①）。
- SSO 身份（`authClient.ts` /api/auth/me）走 nginx 网关 cookie 会话，**前端不发 user-id header**，401 由 `mivoTaskClient.ts:44-49 onProtectedApi401` 处理（markUnauthenticated + toast，幂等）。

需 per-user 化的调用（鉴权后）：
| 调用 | 现状 per-user 载体 | 迁移动作 |
|---|---|---|
| /api/mivo/tasks/* (generate/edit/variations/poll/cancel) | 仅 API key + 网关 cookie | 任务 registry 须按 user 命名空间；cookie 同源即带，**无需前端加 user-id header**（除非跨域）；401 处理保留 |
| /api/mivo/generate\|edit (同步) | 无 authHeaders() | 补 `authHeaders()` 与异步路径一致；per-user 同上 |
| /api/mivo/enhance / compose-mask-edit / describe-region | API key + gateway key + cookie | per-user 配额按 user 而非 key 计；鉴权后可把 key 改为服务端按 user 注入（前端逐步退役手填 key） |
| /api/mivo/debug-logs | 见 store 区 | 按 user 归档 |
| /api/assets/* (迁移后) | 当前无（IDB 本地） | 须 per-user 资产鉴权（cookie 会话即可，无 extra header） |
| /api/auth/me | cookie 会话（已 per-user） | 不变 |
| /api/mivo/proxy-image | 无 key | per-user 后须带会话防滥用 |

**关键判断**：因 SSO 走网关 cookie 同源，绝大多数 `/api/mivo/*` 前端**无需新增 user-id header**——cookie 自动携带。per-user 化的主战场在**服务端**（任务/资产按 user 命名空间、配额按 user 计）。前端唯一硬动作：同步 generate/edit 路径补 `authHeaders()`，以及把 `settingsStore` 手填 key 模型逐步迁到「服务端按 user 解析 key」。

## ③ 图片资产引用链路（assetId vs 真 blob / resolve 链路 / 迁移到 /api/assets 改哪）

### 现状引用链
节点 `node.assetUrl` 取值四态（`src/lib/assetStorage.ts` + `useResolvedAssetUrl.ts`）：
1. `mivo-asset:<uuid>`（IMPORTED_ASSET_PREFIX，:6）→ **伪 URL，真 blob 在 IndexedDB** `mivo-canvas-assets` / store `assets`（:3-5,61-94）。用户导入图、AI 生成结果都落此。
2. `blob:` URL → 瞬态（createObjectURL），经 `assetUrlLease` refcount 管理（:36 leaseMap）。
3. `http(s)://...` → 外链图（CORS 走 /api/mivo/proxy-image 兜底）。
4. plain path（demo-assets / eagle 本地图）→ 同源直 fetch。

resolve 链路（渲染侧）：
```
node.assetUrl (mivo-asset:<uuid>)
  → useResolvedAssetUrl.ts:20  acquireAssetUrl
  → assetUrlLease.ts:106       resolveAssetUrl（IDB get → URL.createObjectURL）refcount 共享一个 blob:
  → <img src=blob:> / Leafer Image paint
  → release() on unmount → refCount=0 → URL.revokeObjectURL
```

提交侧（生图/局部重绘取源图）：
```
node.assetUrl
  → readImportedAssetFile (assetStorage.ts:300, IDB get → {blob,name,type})
  → readCanvasImageBlob (canvasImageSource.ts:125, normalize 生成结果 alpha→白底)
  → multipart 上行 /api/mivo/tasks/edit
```

序列化（持久化/跨设备）：`serializeImportedAsset`（:317）blob→dataUrl；`restoreSerializedAsset`（:335）dataUrl→blob→IDB put。当前**纯客户端 IDB**，无服务端资产存储。

### 迁移到 /api/assets 需改的点
| 现状位置 | 现状行为 | 迁移后 |
|---|---|---|
| `assetStorage.saveImportedAsset` :249 | `crypto.randomUUID()` → IDB put → 返回 `mivo-asset:<id>` | POST /api/assets → 服务端返 assetId → 节点存 `mivo-asset:<server-id>`（或新伪 URL） |
| `assetStorage.saveGeneratedAsset` :283 | 同上（生成结果 b64→Blob→IDB） | POST /api/assets（per-user） |
| `assetStorage.resolveAssetUrl` :289 | IDB get → createObjectURL | GET /api/assets/:id → blob（或 302 到 CDN）；IDB 退为离线缓存 |
| `assetStorage.readImportedAssetFile` :300 | IDB get → blob | GET /api/assets/:id blob（per-user 鉴权） |
| `assetStorage.serializeImportedAsset` :317 / `restoreSerializedAsset` :335 | blob↔dataUrl 纯本地 | 跨设备不再需 dataUrl 序列化（服务端权威）；dataUrl 路径降级为离线恢复 |
| `assetUrlLease.acquireAssetUrl` :76 | refcount createObjectURL | 缓存层仍可共享 blob URL，但 resolve 改为 fetch /api/assets/:id → blob → createObjectURL |
| `useResolvedAssetUrl` :5 | 不变（仍 acquire/release） | 不变（lease 层吸收） |
| `canvasImageSource.readSourceImageFile` :68 | mivo-asset: → IDB；http → fetch/proxy | mivo-asset: → GET /api/assets/:id；http 路径不变 |
| `mivoImageClient.assetBlobForNode` :218 | readImportedAssetFile → fetch fallback | 同上，GET /api/assets/:id |
| `assetDownload.downloadCanvasNodeOriginal` :60 | mivo-asset: → IDB；else fetch | GET /api/assets/:id（带 Content-Disposition 下载头） |
| `canvasAssetImport.importImageFileToCanvas` :298 | saveImportedAsset → 节点 | POST /api/assets → 节点 |

**最大迁移风险**：`mivo-asset:` 伪 URL 是节点 `assetUrl` 的持久化形态（zunstand persist 入 IDB/user-state）。迁移时要么保持 `mivo-asset:<id>` 语义不变（服务端认这个 id），要么做一次节点 assetUrl 字段迁移。`assetUrlLease` 的 refcount 模型可复用（resolve 换源即可），`useResolvedAssetUrl` hook 无需改。

---

## 最关键发现（3-5 条）

1. **资产层是纯客户端 IDB，零服务端存储**：`assetStorage.ts` 用 IndexedDB `mivo-canvas-assets` 存 blob，节点 `assetUrl` 存 `mivo-asset:<uuid>` 伪 URL。迁移到 `/api/assets` 必须新增 saveImportedAsset/saveGeneratedAsset → POST、resolveAssetUrl/readImportedAssetFile → GET 的服务端对接，且 lease refcount 层（`assetUrlLease.ts`）要换 resolve 源——这是本分区最大的迁移面。

2. **per-user 化主战场在服务端，前端基本不需加 user-id header**：SSO 走 nginx 网关 cookie 同源会话（`authClient.ts`），`/api/mivo/*` 的 per-user 隔离靠 cookie 自动携带即可。前端唯一硬伤是**同步 generate/edit 路径未带 `authHeaders()`**（`mivoImageClient.ts:132/173`），与异步 tasks 路径鉴权不一致，迁移时须补齐统一。

3. **任务 registry 须 per-user 命名空间**：`pollTask`/`cancelTask`（`mivoTaskClient.ts:269/311`）当前按 taskId 直查，404→status:'unknown'。迁移后服务端须按 user 隔离任务，否则跨用户读/取消任务成为越权面；client 侧 404 回退语义保持即可。

4. **局部重绘提交链跨 4 个 BFF 端点 + 1 个 CORS 代理**：`ImageMaskEditOverlay`（:492）→ `buildMaskEditSubmission`（maskEditSubmit）→ 调 `compose-mask-edit`（结构化整理）+ `describe-region`（锚点识别，useMaskAnchorRecognition）+ `tasks/edit`（提交）+ `proxy-image`（外链源图兜底，canvasImageSource）。任一端点 per-user 化都须保证会话穿透 fallback 链（直 fetch→proxy→proxy-on-!ok）。

5. **`/api/persist` 接线点已预留但未实装**：`persistIdbStorage.ts:133 syncToServer` 当前空实现，注释标 P4c 上线后改 `POST /api/persist`。这正是 zustand 状态服务端化（→ `/api/user-state`）的预留口，迁移时直接在此处接线，IDB 退为离线缓存层。
