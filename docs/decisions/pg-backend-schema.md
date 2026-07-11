# PG 持久化后端 schema 与实施定稿(T1.3 PgPersistBackend)

> 状态:**实施定稿(2026-07-11)**。T1.3 PgPersistBackend(Kysely+PG16)的 schema、revision 粒度、FX-4 节点级 PATCH 兼容性、全局唯一索引缓存、env 开关、swap 语义。
> 上游真相源:`docs/decisions/api-surface.md`(契约冻结 + 附录 A SQL 草案)、`docs/decisions/record-schema.md`(K40/revision/三域)、`docs/decisions/soft-delete-semantics.md`(§2/§3/§7)、`docs/plan/arch-migration-execution-plan.md`(§3 DP-5/DP-6/DP-7 + FX-4)。
> 源码:`server/persist/pgBackend.ts`(PgPersistBackend)、`server/persist/migrations.ts`(migration)、`server/persist/pgConfig.ts`(连接+开关)、`server/persist/backend.ts`(接口 + 内存实现)。

## 1. 表结构(对齐附录 A 草案 + 实施去重)

附录 A 草案钉死:信封列 + payload jsonb + revision 乐观并发 + order_key + cascade 软删语义 + 幂等独立表。实施 PR 只补索引/Kysely 层,不改契约。本节是实施层定稿。

| 表 | 列 | 说明 |
|---|---|---|
| `persist_records` | `id, owner_id, canvas_id(NULL), type, scope, revision, order_key, is_deleted, created_at, updated_at, payload(jsonb)` PK`(owner_id,type,id)` | **单一真相源**——全 record 信封列 + payload jsonb(DP-5)。所有 record 类型(project/canvas/chat-collection/node/edge/anchor/chat-message/user-state)都存此表。 |
| `projects` | `id PK, owner_id, is_deleted, created_at, updated_at` | **瘦全局唯一索引**(id→owner→is_deleted)。附录 A 草案此表含 `payload JSONB`;**实施去重——payload 留 persist_records 单一真相**,本表退化为全局归属索引,减少双写同步面。语义不变:project id 全局唯一(跨 owner 同 id → 409);授权 seam `getProjectOwner` 经此查归属。 |
| `canvases` | `id PK, owner_id, is_deleted, created_at, updated_at` | **瘦全局唯一索引**(F4,与 project 同模式)。canvas meta payload(含 contentVersion)留 persist_records(type='canvas');本表只钉 id→owner 全局归属 + 软删占位。 |
| `idempotency_index` | `owner_id, method, resource_kind, key, fingerprint, envelope_owner, envelope_type, envelope_id, created_at` UNIQUE`(owner_id,method,resource_kind,key)` | 幂等(#10):复合 key 跨 type 不串 + fingerprint + envelope ref。 |

索引(附录 A):`idx_persist_canvas(owner_id,canvas_id,type) WHERE is_deleted=FALSE`、`idx_persist_order(owner_id,canvas_id,type,order_key) WHERE is_deleted=FALSE`。

> **去重理由**:附录 A 把 `projects`/`canvases` 草拟为含 payload 的独立表。实施时若 payload 双写(persist_records + projects/canvases),需事务内保证两处一致,增同步面 + bug 面。payload 留 persist_records 单一真相,projects/canvases 退化为瘦索引(id+owner+is_deleted),授权 seam + 全局唯一只读瘦表,缓存预热也只 load 瘦表。**契约语义零变化**(全局唯一 409 / 软删占位 / purge 释放 / getProjectOwner 归属查均不变)。

## 2. revision 粒度 + 乐观并发(#4/#5)

- **per-record revision**(envelope.revision,信封列,§13.5):每条 record 独立 revision,LWW tie-break。wire payload **不带** id/revision(返修 #5);id 来自 path,revision base 来自 `If-Match` header,envelope.revision 是唯一真相。
- **乐观并发**:`UPDATE persist_records SET revision=revision+1, ... WHERE owner_id=$ AND type=$ AND id=$ AND revision=$client`。行影响 0 → 409 `revision-conflict`(返 `currentRevision`)。existing 缺 If-Match 由 route 决 428(`precondition-required`,#4)。create 路径(POST ensureCreate + PATCH missing→create)免 base;fresh create revision = `max(0, If-Match)`(#5,对齐 MemoryDocKernel.nextRevision)。
- **canvas metaRevision vs contentVersion 分名**(#5):`metaRevision`=canvas meta record envelope.revision(PUT /api/canvas/:id 的 If-Match base);`contentVersion`=canvas meta payload.contentVersion,backend 在子资源(node/edge/anchor/chat-message)写入时 bump,**不动 metaRevision**。bump 用原子 SQL:`jsonb_set(payload,'{contentVersion}',to_jsonb(COALESCE((payload->>'contentVersion')::int,0)+1))`——单语句原子,并发子资源写无 lost-update。

## 3. FX-4 节点级 PATCH 兼容性(本 PR 设计到位)

FX-4:"1MB/413 已源码实证(`jsonRequestMaxBytes=1048576`);节点级 PATCH 与 revision 同设计。几千节点保存不撞 1MB/413"。本 PR schema/revision 设计**天然支持后续节点级 PATCH**:

- **每节点一行**:node/edge/anchor 各是 persist_records 一行(payload=NodeRecord/EdgeRecord/AnchorRecord jsonb)。PATCH `/api/canvas/:id/nodes/:nodeId` body=`{payload: NodeRecord}`,单节点 payload 远 < 1MB。**几千节点保存 = 几千次单节点 PATCH,每次 body 远 < 1MB,不撞 1MB/413**。对比:整画布一次性 PUT(把全部 nodes 塞一个 body)会撞 1MB——FX-4 的正解就是节点级 PATCH,而本 schema 天然支持。
- **per-record revision** = 节点级合并 LWW tie-break(§13.5):同节点才冲突提示 409,不同节点并发 PATCH 互不阻塞。client rebase(重读→merge→重试)。
- **canvas_id 不可变**(#3):PATCH `WHERE owner_id+canvas_id+type+id`,canvas_id 不可变(跨 canvas → 404 `unknown-*`)。
- **payload 白名单 runtime 校验**(#13,shared `validateChildPayload`):PATCH node/edge/anchor payload 经白名单(必填/类型/拒 unknown/非 string id/mirror-field/forbidden-field),route 层已实现,PG 不重做。
- **PATCH 路由本体**(`PATCH /api/canvas/:id/nodes/:nodeId` 等)**已由 #194 实装**(canvas.ts:473-475),走 `upsertChild`;本 PR 只保证 PG 后端 drop-in 支持之。FX-4 的"设计到位"= schema/revision 粒度 + contentVersion bump + 1MB body limit 已就绪,节点级 PATCH 路由已通;**无遗留设计缺口**。

## 4. 全局唯一索引同步读 + 内存缓存(契约接口同步的解法)

`PersistBackend` 接口的 `getProjectOwner(id)`/`getCanvasOwner(id)`/`projectLive(ownerId,projectId)` **同步**(route authz seam `authzProject`/`authzCanvas` 同步调用)。PG 查询本质异步,不能在同步 seam 里 `await`。解法:

- **内存缓存**(`projectIndex`/`canvasIndex` Map<id,{ownerId,isDeleted}>):同步读,启动从 PG 全量 load projects/canvases 瘦表(预热,`ready` promise);写操作在事务提交后同步缓存。
- **事务内 F1 用 `SELECT...FOR UPDATE`**(不读缓存):`createCanvasWithCollection`/`ensureCreate(canvas)`/`upsert(canvas move)` 的 parent-live 检查在事务内 `SELECT is_deleted FROM projects WHERE id=$ FOR UPDATE`,防跨事务 TOCTOU(等效内存实现的同步临界区 `restoreCanvasWithCollectionCritical`)。并发 DELETE project 与 canvas create 的 TOCTOU 由行锁串行化。
- **F4 全局唯一**:projects/canvases 表 id PK + 事务内 SELECT 预检 + INSERT UNIQUE 约束(race 由 UNIQUE 兜底 → exists-other-owner)。
- **单实例 BFF 假设**:缓存 in-process,所有写经本 backend 实例 → 缓存与 DB 一致。**多实例协作留 T1.4+**(需缓存失效/共享;P1 灰度单实例足够)。
- **`ready: Promise<void>`**(接口 additive 字段):memory 立即 resolve;PG 预热完成。`server/index.ts` serve 前 `await sharedPersistBackend.ready`,确保同步 seam 缓存已 warm(memory no-op,生产零变化)。

## 5. env 开关 + 连接配置

- **后端选择**:`MIVO_PERSIST_BACKEND=pg|memory`,默认 **memory**(生产零变化),PG 灰度启用(与 `?kernel=` 旗下切换风格一致)。`server/app.ts` 注入点按 env 选 PgPersistBackend / InMemoryPersistBackend;路由零改动。
- **PG 连接**:`MIVO_PG_HOST/PORT/DB/USER/PASSWORD`(env 驱动,不写死密码;.env 不入 git,模板 `ops/postgres/.env.example`)。生产端口 55442(`MIVO_PG_HOST_PORT`);本地/测试用本地 PG 实例(brew PG 16.14,端口 55443,见 §7)。
- **fail visibly**:PG 启用但缺 `MIVO_PG_PASSWORD` → `resolvePersistBackendConfig` 抛错(不静默降级 memory——那会让"原样在"假绿)。

## 6. 原子 tree 软删/恢复 + 幂等

- **原子 tree**(返修 #7):`softDeleteCanvasTree`/`softDeleteProjectTree`/`restoreCanvasTree`/`restoreProjectTree`/`createCanvasWithCollection` 用**单事务**(`db.transaction().execute`),失败全回滚(等效内存实现的快照回滚)。cascade 只标 canvas/project/chat-collection `is_deleted=true`;node/edge/anchor/chat-message 保持活记录(随父级不可见,返修 #2)。单条 DELETE 走 `hardDeleteChild`(物理移除)。
- **幂等(#10)**:idempotency_index 独立表,UNIQUE(owner+method+resourceKind+key)。同 key+fingerprint → 返既有(不 bump);同 key 不同 fingerprint → 422 `idempotency-key-reuse`;软删命中 → 真恢复(undelete+bump+restore tree)。
- **contentVersion bump**:子资源写入后 `jsonb_set(payload,'{contentVersion}',+1)`(原子,不动 metaRevision)。

## 7. 本地测试 PG(替代 docker)

任务要求"本地 docker PG 集成实跑"。worker 环境无 docker,改用 **brew postgresql@16**(PG 16.14,与服务器同版本)起本地 PG 实例(port 55443,独立 data dir `/tmp/mivo-pg-test-data`,trust 认证)作等价证据。集成测试用 `MIVO_PG_TEST=1` + `MIVO_PG_PORT=55443` gate;CI 无 PG 时跳过(标记),内存契约套件仍必跑。

## 8. swap 不改路由/契约

PersistBackend 接口不变(仅 additive `ready` + `__reset` 返回类型放宽 `void | Promise<void>`)。`server/app.ts` 注入点换 PgPersistBackend,路由 handler 零改动,错误码/wire shape 零变化。契约测试:内存套件(`server/persist/backend.test.ts`)保持绿(memory 专有故障注入留 memory-only);**双后端契约套件**(`backend.contract.dual.test.ts`)把纯契约场景参数化跑在 memory + PG(等价性核心证据);PG 原子性(`backend.pg.test.ts`)用事务回滚验证;route 级双后端 smoke(`persist.route.dual.test.ts`)用 `app.request` 全链路。

## 9. 遗留 / 下一 PR

- **PATCH 路由本体**:已由 #194 实装(canvas.ts upsertChild),本 PR 只 drop-in 支持,无遗留。
- **purge**(物理释放软删 + 全局 id 槽):FX-7 语义表已定,物理 purge + asset refcount 回收验收留后续(本 PR 只软删占位)。
- **多实例缓存失效**:T1.4+ 协作时处理(当前单实例灰度)。
- **生产实操建表**:lead 走 runbook(`docs/runbook/t1.1-pg-provisioning.md`)对生产 PG 跑 `runMigrations`(migrator 自带追踪表,可重放)。
