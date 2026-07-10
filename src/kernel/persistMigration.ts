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

/** dry-run 报告(各域 record 数 + 来源 version + readKey)。 */
export type DryRunReport = {
  ok: boolean
  sourceVersion: number
  readKey: string
  document: { canvasCount: number; projectCount: number; hasSceneId: boolean }
  session: { selectionCount: number; hasToolPrefs: boolean }
  asset: { ready: false; note: 'T1.5' }
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

// ─── dry-run(读 + project + 报告;零 setItem)─────────────────────────────────
// storage 只用 getItem(读);setItem 不调用——lead 硬要求"dry-run 不写",显式测试断言 setItem 调用 0。
// readKey:FX-6 合入前用占位 'mivo-canvas-demo'(pre-FX-6 客户端的旧 key);FX-6 后改 ${BASE}:${userId}。
type ReadStorage = Pick<import('zustand/middleware').StateStorage, 'getItem' | 'setItem'>

export const dryRunMigration = async (storage: ReadStorage, readKey: string): Promise<DryRunReport> => {
  const raw = await storage.getItem(readKey) // 唯一 storage 调用;无 setItem
  if (raw == null || (typeof raw === 'string' && raw.length === 0)) {
    return { ok: false, sourceVersion: 0, readKey, document: { canvasCount: 0, projectCount: 0, hasSceneId: false }, session: { selectionCount: 0, hasToolPrefs: false }, asset: { ready: false, note: 'T1.5' } }
  }
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
}

// ─── migrate / rollback(FX-6 合入后实现)───────────────────────────────────────
// 照 kernel-dualtrack-contract §4.3 checkpointed rollback 仪式:
// 1. 先快照 ckpt:raw read 单 blob(v10)→ 写 ${BASE}:${userId}:ckpt-v10(带 timestamp)。
// 2. 放行 v10→v11:写 ${BASE}:${userId}:document / :session key,bump version。
// 3. 失败/corrupt:从 ckpt-v10 恢复单 blob,删三域 key,回退 version。
// 4. 恢复(legacy→new up-migrate):v10 单 blob → v11 三域重算(ckpt 仅极端 forensic)。
//
// 硬约束(§4.5):v11 new-only 字段须可从 legacy 重建。S4 persist blob 只拆形状,不加 new-only
// 字段(revision 是 DocKernel 内存概念,不持久化进 blob)→ 满足可重建性。
// #164 表征 seed 适配:优先"让 migrate v10→v11 透明跑"(seed 保持 v10 单 blob,断言迁移后语义);
// 只有该路不通才改 seed 到 v11 形状 + PR 说明。

// TODO(FX-6): 实参形状待 FX-6 key 结构落地后定(storage + ${BASE}:${userId} + ckpt 仪式)。
export const migrateV10ToV11 = async (): Promise<void> => {
  throw new Error(
    'migrateV10ToV11: FX-6 合入后实现。key 结构 ${BASE}:${userId}:document/session(以含 FX-6 的 main 为准);ckpt ${BASE}:${userId}:ckpt-v10;仪式照 kernel-dualtrack-contract §4.3。',
  )
}

// TODO(FX-6): 从 ckpt-v10 恢复单 blob(rollback 仪式第 3 步)。
export const rollbackFromV11 = async (): Promise<void> => {
  throw new Error('rollbackFromV11: FX-6 合入后实现(从 ${BASE}:${userId}:ckpt-v10 恢复单 blob,删三域 key)。')
}
