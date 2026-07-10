// src/kernel/persistMigration.ts
// T1.2 S4 预研起草:persist v10→v11 拆三域迁移。
// 权威:docs/decisions/record-schema.md(三域 scope)+ docs/decisions/kernel-dualtrack-contract.md(§4.3 checkpointed rollback)。
//
// FX-6 合入前已可实现(key-independent):
// - projectToThreeDomain(纯函数:拆 v10 单 blob → document/session/asset 形状)。
// - dryRunMigration(读 storage.getItem,project,返回报告;**零 setItem**——lead 硬要求,有显式测试兜底)。
// FX-6 合入后填(key 结构):
// - migrateV10ToV11(写 ${BASE}:${userId}:document/session + ckpt-v10 快照,照 §4.3 仪式)。
// - rollbackFromV11(从 ckpt-v10 恢复单 blob)。
// 裁决:version v11 bump;chat persist 不动(留 T1.3);asset 域占位(随 T1.5);ckpt key=${BASE}:${userId}:ckpt-v10。

// ─── 类型(基于 canvasPersistConfig partialize 的 v10 单 blob 形状)──────────────
export type PersistedV10Blob = {
  canvases?: Record<string, unknown> // canvasId → CanvasDocument(legacy shape)
  projects?: Array<{ id: string; name: string; createdAt: string }>
  sceneId?: string
  selectedNodeId?: string
  selectedNodeIds?: string[]
  activeTool?: string
  brushStyle?: unknown
  activeStampKind?: string
}

// zustand persist 存储格式:{ state: <partialized>, version: <persist version> }
type PersistedEnvelope = { state?: PersistedV10Blob; version?: number }

/** 三域拆分形状(document/session;asset 占位随 T1.5)。 */
export type ThreeDomainProjection = {
  document: { canvases: Record<string, unknown>; projects: Array<{ id: string; name: string; createdAt: string }>; sceneId?: string }
  session: { selectedNodeId?: string; selectedNodeIds?: string[]; activeTool?: string; brushStyle?: unknown; activeStampKind?: string }
  asset: { ready: false; note: 'T1.5' }
}

/** dry-run 报告(各域 record 数 + 来源 version + readKey;error 仅 corrupt blob 诊断)。 */
export type DryRunReport = {
  ok: boolean
  sourceVersion: number
  readKey: string
  document: { canvasCount: number; projectCount: number; hasSceneId: boolean }
  session: { selectionCount: number; hasToolPrefs: boolean }
  asset: { ready: false; note: 'T1.5' }
  error?: string // 义务 2:corrupt blob 诊断(dry-run 不炸,返回 ok:false + error)
}

// ─── 纯函数:project v10 单 blob → 三域形状 ─────────────────────────────────
export const projectToThreeDomain = (blob: PersistedV10Blob): ThreeDomainProjection => ({
  document: {
    canvases: blob.canvases ?? {},
    projects: blob.projects ?? [],
    sceneId: blob.sceneId,
  },
  session: {
    selectedNodeId: blob.selectedNodeId,
    selectedNodeIds: blob.selectedNodeIds,
    activeTool: blob.activeTool,
    brushStyle: blob.brushStyle,
    activeStampKind: blob.activeStampKind,
  },
  asset: { ready: false, note: 'T1.5' },
})

// ─── raw storage brand(Greptile 义务 1:防 double-namespacing)─────────────────
// migrateV10ToV11/dryRun/rollback 的 storage 参数必须传 raw IDB storage(未命名空间化)。
// 函数内部走 namespacedKey(拼 ${BASE}:${userId});传 FX-6 namespaced adapter 会 double-namespace
// (读空/写错位)。brand 在类型层拦住 namespaced adapter 误传——FX-6 adapter 不带 __rawIdbStorage
// brand,赋值给 RawStorage 时 TS 拒绝。调用方需显式 cast raw IDB storage as RawStorage(意图明确)。
declare const __rawIdbStorage: unique symbol
export type RawStorage = Pick<import('zustand/middleware').StateStorage, 'getItem' | 'setItem' | 'removeItem'> & {
  readonly [__rawIdbStorage]: true
}

// ─── dry-run(读 + project + 报告;零 setItem)─────────────────────────────────
// storage 只用 getItem(读);setItem 不调用——lead 硬要求"dry-run 不写",显式测试断言 setItem 调用 0。
// readKey:FX-6 合入前用占位 'mivo-canvas-demo'(pre-FX-6 客户端的旧 key);FX-6 后改 ${BASE}:${userId}。
// 义务 2:corrupt JSON 不抛(dry-run 职责是诊断坏状态,返回 ok:false failed 报告,不该炸)。
export const dryRunMigration = async (storage: RawStorage, readKey: string): Promise<DryRunReport> => {
  const raw = await storage.getItem(readKey) // 唯一 storage 调用;无 setItem
  if (raw == null || (typeof raw === 'string' && raw.length === 0)) {
    return { ok: false, sourceVersion: 0, readKey, document: { canvasCount: 0, projectCount: 0, hasSceneId: false }, session: { selectionCount: 0, hasToolPrefs: false }, asset: { ready: false, note: 'T1.5' } }
  }
  // 义务 2:corrupt JSON → ok:false failed 报告(dry-run 诊断坏状态,不炸)
  try {
    const parsed = JSON.parse(raw as string) as PersistedEnvelope
    const blob = parsed.state ?? (parsed as unknown as PersistedV10Blob) // 兼容 wrapped{state} 与裸 blob
    const proj = projectToThreeDomain(blob)
    const selectionCount = proj.session.selectedNodeIds?.length ?? (proj.session.selectedNodeId ? 1 : 0)
    return {
      ok: true,
      sourceVersion: parsed.version ?? 10,
      readKey,
      document: {
        canvasCount: Object.keys(proj.document.canvases).length,
        projectCount: proj.document.projects.length,
        hasSceneId: proj.document.sceneId != null,
      },
      session: {
        selectionCount,
        hasToolPrefs: proj.session.activeTool != null || proj.session.activeStampKind != null,
      },
      asset: { ready: false, note: 'T1.5' },
    }
  } catch (error) {
    return {
      ok: false,
      sourceVersion: 0,
      readKey,
      error: `corrupt blob: ${error instanceof Error ? error.message : String(error)}`,
      document: { canvasCount: 0, projectCount: 0, hasSceneId: false },
      session: { selectionCount: 0, hasToolPrefs: false },
      asset: { ready: false, note: 'T1.5' },
    }
  }
}

// ─── migrate / rollback(实装,照 kernel-dualtrack-contract §4.3 checkpointed rollback 仪式)──
// key 拼法(lead 裁决 + FX-6 namespacedKey):baseKey=namespacedKey(baseName)(anon→raw name,
// auth→${baseName}:${userId});document/session/ckpt 后缀接在 baseKey 上。
// 仪式:1. 读 v10 单 blob;2. 快照 ckpt-v10(BEFORE 写 domain key);3. 拆写 document/session;
// 4. 失败→rollbackFromV11(从 ckpt 恢复 + 删 domain key)。
// 硬约束(§4.5):S4 只拆形状不加 new-only 字段(revision 是 DocKernel 内存概念,不入 blob)→ 可重建。
// #164 表征 seed 适配:优先"migrate v10→v11 透明跑"(seed 保持 v10 单 blob,断言迁移后语义)。
import { namespacedKey } from '../lib/persistUserId'

// migrate/rollback 复用 RawStorage brand(义务 1:防 double-namespacing,见上 RawStorage 注释)。

export type MigrationResult = {
  ok: boolean
  baseKey: string
  ckptKey: string
  documentKey: string
  sessionKey: string
  skipped?: boolean // true = no v10 blob (fresh / already migrated)
  error?: string
}

/**
 * migrateV10ToV11:v10 单 blob → v11 document+session 两域(ckpt 仪式照 §4.3)。
 * 读 baseKey(namespacedKey)的 v10 单 blob → 快照 ckpt-v10 → 拆写 document/session key。
 * 失败自动 rollback(从 ckpt 恢复 + 删 domain key)。不删 v10 单 blob(rollback 兜底;S5/S6 稳态后清)。
 */
export const migrateV10ToV11 = async (
  storage: RawStorage,
  baseName = 'mivo-canvas-demo',
): Promise<MigrationResult> => {
  const baseKey = namespacedKey(baseName)
  const ckptKey = `${baseKey}:ckpt-v10`
  const documentKey = `${baseKey}:document`
  const sessionKey = `${baseKey}:session`

  // 0. 幂等(Lead ① S6b-2):document key 已存在 → 已迁移,跳过(防重复迁移覆盖)。
  //    S6 wiring 每次启动调 migrateV10ToV11;document 已存在意味着上次迁移已落盘,不重写。
  const existingDoc = await storage.getItem(documentKey)
  if (existingDoc != null) {
    return { ok: true, baseKey, ckptKey, documentKey, sessionKey, skipped: true }
  }
  // 1. 读 v10 单 blob。
  const raw = await storage.getItem(baseKey)
  if (raw == null || (typeof raw === 'string' && (raw as string).length === 0)) {
    return { ok: true, baseKey, ckptKey, documentKey, sessionKey, skipped: true }
  }
  const rawStr = raw as string
  const parsed = JSON.parse(rawStr) as { state?: PersistedV10Blob; version?: number }
  const blob = parsed.state ?? (parsed as unknown as PersistedV10Blob)

  // 2. 快照 ckpt-v10(BEFORE 写 domain key——§4.3 仪式)。
  await storage.setItem(ckptKey, rawStr)

  // 3. 拆写 document/session(v11 envelope {state, version:11})。
  try {
    const { document, session } = projectToThreeDomain(blob)
    await storage.setItem(documentKey, JSON.stringify({ state: document, version: 11 }))
    await storage.setItem(sessionKey, JSON.stringify({ state: session, version: 11 }))
    return { ok: true, baseKey, ckptKey, documentKey, sessionKey }
  } catch (error) {
    // 4. 失败:rollback(从 ckpt 恢复 + 删 domain key)。
    await rollbackFromV11(storage, baseName)
    return {
      ok: false, baseKey, ckptKey, documentKey, sessionKey,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * rollbackFromV11:从 ckpt-v10 恢复 v10 单 blob + 删 document/session key(§4.3 第 3 步)。
 * ckpt 保留(极端 forensic;稳态后 S5/S6 清)。
 */
export const rollbackFromV11 = async (
  storage: RawStorage,
  baseName = 'mivo-canvas-demo',
): Promise<void> => {
  const baseKey = namespacedKey(baseName)
  const ckptKey = `${baseKey}:ckpt-v10`
  const documentKey = `${baseKey}:document`
  const sessionKey = `${baseKey}:session`

  // 恢复 v10 单 blob 从 ckpt。
  const ckptRaw = await storage.getItem(ckptKey)
  if (ckptRaw != null) {
    await storage.setItem(baseKey, ckptRaw as string)
  }
  // 删 domain key(清失败的 split)。
  await storage.removeItem(documentKey)
  await storage.removeItem(sessionKey)
  // ckpt 保留(forensic)。
}
