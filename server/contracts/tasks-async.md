# /api/mivo/tasks/* — async task endpoints (P2-C1a, ADDITIVE)

> **不属 dev middleware 平移面**。这些端点在 dev middleware 中不存在(`vite.config.ts`
> 无 `/tasks/*` 路由),是 P2-C1a 新增能力。因此**不进 `__captures__/` dev diff 基线**,
> 不参与 `contract:diff --target=dev` 的逐字段比对。验收由 `server/__tests__/c1a.test.ts`
> (mock 上游)覆盖。

## 端点

| 方法+路径 | 请求 body | 响应 |
|----------|----------|------|
| POST /api/mivo/tasks/generate | 同 /generate(JSON:prompt/imgRatio/quality/model/n) | 202 `{taskId}`;400 缺 prompt;413 body>1MB |
| POST /api/mivo/tasks/edit | 同 /edit(multipart:image/prompt/quality/model/mask/reference[]) + 可选 `maskBounds`+`sourceSize`(P2-C2) | 202 `{taskId}`;400 缺 image/prompt;413 body>40MB |
| POST /api/mivo/tasks/variations | multipart:`image`(源图)+`variations`(JSON `Array<{prompt?,imgRatio?,quality?,model?}>`,1..4)+可选 `model`+Idempotency-Key | 202 `{taskId,batchId,count}`;400 缺 image/variations 或超 4;413 body>40MB |
| GET /api/mivo/tasks/:id | — | 200 `{id,kind,status,progress,stage,requestId,model,result?,failures?,batchId?,count?,error?}`;404 `{error:'unknown-task'}` |
| DELETE /api/mivo/tasks/:id | — | 200 `{id,status:'canceled'}`;404 `{error:'unknown-task'}` |

- POST 立即返回 `{taskId}`(202 Accepted),任务在后台异步运行。variations 额外返回 `batchId`(同批 N 张共享)+ `count`(请求数)。
- `Idempotency-Key` header:同 key 在进程内存期内重复提交返回同 taskId(重启后失效视为新任务)。

## P2-C2 扩展(variations + annotation area-edit,ADDITIVE)

### variations 端点

- **语义**:对一张源图,用 N 组不同参数(prompt/quality/model 等)并发生成 N 张变体(img-to-img,共享源图)。区别于 `/tasks/generate`(单次单图):variations 是一批并发。
- **请求**:multipart,`image`(源图 blob,客户端用 `assetBlobForNode` 取,同 `/tasks/edit`)+ `variations`(JSON 数组,每项 `{prompt?,imgRatio?,quality?,model?}`,1..`MAX_VARIATIONS`=4)+ 可选顶层 `model` + `Idempotency-Key`。
- **响应**:202 `{taskId, batchId, count}`。`batchId` 供前端分组展示(变体网格),`count` = 请求数。
- **运行**:`runVariationsTask` 用 `Promise.allSettled` 并发发起 N 个 llm-proxy `/edits` 调用,**并发上限** `MIVO_VARIATIONS_CONCURRENCY`(默认 4;>4 时分批,每批 4)。每调用 = 源图 + 该变体的 prompt/params。
- **状态聚合**(终态):
  - `done` —— 全成功;`result.images[]` 带 `variationIndex` 对齐回原参数组。
  - `partial` —— 部分成功;`result.images[]` = 成功子集(带 `variationIndex`),`failures[]` = 失败子集(带 `variationIndex` + 脱敏 error)。**partial 也 commit 成功的结果**(不全部丢弃)。
  - `failed` —— 全失败;`error` = 脱敏的首个错误。
- **失败脱敏**:`failures[].error` 是稳定分类符,不含 URL/key/upstream body。形态:`Upstream error (NNN)`(非 2xx)/`upstream-timeout`/`network-error`/`unknown-error`。`canceled` 不进 failures(取消时整任务走 canceled 分支)。
- **进度**:`progress = 5 + round(settled/total × 90)`,终态 100。settled = 已结算(成功或失败)的变体数。**真实,非硬编码**。
- **取消**:DELETE `/tasks/:id` → `controller.abort()` → 在途的 N 个 `/edits` fetch 全部 abort(`fetchUpstreamWithTimeout` 的 `externalSignal` 链)。终态保护:`completeTask`/`completePartialTask`/`failTask` 检查 `status==='canceled'` 短路——取消后永不产出 result。
- **平台模型**:C2 variations 仅走 llm-proxy `/edits`(不走 platform 通道,platform 需逐变体上传,复杂度暂不引入)。平台模型变体是 follow-up。

### annotation area-edit(/tasks/edit 复用,不新建端点)

- **语义**:一个 annotation 节点(`aiWorkflow.sourceNodeIds[0]` 指向源图 + 自身 text 是指令)→ 对源图指定区域按指令做 edit。区别于整图 edit:annotation 携带 bounds(区域)。
- **bounds 来源**:annotation 节点的可选 `annotationBounds?: CanvasMaskBounds`(canvas 坐标,x/y/w/h,**节点扩展字段,不动 persist 版本**,同 `experimentalAnchors` 的过渡路径)。
- **bounds → 请求**:客户端把 canvas 坐标的 `annotationBounds` 归一化为节点相对 0-1(`nx=(bounds.x-source.x)/source.width` 等),作为 `maskBounds` 字段连同 `sourceSize`(源图自然像素尺寸)发给 `/tasks/edit`。
- **BFF 生成 mask PNG**(裁决:mask 在 BFF,前端不碰像素):`/tasks/edit` 检测到 `maskBounds`(+ `sourceSize`)且无 `mask` 文件 → `generateAreaMaskPng(sourceSize, maskBounds)` 合成 RGBA PNG(尺寸 = sourceSize,edit 区透明 alpha=0,keep 区不透明黑 0,0,0,255,匹配 `buildEditMaskBlob` 格式)→ 作为 `mask` 传给 llm-proxy `/edits`。
- **无 bounds 退化**:纯文本批注(无 `annotationBounds`)→ 不发 `maskBounds`,退化为整图 prompt-edit(同 `generateImageEdit('prompt-edit')`)。

## 任务态机

`pending → running → done | partial | failed | canceled`

- `progress` 0-100,**单调非减**(registry 强制 clamp,终态后不再更新)。
- `stage`: `pending` | `submit` | `upload` | `poll` | `download` | `request` | `done` | `failed` | `canceled`。
- `partial`(P2-C2):仅 variations 产生。partial 是终态(同 done/failed/canceled),`completePartialTask` 设 progress=100 + result(成功子集)+ failures[]。客户端 partial **不 reject**(resolve 成功子集)。

## 进度映射(真实,非硬编码)

| 路径 | 阶段→进度 |
|------|----------|
| 平台通道(generate 平台模型 / edit 无 mask 平台模型) | upload(5,仅 edit)→ submit(10)→ poll(20-90,按 elapsed/deadline 线性映射)→ download(95)→ done(100) |
| llm-proxy(generate 非平台模型 / edit mask 或非平台模型) | request(10)→ done(100)(粗粒度,单次 fetch) |
| 失败/超时 | 进度停在最后值,`status=failed`/`error` |
| 取消 | 进度停在最后值,`status=canceled`,**永不产出 result** |

实现:`server/platform/job.ts` 的 `runMivoPlatformImageJob(ctx, params, signal, onProgress)` 与
`mivoPlatformPollJob` 在阶段切换 + 每个 poll 轮次调用 `onProgress`;`server/tasks/runner.ts`
把 `onProgress` 接到 `registry.updateProgress`。llm-proxy 由 `runner` 在 fetch 前后报 10/100。

## cancel 传导

`DELETE /tasks/:id` → `registry.cancelTask(id)` → `record.controller.abort()` → 上游:
- 平台:`mivoPlatformPollJob` 在循环顶检查 `signal.aborted` 中断;`mivoPlatformFetch`/download 的 `fetch` 带 signal,abort 即中断。`runMivoPlatformImageJob` catch 到 abort → `{aborted:true}`,runner 不 commit。
- llm-proxy:`fetchUpstreamWithTimeout(url, init, timeoutMs, externalSignal)`(P2-C1a 加 `externalSignal` 参数)把 task controller 链进 timeout controller,abort 即中断 fetch。

终态保护:`completeTask`/`failTask` 检查 `status==='canceled'` 短路——取消后永不产出 result。

## 重启语义

进程重启即内存清空(`Map` 非持久化,P4 落地)。GET 未知 taskId → 404 `{error:'unknown-task'}`。
**文档约定**:客户端不得 commit 重启后未知的任务(即重启后所有在途任务视为 unknown,客户端
必须重新提交或放弃,绝不能把重启前的 taskId 结果写回画布)。

## 幂等

`Idempotency-Key` header(可选)。registry 维护 `idempotencyIndex: Map<key, taskId>`:
- 同 key + 任务仍存在 → 返回同 taskId,**且不重新启动 runner、不重复调用上游**。`createTask` 返回 `{record, created=false}`,route 据此**跳过 runner 启动**(`if (created) void runXxxTask(...)`)。重复提交仅返回既有 taskId,不再 fire-and-forget 第二个 runner——避免重复计费 + 同 taskId 双 runner 竞态(P1 bug,已修;rev-behavior 复现固化)。
- 同 key + 任务已被清除(不应发生,内存期任务不清除)→ 创建新任务。
- 重启后 index 清空 → 同 key 视为新任务(新 taskId)。

variations 重复提交:返回同 taskId + 既有 `batchId`/`count`(从 record 读,不重新生成 batchId,客户端仍见原批次分组)。

幂等不跨进程;客户端重试应带同一 key 以避免重复生成。

## 未验证项(需真实上游,本 PR 用 mock)

- 真实平台 submit/poll/download 的进度时序(用 mock 验证单调 + 阶段映射)。
- 真实 llm-proxy fetch 的 cancel 行为(用 mock delay 验证 abort)。
- 持久化(P4):重启后任务态 unknown 是设计语义,非 bug。
