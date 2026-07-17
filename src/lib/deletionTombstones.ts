// deletionTombstones — 持久删除墓碑集(Phase 1 复活加固)。
//
// 背景(计划 Phase 1 项4 / CR-3·CR-4):server 模式删项目/画布后,本地 store 已乐观移除,但 DELETE
// op 仍在 writeRetryQueue 未 drain → 服务端仍 LIVE → 下次 hydrate 把已删记录灌回本地 = "复活"。
// 既有反复活只靠 `getPendingDeleteResourceIds` 差集过滤,依赖"删除记录仍在队列"。一旦记录离队
// (① 重试耗尽 DEFAULT_MAX_ATTEMPTS=8 terminal;② 队列溢出驱逐 maxQueuePerUser=256 doEnqueue 驱逐
// 最老 pending),差集过滤失效 → 复活。
//
// 本模块引入**持久 tombstone 集**(IDB 持久,跨 boot),与队列记录生死**解耦**:
//  - 写入点 = store action 发起删除时(deleteProject/deleteCanvas),不是入队成功时 → 覆盖溢出驱逐路径
//    (即便 DELETE 记录被驱逐出队列,tombstone 仍在 → hydrate 继续过滤 → 不复活)。
//  - per-user 分区:key 带 ownerId(IDB 跨账号共享,同 writeRetryQueue 教训),避免跨 owner 误过滤。
//  - hydrate 过滤:persistBoot step1(project)/step2(canvas)在既有 pending-delete 差集过滤基础上,
//    再并上 tombstone 集过滤(server 列表 + local 分支都过);tombstone ∪ pending-delete。
//  - restore 撤销:删除→立即恢复(restoreProject / 同 id createCanvas)时撤销 tombstone,否则恢复的
//    资源被 hydrate 永久隐藏(比复活更糟)。
//  - 清除时机 = DELETE 终态 success(含 404-idempotent):服务端已软删 → 不再 LIVE → 无复活风险 → tombstone
//    完成使命可清。terminal 失败(rejected/dead-letter)→ 服务端仍 LIVE → tombstone 保留(继续挡复活)。
//
// IDB 层镜像 writeRetryQueue 的双轨模式(IDB 不可用 → memStore 兜底,跨 pm2-restart 窗口存活,不跨 reload);
// 独立 DB(mivo-deletion-tombstones)避免与 writeRetryQueue 的 DB_VERSION 升级耦合。tombstone 低频写,无溢出
// 驱逐需求(DELETE 终态 success 即清,不会无限增长)。失败 best-effort:debugLogger.warn,永不 throw(不阻断
// store action / hydrate / drain)。

import { getPersistUserId } from './persistUserId'
import { debugLogger } from '../store/debugLogStore'

const SOURCE = 'Deletion Tombstones'

export type TombstoneKind = 'project' | 'canvas'

const DB_NAME = 'mivo-deletion-tombstones'
const DB_VERSION = 1
const STORE_NAME = 'tombstones'

type TombstoneRecord = {
  key: string
  ownerId: string
  kind: TombstoneKind
  resourceId: string
  createdAt: number
  /**
   * F-B(决策7,Phase 2 归档):canvas 级联删 tombstone 的父项目标记。deleteProject 级联删其画布时写
   * parentProjectId=projectId;restoreProject 整树恢复时经 revokeCanvasTombstonesForProject(projectId) 撤销
   * 这些级联删 canvas tombstone(镜像 deleteProject 级联删)。直接 deleteCanvas 的 tombstone 无此字段 →
   * revoke-by-project 撞不到(直接删的画布不该被项目恢复重建,保留挡复活)。
   * schemaless value(IDB keyPath='key' 不变),加可选字段不触发 onupgradeneeded(决策7:无 DB_VERSION bump)。
   */
  parentProjectId?: string
  /** active-child 409 后权威回灌失败：下次 hydrate 必须先重试严格 project+canvas reconcile。 */
  rollbackPending?: true
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// IDB 不可用(隐私模式 / node 测试无 fake-indexeddb)→ memStore 兜底(同 writeRetryQueue;跨 pm2-restart
// 窗口存活,不跨 reload)。getAll 并 memStore 兜底记录防 IDB 恢复后丢(同 writeRetryQueue getAllWrites)。
let dbPromise: Promise<IDBDatabase> | undefined
const memStore = new Map<string, TombstoneRecord>()

const isIdbAvailable = (): boolean => typeof indexedDB !== 'undefined' && indexedDB !== null

// tombstone 写/过滤路径的 IDB 失败必须 fail-visible(debugLogger.warn),但不阻断业务(memStore 兜底)。
const warnIdbDegradation = (context: string, error: unknown): void => {
  debugLogger.warn(SOURCE, `${context}; using in-memory fallback: ${msg(error)}`)
}

const tombstoneKey = (kind: TombstoneKind, resourceId: string, ownerId: string = getPersistUserId()): string =>
  `${ownerId}:${kind}:${resourceId}`

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  if (!isIdbAvailable()) {
    return Promise.reject(new Error('IndexedDB unavailable'))
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  })
  dbPromise.catch(() => {
    dbPromise = undefined
  })
  return dbPromise
}

// 只读 getAll 用:run 返回单个 IDBRequest<T>,tx.oncomplete 后 resolve 其 result(同 writeRetryQueue runTx)。
const runTx = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const request = run(tx.objectStore(STORE_NAME))
        let result: T
        request.onsuccess = () => {
          result = request.result
        }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
      }),
  )

// 写入用(get→put/delete 链式 onsuccess):run 不返回 IDBRequest(同 writeRetryQueue runMultiStoreTx 的 void
// 模式),tx 在所有排队请求 settle 后 oncomplete resolve。run 内可链 get.onsuccess→put/delete。
const runVoidTx = (
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> =>
  openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        try {
          run(tx.objectStore(STORE_NAME))
        } catch (error) {
          // run 内同步抛(如畸形 key)→ abort + reject,已排队请求回滚。
          try {
            tx.abort()
          } catch {
            /* ignore — already aborting */
          }
          reject(error)
          return
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'))
      }),
  )

const mergeIdbAndMemoryRecords = (idbRecords: TombstoneRecord[]): TombstoneRecord[] => {
  // P2-2(二审降级 seam):IDB enrich tx 曾失败 → 带 parentProjectId 的记录落 memStore(catch 回落),IDB 仍存
  //   stale 无 parent 记录(同 key)。旧实现按 key 优先留 IDB + 过滤同 key mem(`!idbKeys.has(r.key)`)→
  //   enrichment 不可见(parentProjectId 丢 → revokeCanvasTombstonesForProject 撞不到 → 恢复的画布被永久隐藏,
  //   比复活更糟)。修:同 key merge——mem 的 parentProjectId(enriched)补进 IDB 记录(IDB 缺时);其余字段以
  //   IDB 为准(durable 权威,createdAt/kind/ownerId/resourceId)。mem-only 记录(key 不在 IDB,如全 mem 兜底)照常追加。
  //   merge 只在内存(读路径),不写回 IDB(读不改 durable;下次成功 putRecord enrich 自愈 IDB;IDB 持续故障时
  //   每次 read 重 merge,幂等)。
  const byKey = new Map<string, TombstoneRecord>()
  for (const r of idbRecords) byKey.set(r.key, r)
  for (const r of memStore.values()) {
    const idb = byKey.get(r.key)
    if (idb) {
      // 同 key merge:mem 的 parentProjectId(enriched 投影)补进 IDB 记录(IDB stale 缺时);IDB 已有则不覆盖。
      if (
        (r.parentProjectId !== undefined && idb.parentProjectId === undefined) ||
        (r.rollbackPending === true && idb.rollbackPending !== true)
      ) {
        byKey.set(r.key, {
          ...idb,
          ...(r.parentProjectId !== undefined && idb.parentProjectId === undefined ? { parentProjectId: r.parentProjectId } : {}),
          ...(r.rollbackPending === true ? { rollbackPending: true as const } : {}),
        })
      }
    } else {
      // mem-only(key 不在 IDB)→ 追加(IDB tx 失败回落的全 mem 记录)。
      byKey.set(r.key, r)
    }
  }
  return Array.from(byKey.values())
}

/** commit-token 消费路径用：IDB 读取失败必须上抛，不能把空 memStore 误判为“无 child tombstone”。 */
const getAllRecordsStrict = async (): Promise<TombstoneRecord[]> => {
  if (!isIdbAvailable()) return Array.from(memStore.values())
  const idbRecords = await runTx<TombstoneRecord[]>('readonly', (store) =>
    store.getAll() as IDBRequest<TombstoneRecord[]>,
  )
  return mergeIdbAndMemoryRecords(idbRecords)
}

const getAllRecords = async (): Promise<TombstoneRecord[]> => {
  try {
    return await getAllRecordsStrict()
  } catch (error) {
    warnIdbDegradation('getAll failed', error)
    return Array.from(memStore.values())
  }
}

const putRecord = async (record: TombstoneRecord): Promise<'new' | 'enriched' | 'existing'> => {
  // 已存在则不覆盖 createdAt(保持首次删除时间;重复删同 id 幂等)。
  // P1-4(forward-compat 返修):同 key 已存在但缺 parentProjectId → 原子 enrich 补 parentProjectId(不整条覆盖,
  //   保留 existing.createdAt/kind/ownerId/resourceId;#264 旧墓碑补 cascade provenance 供 revokeCanvasTombstonesForProject)。
  //   仅当新 record 携带 parentProjectId(cascade delete 场景)且 existing 缺它时才 enrich;其余 existing → no-op。
  if (!isIdbAvailable()) {
    const existing = memStore.get(record.key)
    if (existing) {
      if (
        (record.parentProjectId !== undefined && existing.parentProjectId === undefined) ||
        (record.rollbackPending === true && existing.rollbackPending !== true)
      ) {
        memStore.set(record.key, {
          ...existing,
          ...(record.parentProjectId !== undefined && existing.parentProjectId === undefined ? { parentProjectId: record.parentProjectId } : {}),
          ...(record.rollbackPending === true ? { rollbackPending: true as const } : {}),
        })
        return 'enriched'
      }
      return 'existing'
    }
    memStore.set(record.key, record)
    return 'new'
  }
  try {
    let written = false
    let enriched = false
    await runVoidTx('readwrite', (store) => {
      const getReq = store.get(record.key) as IDBRequest<TombstoneRecord | undefined>
      getReq.onsuccess = () => {
        const existing = getReq.result
        if (existing === undefined) {
          store.put(record)
          written = true
        } else if (
          (record.parentProjectId !== undefined && existing.parentProjectId === undefined) ||
          (record.rollbackPending === true && existing.rollbackPending !== true)
        ) {
          // enrich(原子:同 tx 内 get→put;不覆盖 createdAt/kind/ownerId/resourceId,只补 provenance/rollback marker)
          store.put({
            ...existing,
            ...(record.parentProjectId !== undefined && existing.parentProjectId === undefined ? { parentProjectId: record.parentProjectId } : {}),
            ...(record.rollbackPending === true ? { rollbackPending: true as const } : {}),
          })
          enriched = true
        }
        // else: existing(已 parentProjectId 或新 record 无 parentProjectId)→ no-op
      }
    })
    if (written) memStore.delete(record.key) // record durable,清 stale memStore 兜底
    return written ? 'new' : enriched ? 'enriched' : 'existing'
  } catch (error) {
    warnIdbDegradation(`put failed for ${record.key}`, error)
    const existing = memStore.get(record.key)
    if (existing) {
      if (
        (record.parentProjectId !== undefined && existing.parentProjectId === undefined) ||
        (record.rollbackPending === true && existing.rollbackPending !== true)
      ) {
        memStore.set(record.key, {
          ...existing,
          ...(record.parentProjectId !== undefined && existing.parentProjectId === undefined ? { parentProjectId: record.parentProjectId } : {}),
          ...(record.rollbackPending === true ? { rollbackPending: true as const } : {}),
        })
        return 'enriched'
      }
      return 'existing'
    }
    memStore.set(record.key, record)
    return 'new'
  }
}

const deleteRecord = async (key: string): Promise<boolean> => {
  // 返是否实际删除了一条(供调用方决定是否 log;bare delete 对缺失 key 幂等 no-op)。
  let existed = false
  if (memStore.has(key)) {
    existed = true
    memStore.delete(key)
  }
  if (!isIdbAvailable()) return existed
  try {
    await runVoidTx('readwrite', (store) => {
      const getReq = store.get(key) as IDBRequest<TombstoneRecord | undefined>
      getReq.onsuccess = () => {
        if (getReq.result !== undefined) {
          store.delete(key)
          existed = true
        }
      }
    })
  } catch (error) {
    // delete 失败不阻断(memStore 已清),warn 留痕。
    debugLogger.warn(SOURCE, `delete failed for ${key}: ${msg(error)}`)
  }
  return existed
}

/**
 * durable commit-token 消费路径用的严格删除：IDB transaction 失败必须传播给调用方，且只有
 * transaction commit 后才清 mem fallback。普通 restore/DELETE-success 仍使用上面的 best-effort API。
 */
const deleteRecordStrict = async (key: string): Promise<boolean> => {
  let existed = memStore.has(key)
  if (!isIdbAvailable()) {
    memStore.delete(key)
    return existed
  }
  await runVoidTx('readwrite', (store) => {
    const getReq = store.get(key) as IDBRequest<TombstoneRecord | undefined>
    getReq.onsuccess = () => {
      if (getReq.result !== undefined) {
        store.delete(key)
        existed = true
      }
    }
  })
  memStore.delete(key)
  return existed
}

/**
 * 写入点:store action 发起删除时调用(deleteProject/deleteCanvas)。与队列记录生死解耦——
 * 即便 DELETE op 后续被重试耗尽 / 溢出驱逐离队,tombstone 仍在 → hydrate 继续过滤 → 不复活。
 * 幂等:重复删同 id 不覆盖(保持首次删除时间),返是否新写。失败 best-effort(memStore 兜底),
 * 永不 throw(不阻断 store action)。server 模式才写(local 模式 hydrate 永不跑,写也无意义;
 * 调用方已 gate 在 isPersistWriteActive)。
 *
 * F-B(决策7):opts.parentProjectId 标记级联删 canvas tombstone 的父项目。deleteProject 级联删其画布时传
 * parentProjectId=projectId;restoreProject 经 revokeCanvasTombstonesForProject(projectId) 撤销这些级联 tombstone。
 * 直接 deleteCanvas 不传(无父项目级联语义)→ revoke-by-project 撞不到,保留挡复活。
 */
export const recordDeletionTombstone = async (
  kind: TombstoneKind,
  resourceId: string,
  opts?: { parentProjectId?: string },
): Promise<void> => {
  const ownerId = getPersistUserId()
  const record: TombstoneRecord = {
    key: tombstoneKey(kind, resourceId, ownerId),
    ownerId,
    kind,
    resourceId,
    createdAt: Date.now(),
    ...(opts?.parentProjectId !== undefined ? { parentProjectId: opts.parentProjectId } : {}),
  }
  const result = await putRecord(record)
  if (result === 'new') {
    debugLogger.log(
      SOURCE,
      `tombstone recorded for ${kind} ${resourceId} (owner=${ownerId}; anti-resurrection D${opts?.parentProjectId !== undefined ? `; cascade under project ${opts.parentProjectId}` : ''})`,
    )
  } else if (result === 'enriched') {
    debugLogger.log(
      SOURCE,
      `tombstone enriched (parentProjectId=${opts?.parentProjectId} added to legacy record) for ${kind} ${resourceId} (owner=${ownerId}; P1-4 forward-compat)`,
    )
  }
}

/**
 * restore 撤销:删除→立即恢复(restoreProject / 同 id createCanvas)时撤销 tombstone,否则恢复的资源
 * 被 hydrate 永久隐藏(比复活更糟)。幂等:无 tombstone → no-op silent(不 log,避免每次 create enqueue
 * 刷屏——大多数 create 是全新 id,无 tombstone)。返是否实际撤销(命中才 log)。
 */
export const revokeDeletionTombstone = async (kind: TombstoneKind, resourceId: string): Promise<void> => {
  const key = tombstoneKey(kind, resourceId)
  const removed = await deleteRecord(key)
  if (removed) {
    debugLogger.log(SOURCE, `tombstone revoked for ${kind} ${resourceId} (restore / re-create; un-hide D)`)
  }
}

/**
 * F-B(决策7,Phase 2 restoreProject 接线):撤销某 project 下所有级联删 canvas tombstone(按 parentProjectId 过滤)。
 * 镜像 deleteProject 级联写 canvas tombstone(带 parentProjectId)——restoreProject 整树恢复时,子画布 tombstone
 * 也须撤销,否则恢复的画布被 hydrate step2 永久隐藏(比复活更糟;子画布 deleteCanvas op 若被溢出驱逐/重试耗尽
 * 离队,pending-delete 失效,tombstone 接力挡复活 → 永久隐藏恢复的画布)。
 *
 * getAllRecords + JS 过滤(低频小集合,决策7:不建 IDB 索引、无 DB_VERSION bump)。ownerId 过滤(同
 * getDeletionTombstones;IDB 跨账号共享)。**缺 parentProjectId 的旧 tombstone**(Phase 1→2 部署窗口期写入的
 * 直接删 canvas tombstone,无此字段)保守不动(不撤销 → 仍挡复活 → 依赖 Phase 2 回收站恢复入口兜底;文档注明
 * 此极窄边缘)。幂等:无命中 → no-op silent(不 log,防刷屏)。返撤销数(命中才 log)。失败 best-effort,永不 throw。
 */
export const revokeCanvasTombstonesForProject = async (projectId: string): Promise<void> => {
  const ownerId = getPersistUserId()
  const all = await getAllRecords()
  const targets = all.filter(
    (r) => r.ownerId === ownerId && r.kind === 'canvas' && r.parentProjectId === projectId,
  )
  if (targets.length === 0) return
  let revoked = 0
  for (const t of targets) {
    const removed = await deleteRecord(t.key)
    if (removed) revoked++
  }
  if (revoked > 0) {
    debugLogger.log(
      SOURCE,
      `revoked ${revoked} cascade-deleted canvas tombstone(s) under project ${projectId} (restoreProject tree; owner=${ownerId}; un-hide D)`,
    )
  }
}

/**
 * active-child rollback commit 专用严格版：读取或任一 child 删除失败即 reject。调用方必须先调本函数，
 * 全部成功后才清 project rollback marker（project tombstone 是最后的 durable commit token）。
 */
export const revokeCanvasTombstonesForProjectStrict = async (projectId: string): Promise<void> => {
  const ownerId = getPersistUserId()
  const all = await getAllRecordsStrict()
  const targets = all.filter(
    (r) => r.ownerId === ownerId && r.kind === 'canvas' && r.parentProjectId === projectId,
  )
  if (targets.length === 0) return
  let revoked = 0
  for (const target of targets) {
    const removed = await deleteRecordStrict(target.key)
    if (removed) revoked++
  }
  if (revoked > 0) {
    debugLogger.log(
      SOURCE,
      `strictly revoked ${revoked} cascade-deleted canvas tombstone(s) under project ${projectId} before project commit token`,
    )
  }
}

/**
 * active-child 409 恢复辅助:在撤销 cascade tombstone 前取得同一批 child id,供 write queue
 * 取消 deleteProject 乐观级联产生、但尚未发送的 deleteCanvas。只读、per-user、仅命中带 provenance 的记录。
 */
export const getCanvasTombstoneIdsForProject = async (projectId: string): Promise<string[]> => {
  const ownerId = getPersistUserId()
  const all = await getAllRecords()
  return all
    .filter((r) => r.ownerId === ownerId && r.kind === 'canvas' && r.parentProjectId === projectId)
    .map((r) => r.resourceId)
}

/** active-child 权威回灌失败后给 project tombstone 加 durable rollback marker。 */
export const markProjectDeletionRollbackPending = async (projectId: string): Promise<void> => {
  const ownerId = getPersistUserId()
  await putRecord({
    key: tombstoneKey('project', projectId, ownerId),
    ownerId,
    kind: 'project',
    resourceId: projectId,
    createdAt: Date.now(),
    rollbackPending: true,
  })
  debugLogger.warn(SOURCE, `project ${projectId} marked rollbackPending after active-child reconcile failure`)
}

/** hydrate 启动时读取需要严格重试权威回灌的 project id。 */
export const getPendingProjectDeletionRollbackIds = async (): Promise<string[]> => {
  const ownerId = getPersistUserId()
  const all = await getAllRecords()
  return all
    .filter((record) => record.ownerId === ownerId && record.kind === 'project' && record.rollbackPending === true)
    .map((record) => record.resourceId)
}

/**
 * 清除时机:DELETE 终态 success(含 404-idempotent)时调用(persistBoot onOutcome deleteProject/deleteCanvas
 * success 分支)。服务端已软删 → 不再 LIVE → 无复活风险 → tombstone 完成使命可清。返是否实际清除(命中才 log)。
 * terminal 失败路径不调(服务端仍 LIVE → tombstone 保留继续挡复活)。
 */
export const clearDeletionTombstone = async (kind: TombstoneKind, resourceId: string): Promise<void> => {
  const key = tombstoneKey(kind, resourceId)
  const removed = await deleteRecord(key)
  if (removed) {
    debugLogger.log(SOURCE, `tombstone cleared for ${kind} ${resourceId} (DELETE terminal success; server soft-deleted → no resurrection risk)`)
  }
}

/** active-child rollback commit 专用严格清除：project marker 删除失败必须传播，留待下轮重试。 */
export const clearDeletionTombstoneStrict = async (kind: TombstoneKind, resourceId: string): Promise<void> => {
  const key = tombstoneKey(kind, resourceId)
  const removed = await deleteRecordStrict(key)
  if (removed) {
    debugLogger.log(SOURCE, `tombstone cleared for ${kind} ${resourceId} (strict durable commit token consumed)`)
  }
}

/**
 * hydrate 过滤读取:返当前 ownerId 下指定 kind 的 tombstone resourceId 集。persistBoot step1(project)/
 * step2(canvas)在既有 pending-delete 差集过滤基础上并此集过滤(server 列表 + local 分支都过)。
 * per-user 过滤(同 getPendingDeleteResourceIds;IDB 跨账号共享,不过滤则 userA 的 tombstone 污染 userB hydrate)。
 * 命中数 > 0 时 log(可观测过滤命中)。local 模式 hydrate 永不跑(永不调此)。
 */
export const getDeletionTombstones = async (kind: TombstoneKind): Promise<Set<string>> => {
  const ownerId = getPersistUserId()
  const all = await getAllRecords()
  const ids = new Set<string>()
  for (const r of all) {
    if (r.ownerId === ownerId && r.kind === kind) ids.add(r.resourceId)
  }
  if (ids.size > 0) {
    debugLogger.log(SOURCE, `hydrate filter: ${ids.size} ${kind} tombstone(s) active for owner=${ownerId} (anti-resurrection D, union with pending-delete)`)
  }
  return ids
}

/** 测试/HMR 清理:清 memStore + IDB store + drop 缓存连接(逐 test 隔离,防跨 test tombstone 泄漏)。 */
export const __resetDeletionTombstonesDb = async (): Promise<void> => {
  memStore.clear()
  dbPromise = undefined
  if (!isIdbAvailable()) return
  try {
    await runVoidTx('readwrite', (store) => {
      void store.clear()
    })
  } catch (error) {
    // clear 失败不影响 test(下次 openDb 重开);不 warn(测试内部,非数据路径)。
    debugLogger.warn(SOURCE, `clear failed: ${msg(error)}`)
    dbPromise = undefined
  }
}

/**
 * P2-2 测试专用:直接置 memStore(模拟 IDB enrich tx 失败 → catch 回落 memStore 的记录),不触 IDB。
 * 用于构造"IDB 存 stale 无 parent 记录 + memStore 存 enriched 带 parent 同 key 记录"降级态,
 * 验 getAllRecords 同 key merge 把 mem 的 parentProjectId 补进 IDB(enrichment 可见,防 revokeCanvasTombstonesForProject 撞不到)。
 */
export const __seedTombstoneMemForTest = async (
  kind: TombstoneKind,
  resourceId: string,
  opts?: { parentProjectId?: string },
): Promise<void> => {
  const ownerId = getPersistUserId()
  const key = tombstoneKey(kind, resourceId, ownerId)
  memStore.set(key, {
    key,
    ownerId,
    kind,
    resourceId,
    createdAt: Date.now(),
    ...(opts?.parentProjectId !== undefined ? { parentProjectId: opts.parentProjectId } : {}),
  })
}
