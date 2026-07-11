// serverPersistAdapterSelector — G1-a 三态 adapter 选择(local/shadow/server,v4 §1)。
//
// 默认 mode=local → 返 unwiredServerPersistAdapter(全 reject,生产零变化);
// ?persist=server|shadow → 返 createFetchServerPersistAdapter(非画布域真 fetch)。
// 选择基于 persistMode(同 kernelMode ?kernel= 惯例),server/shadow 共用同一 wired adapter
// (差异在 hydrate/写语义调用方,不在 adapter 本身)。
//
// 本文件单独成文(不在 serverPersistAdapter.ts 内)的理由:serverPersistAdapter.ts 被
// serverPersistAdapter.contract.test.ts import(纯类型互锁 + unwired fail-visibly)。把
// persistMode/authHeaders import 放这里,contract test 路径就不拉 persistMode(debugLogStore)
// 与 authHeaders(settingsSlice)——保持 serverPersistAdapter.ts 可被纯 type test 无副作用 import。

import { isLocalPersist, persistMode } from './persistMode'
import { createFetchServerPersistAdapter, unwiredServerPersistAdapter, type ServerPersistAdapter } from './serverPersistAdapter'

let wiredAdapter: ServerPersistAdapter | undefined

/**
 * 生产 adapter 出口:store 初始化 / hydrate / writeRetryQueue executor 单点读取。
 * - local(默认):unwired,所有方法 reject(生产零变化,表征测试不红)。
 * - shadow/server:wired,非画布域(project/canvas-meta/user-state/asset)真 fetch;画布域写
 *   与 chat 仍 reject(G1-c / DP-6R seam)。
 *
 * authHeaders 走 lazy dynamic import —— 仅在 server/shadow 模式被选中时才拉 settingsSlice,
 * local 模式(生产默认)永不加载 settingsSlice 经此路径。返回单例(wiredAdapter 缓存)。
 */
export const getServerPersistAdapter = (): ServerPersistAdapter => {
  if (isLocalPersist) return unwiredServerPersistAdapter
  if (wiredAdapter) return wiredAdapter
  wiredAdapter = createFetchServerPersistAdapter({
    // lazy:避免把 authHeaders(settingsSlice)拉进本模块的每个 importer。
    getAuthHeaders: async () => (await import('./authHeaders')).authHeaders(),
  })
  return wiredAdapter
}

/** 测试用:重置 selector 缓存(逐 test隔离 wired adapter 单例;不重置 persistMode)。 */
export const __resetServerPersistAdapterSelector = (): void => {
  wiredAdapter = undefined
}

/** 透传 persistMode 便于调用方分支 hydrate/写语义(同 getKernelMode 出口)。 */
export { persistMode }
