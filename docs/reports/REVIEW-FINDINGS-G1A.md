# G1-a 双审 REQUIRES_CHANGES — finding 全文（lead+sol 共识，2026-07-12）
3 P1 + 1 P2。lead 已核证 P1-1/P1-2/P1-3。核心判定：交付的是"可调用原语"，不是计划 §4 要求的"客户端接线"。

## P1-1 原语未进任何生产调用链
getServerPersistAdapter / createAdapterWriteExecutor / hydrateUserStateMap / getPersistMode 排除测试后零调用方；?persist=server/shadow 下应用行为与 local 完全相同；构建产物中相关标识被 tree-shake。
修法：① store boot 单点读 persistMode：server 走服务端 hydrate；shadow 保持 IDB 读源 + 执行 compare；② 非画布 project/canvas-meta/user-state/asset 实际 mutation 接入 adapter，网络失败 enqueue；③ server/shadow 启动 createWriteQueue({executor})，local inert；④ 真实 store action→request→retry/hydrate 集成测试。
验收：local 0 网络请求；shadow 双写+差异可观测；server 冷启动从 BFF 恢复、reload 后保留；断网入队恢复后 drain。
附加（sol 焦点结论 3）：完成接线后加 server readiness/backend 持久性门控——防手改 URL 在 memory 后端上"假持久"。

## P1-2 非画布 surface 不完整
缺：project get/update/delete、canvas-meta create/update/delete（真实 BFF 路由已有：projects.ts:163,185,263 / canvas.ts:224,284,380）、asset attach/detach 的 client+route seam（assetStore 明确 liveness 靠 attach/detach，现 refcount 恒 0）。
修法：补齐上述方法到 shared contract + ServerPersistAdapter + WriteOp/executor；attach/detach 给明确 client+route seam 并接 node/asset 生命周期（node mutation 等 G1-c 的部分至少冻结契约+路由+defer 边界）。
验收：每个 CRUD 真实 Hono app 往返；rename/delete/create canvas reload 一致；attach 0→1 幂等、detach 1→0、跨 owner 拒且不变。

## P1-3 canvas/chat op → terminal 会永久删除 durable 队列记录
executor 对 canvas/chat 返 terminal；queue 对 terminal deleteWrite——G1-c/DP-6R 上线前的遗留 IDB 记录会被不可恢复删除，且 toast 让用户"重试"时原 op 已不存在。
修法：类型拆分让 G1-a executor 只接受 NonCanvasWriteOp；已持久化的未支持 op 用 deferred/unsupported-retained 状态保留（不发请求不删除）；G1-c/DP-6R 接线后显式升级 executor。另 conflict 无 onConflict 也会删记录——接线时强制提供可恢复处理。
验收：预置 canvas/chat 队列记录 drain 后仍在且不发请求；升级 executor 后同 idempotency key 可 replay；无 unsupported 分支调 deleteWrite。

## P2-1 wiring 测试 stub 有假阳性
stub 只读 pathname 忽略 query——listCanvas(projectId) 断言恒过（只 seed 一个 canvas）；stub owner=raw key 与真实指纹/SSO 不同。
修法：新增服务端 integration test 用 createPersistApp/Hono app.request 作 FetchLike 驱动真实 routes（multipart 单列）；保留轻量 request-construction unit test 但不得宣称端到端。
验收：seed p1/p2 后 listCanvas('p1') 只返 p1；真实路由覆盖 428/409/422/404-delete/actor 语义/multipart。

## sol 已确认无需改的点（别白费工）
classifyHttpStatus 的 8 态映射基本合理；authHeaders lazy import 无首调竞态；HttpError 与既有错误类无冲突；scripts/CI 无字面引用。
