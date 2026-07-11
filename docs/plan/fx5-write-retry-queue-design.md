# FX-5 写失败重试队列设计

> 架构迁移计划 P1 条目 FX-5(`docs/plan/arch-migration-execution-plan.md` §4)。
> 契约来源:`shared/persist-contract.ts`(#194 已合入 main,4 API + 错误码语义)。
> 命名空间沿用 FX-6 per-user 化(`src/lib/persistUserId.ts` `getPersistUserId`/`namespacedKey`,#183)。

## 目标

pm2 restart / 网络抖动窗口内的客户端写入不丢:客户端 durable 重试队列(IDB、按 userId 分区),窗口内写入最终落库。

## 边界

- **只动客户端**:`src/lib/writeRetryQueue.ts`(+ `writeRetryQueue.test.ts` + 本设计文档)。
- **不接线**:`ServerPersistAdapter` 当前 `unwired`(全 reject,见 `src/lib/serverPersistAdapter.ts`),真 fetch 实装是 T1.3 PG worker 的活。本模块零运行时副作用直到 T1.3 调 `createWriteQueue({ executor }).start()`;从不 import unwired adapter。
- **消费契约,不改契约**:import `shared/persist-contract.ts` 的 `NodePayload`/`EdgePayload`/`AnchorPayload`/`Revision` + `isUserStateKeyForbidden` 语义,不改它。
- **`uploadAsset` 不入队列**:资产内容寻址 + refcount(T1.5 #195)自有重试语义,二进制 blob 在 IDB 偏重,排除(文档化)。

## 数据模型(IDB)

独立 DB `mivo-write-queue` v1,object store `writes`(keyPath `id`)。**不碰** `mivo-canvas-persist`(FX-6/T1.3 共用),避免冲突与生命周期耦合。每条 record 带 `userId` 字段分区;drain 只处理 `getPersistUserId()` 的 record。IDB 不可用(隐私模式)降级为内存 `Map`——仅 pm2 窗口内 durable(页面不关),不跨页重载,`debugLogger.warn` 提示。

```ts
type QueuedWrite = {
  id: string                // 记录 id = IDB key
  idempotencyKey: string     // 持久化,重放复用 → 服务端 dedup
  userId: string             // 分区
  op: WriteOp                // 写操作判别 union(见下)
  resourceKey: string | null // coalescing 键(null=永不合并)
  createdAt: number          // 入队时间
  attempts: number           // transient 失败计数
  nextAttemptAt: number      // 下次 drain 时间
  status: WriteStatus
  lastError?: string
  lastAttemptAt?: number
}
```

## 写操作 union(消费契约 payload 类型)

```
upsertNode/Edge/Anchor(canvasId, recordId, payload, baseRevision?)
deleteNode/Edge/Anchor(canvasId, recordId)
reorderChildren(canvasId, type, orderedIds, baseContentVersion)
appendChatMessage(canvasId, message)        // 不 coalesce(每条独立)
putUserState(key, value, baseRevision?)     // DP-7 守卫
deleteUserState(key)
createProject(name, id?)                    // 409-exists 走安全终态(见下)
```

## 状态机

```
pending → in-flight ─┬─ success              → 删
                      ├─ conflict(409)        → 终态,onConflict 回调,删
                      ├─ too-large(413)       → 终态,删
                      ├─ rejected(400/403/404非删/428/409-exists/405) → 终态,删
                      ├─ reuse-conflict(422)  → 终态,删
                      ├─ dead-letter(超 maxAttempts) → 终态,删
                      ├─ transient(5xx/408/429/网络) → 退避 → pending
                      └─ unauthorized(401)    → paused-401,队列暂停,不清,resume 后 drain
```

## 幂等 key

入队时 mint `idempotencyKey`(`crypto.randomUUID()` 优先,兜底时间戳+随机),持久化,重放复用 → 服务端按契约 dedup(同 key + 同 body → 200 既有;同 key + 不同 body → 422)。coalesce 替换 op 时 **mint 新 key**(新 body 需新 key,复用旧 key 会 422)。

## Coalesce + 溢出(显式策略,不静默丢)

- **resourceKey**:`node|edge|anchor:<canvasId>:<recordId>`;`userstate:<key>`;`reorder:<canvasId>:<type>`;`project:<id|name>`;`appendChatMessage` → `null`(每条独立)。
- **coalesce**:入队时若同 `resourceKey + userId` 的 `pending`/`paused-401` record 存在 → 替换 `op` + mint 新 `idempotencyKey` + 重置 `attempts=0` + `nextAttemptAt=now`(不新建 record)。`in-flight` **不 coalesce**(避免 stale outcome;新 pending record 排队,旧 in-flight 出结果后新 record 再 drain)。
- **上限** `maxQueuePerUser`(默认 256):超限驱逐最老 `pending`(非 in-flight)+ `toastFeedback.warn` "本地保存队列已满,最早的一条改动被丢弃";全 `in-flight` 无可驱逐 → 拒入队 + `toastFeedback.error` "保存队列繁忙,请稍后重试"(非静默)。

## 退避

`delay = min(base * 2^(attempts-1), max) * jitter(0.5..1.0)`。默认 `base=1s`、`max=60s`、`maxAttempts=8` → 约 2min 后 dead-letter。jitter 防服务端恢复时 thundering herd。`random`/`clock` 可注入(测试确定性)。

## enqueue 不自动 drain

`enqueue` 是纯 persist + 返回 id(不触发 drain),保证确定性(无后台 drain 与调用方竞争)。drain 由 `start()` 定时器(5s)/ `online` 事件 / `visibilitychange`(切回前台)/ 显式 `queue.drain()` 触发。T1.3 可在 enqueue 后显式 `queue.drain()` 获得即时发送;`start()` 的即时 drain + 周期定时器覆盖 pm2-restart 恢复窗口。

## 错误码分支(`classifyHttpStatus` → outcome → 队列动作)

| HTTP | outcome | 队列动作 | 用户提示 |
|------|---------|---------|---------|
| 2xx | success | 删 record | — |
| 401 | unauthorized | 该 op 标 `paused-401`,队列 `paused=true`,停 drain,**不清数据** | toast info "登录已过期,重新登录后将自动重试未保存的改动" + debugLogger.warn |
| 409 revision-conflict | conflict(`currentRevision`) | **不盲重试**,终态,`onConflict(op,currentRevision)` 回调(可选 rebase) | toast warn "你的部分改动与服务器版本冲突,请刷新画布" + debugLogger.warn |
| 409 project-exists/canvas-exists | rejected | 安全终态(无法确认是本会话 lost-response 还是他人占用 → 不假设成功) | toast error + debugLogger.error |
| 413 | too-large | **不重试同 payload**,终态 | toast error "这条改动内容过大,无法保存" + debugLogger.error |
| 422 | reuse-conflict | 终态(客户端 key 复用 bug) | toast error + debugLogger.error |
| 400/403/428/405 | rejected | 终态 | toast error + debugLogger.error |
| 404 | isDelete → success(幂等删);否则 rejected | 删 | isDelete 静默;否则 toast error |
| 5xx/408/429 | transient | 退避重试(达 maxAttempts → dead-letter) | dead-letter:toast error "多次重试失败,部分改动未能保存" + debugLogger.error |
| 其他 | terminal | 不重试,删 | toast error + debugLogger.error |

## DP-7(两把 key 永不进队列 payload)

入队 `putUserState`/`deleteUserState` 时,若 `key` 命中 `isUserStateKeyForbidden`(`gateway-key`/`mivo-key`/`secret|token|password|apikey` 模式,契约已导出)→ **拒入队** + `toastFeedback.error` "该设置项不能同步,已阻止" + `debugLogger.error`,永不进 IDB。两把 key 永不进队列。node/edge/anchor payload 不含 user-state key,服务端 `scanForSensitiveFields` 是 payload 权威,队列不二次校验(文档化)。

## 用户可见降级(按 `docs/development-logging.md`)

所有终态/溢出/401/dead-letter 都走 `debugLogger`(warn/error)+ `toastFeedback`(info/warn/error)。终态 record 在 toast+log 后 **删除**(`debugLogStore` 是审计轨迹 + Debug Log 面板可查;IDB 不留垃圾、不无限膨胀)。401 record 不删(待 resume 重试)。

## 执行器 seam(T1.3 接线点)

- `WriteExecutor = (op, idempotencyKey) => Promise<WriteOutcome>`
- `classifyHttpStatus(status, body, { isDelete })` —— T1.3 的真 fetch executor 用它把 HTTP 响应映射成 outcome。
- `isDeleteKind(kind)` —— 计算 `isDelete`(给 classifyHttpStatus 用)。
- T1.3 接线示意:`createWriteQueue({ executor: realExecutor, onConflict }).start()`;`realExecutor` 按 `op.kind` dispatch 到真 `ServerPersistAdapter` 方法 + 设 `idempotency-key` header + `classifyHttpStatus`。
- `start()` 注册:`setInterval(drain, 5s)` + `online` 事件 + `visibilitychange`;`stop()` 清理。未调 `start()` → 零副作用。

## 测试(`fake-indexeddb/auto`,36 用例全绿)

- `classifyHttpStatus` 各错误码(11 用例,纯函数)
- enqueue + drain 成功 / 未来 nextAttemptAt 不 drain
- 重放幂等(同 op 重放 → executor 收到**同一 idempotencyKey**)
- 各错误码分支(mock executor 返对应 outcome,断言**队列真实状态 + 副作用**):409 conflict + onConflict、413 too-large 不重试、422 reuse-conflict、400 rejected、404 delete=success/non-delete=rejected、terminal、5xx 退避重试后成功、dead-letter(maxAttempts)、401 暂停 + resume
- coalesce:同 resourceKey pending 合并(新 key)、appendChatMessage 不合并、delete 取代 upsert、in-flight 不合并
- 溢出:超限驱逐最老 pending + toast;全 in-flight 拒入队
- per-userId 分区(A 的 op 不为 B drain)
- 跨 session durable(enqueue → 新队列实例 → drain 落库)
- DP-7 拒入队(`gateway-key`/`mivo-key` → throw,不进 IDB;allowed key 正常入队)
- IDB 不可用 → 内存降级
- start/stop 生命周期(start 即时 drain、stop 停周期)

测试用 `__dumpWritesForTest`(复用模块自身 IDB 连接,避免独立连接竞态)+ `__resetWriteQueueDb`(`store.clear()` 而非 `deleteDatabase`,后者在 fake-indexeddb 下 open/close/delete 竞争会留 blocked versionchange 毒化后续 beforeEach)。

## 未验证项 + 风险

- **未接真 server**:executor 用 mock,真 fetch 路径待 T1.3 接线后 e2e 验证。
- **409 rebase**:本模块只 surface `currentRevision` + 可选 `onConflict` 回调,不自动 rebase(需 fetchCanvas + merge,属应用层);若上层无回调,409 走"toast + 删"让用户刷新。
- **createProject 409-exists**:保守走 rejected 终态(不假设是本会话的 lost-response),极少数 lost-response 重放会假"创建失败"——用户重试可见已存在,可接受。
- **并发多 tab**:多 tab 同 userId 各自 drain,可能重复发同 idempotencyKey → 服务端 dedup 兜底(200 既有),不产生重复副作用;两 tab 对同 resource 各自入队新 op 不 coalesce(跨 tab),最终 last-write-wins 由服务端 revision 裁定。
