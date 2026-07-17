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

const getAllRecords = async (): Promise<TombstoneRecord[]> => {
  if (!isIdbAvailable()) return Array.from(memStore.values())
  try {
    const idbRecords = await runTx<TombstoneRecord[]>('readonly', (store) =>
      store.getAll() as IDBRequest<TombstoneRecord[]>,
    )
    // 并 memStore 兜底记录(同 writeRetryQueue getAllWrites:IDB tx 失败回落 memStore 的记录防丢)。
    const idbKeys = new Set(idbRecords.map((r) => r.key))
    const memOnly = Array.from(memStore.values()).filter((r) => !idbKeys.has(r.key))
    return [...idbRecords, ...memOnly]
  } catch (error) {
    warnIdbDegradation('getAll failed', error)
    return Array.from(memStore.values())
  }
}

const putRecord = async (record: TombstoneRecord): Promise<boolean> => {
  // 已存在则不覆盖 createdAt(保持首次删除时间;重复删同 id 幂等)。先 get 判存,再 put。
  if (!isIdbAvailable()) {
    if (memStore.has(record.key)) return false
    memStore.set(record.key, record)
    return true
  }
  try {
    let written = false
    await runVoidTx('readwrite', (store) => {
      const getReq = store.get(record.key) as IDBRequest<TombstoneRecord | undefined>
      getReq.onsuccess = () => {
        if (getReq.result === undefined) {
          store.put(record)
          written = true
        }
      }
    })
    if (written) memStore.delete(record.key)
    return written
  } catch (error) {
    warnIdbDegradation(`put failed for ${record.key}`, error)
    if (memStore.has(record.key)) return false
    memStore.set(record.key, record)
    return true
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
  const written = await putRecord(record)
  if (written) {
    debugLogger.log(
      SOURCE,
      `tombstone recorded for ${kind} ${resourceId} (owner=${ownerId}; anti-resurrection D${opts?.parentProjectId !== undefined ? `; cascade under project ${opts.parentProjectId}` : ''})`,
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
