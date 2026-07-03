# /api/mivo/tasks/* — async task endpoints (P2-C1a, ADDITIVE)

> **不属 dev middleware 平移面**。这些端点在 dev middleware 中不存在(`vite.config.ts`
> 无 `/tasks/*` 路由),是 P2-C1a 新增能力。因此**不进 `__captures__/` dev diff 基线**,
> 不参与 `contract:diff --target=dev` 的逐字段比对。验收由 `server/__tests__/c1a.test.ts`
> (mock 上游)覆盖。

## 端点

| 方法+路径 | 请求 body | 响应 |
|----------|----------|------|
| POST /api/mivo/tasks/generate | 同 /generate(JSON:prompt/imgRatio/quality/model/n) | 202 `{taskId}`;400 缺 prompt;413 body>1MB |
| POST /api/mivo/tasks/edit | 同 /edit(multipart:image/prompt/quality/model/mask/reference[]) | 202 `{taskId}`;400 缺 image/prompt;413 body>40MB |
| GET /api/mivo/tasks/:id | — | 200 `{id,kind,status,progress,stage,requestId,model,result?,error?}`;404 `{error:'unknown-task'}` |
| DELETE /api/mivo/tasks/:id | — | 200 `{id,status:'canceled'}`;404 `{error:'unknown-task'}` |

- POST 立即返回 `{taskId}`(202 Accepted),任务在后台异步运行。
- `Idempotency-Key` header:同 key 在进程内存期内重复提交返回同 taskId(重启后失效视为新任务)。

## 任务态机

`pending → running → done | failed | canceled`

- `progress` 0-100,**单调非减**(registry 强制 clamp,终态后不再更新)。
- `stage`: `pending` | `submit` | `upload` | `poll` | `download` | `request` | `done` | `failed` | `canceled`。

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
- 同 key + 任务仍存在 → 返回同 taskId(不重新跑)。
- 同 key + 任务已被清除(不应发生,内存期任务不清除)→ 创建新任务。
- 重启后 index 清空 → 同 key 视为新任务(新 taskId)。

幂等不跨进程;客户端重试应带同一 key 以避免重复生成。

## 未验证项(需真实上游,本 PR 用 mock)

- 真实平台 submit/poll/download 的进度时序(用 mock 验证单调 + 阶段映射)。
- 真实 llm-proxy fetch 的 cancel 行为(用 mock delay 验证 abort)。
- 持久化(P4):重启后任务态 unknown 是设计语义,非 bug。
