// src/kernel/docKernelPersistAdapter.ts
// T1.2 S6b:DocKernel-backed persist storage adapter(?kernel=new 时 canvasStore persist
// 读写 document+session 三域 canonical,Lead 裁决 ① persist backend,setters 不动)。
// 权威:docs/decisions/kernel-dualtrack-contract.md §4.2(C 阶段 new 写 canonical via raw read + projection)。
//
// getItem:读 document+session 两 key(via rawIdbStorage raw + namespacedKey 拼 documentKey/sessionKey)
//   → merge single envelope(zustand persist 期望 {state, version})。session 缺失优雅回退(Lead ②:
//   首次迁移前/被清理后 session 域可能不存在,merge 用空 session,不阻塞 document rehydrate)。
// setItem:partialize(state) single blob → projectToThreeDomain 拆 document/session → 写两 key(version 11)。
// removeItem:删 document/session。
//
// rawIdbStorage 是 raw(不经 namespacedKey,Lead ③ cast as RawStorage 集中导出);adapter 内部
// 用 namespacedKey(name) 拼 documentKey/sessionKey(与 migrateV10ToV11 一致,防 double-namespace)。
// ?kernel=legacy 时 canvasPersistConfig 仍用 idbStateStorage(single blob),legacy 零变化(§8)。

import { rawIdbStorage } from '../lib/persistIdbStorage'
import { namespacedKey } from '../lib/persistUserId'
import { projectToThreeDomain, type PersistedV10Blob } from './persistMigration'

const documentKey = (name: string): string => `${namespacedKey(name)}:document`
const sessionKey = (name: string): string => `${namespacedKey(name)}:session`

const V11 = 11

type Envelope = { state: unknown; version: number }

/**
 * docKernelPersistStorage:?kernel=new 时 canvasStore persist 的 storage backend。
 * canonical = document+session 两 key(v11 三域,DocKernel canonical);legacy single blob 不用此。
 * setters 不动(写 zustand state → persist setItem → 拆 document/session 写)。
 */
export const docKernelPersistStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const docRaw = await rawIdbStorage.getItem(documentKey(name))
    if (docRaw == null) return null // 无 document key → 未迁移/首次(canonical 不存在,rehydrate 回退默认)
    // document corrupt → 视为无 canonical(不抛,rehydrate 回退)
    let docState: Record<string, unknown>
    try {
      docState = (JSON.parse(docRaw) as Envelope).state as Record<string, unknown>
    } catch {
      return null
    }
    // session 域缺失优雅回退(Lead ②):首次迁移前/被清理后 session 可能不存在 → 空 session
    const sessRaw = await rawIdbStorage.getItem(sessionKey(name))
    let sessState: Record<string, unknown> = {}
    if (sessRaw != null) {
      try {
        sessState = (JSON.parse(sessRaw) as Envelope).state as Record<string, unknown>
      } catch {
        sessState = {} // corrupt session → 空(不阻塞 document rehydrate)
      }
    }
    // merge:document(canvases/projects/sceneId)+ session(顶层 selection/tools)→ single envelope
    // session 顶层 selection 覆盖 document 顶层(但 document.canvases 内嵌 selection 不被覆盖)
    const merged = { ...docState, ...sessState }
    return JSON.stringify({ state: merged, version: V11 })
  },

  setItem: async (name: string, value: string): Promise<void> => {
    // value = partialize(state) single blob envelope {state, version}
    let blob: PersistedV10Blob
    try {
      blob = (JSON.parse(value) as Envelope).state as PersistedV10Blob
    } catch {
      return // corrupt value → 不写(不破坏 canonical)
    }
    const { document, session } = projectToThreeDomain(blob)
    await rawIdbStorage.setItem(documentKey(name), JSON.stringify({ state: document, version: V11 }))
    await rawIdbStorage.setItem(sessionKey(name), JSON.stringify({ state: session, version: V11 }))
  },

  removeItem: async (name: string): Promise<void> => {
    await rawIdbStorage.removeItem(documentKey(name))
    await rawIdbStorage.removeItem(sessionKey(name))
  },
}
