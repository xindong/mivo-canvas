import type { CanvasActionRuntime } from './canvasActionTypes'
import type { CanvasState } from '../../store/canvasStore'
import type { CanvasDocument } from '../../types/mivoCanvas'
import type { AnchorRecord, EdgeRecord, NodeRecord } from '../../kernel/records'
import type {
  CanvasChange,
  CanvasSyncPort,
  FieldIntent,
  FieldPath,
  FieldPathTarget,
} from '../../lib/canvasSyncPort'
import { FieldIntentError, validateFieldIntent } from '../../lib/canvasSyncPort'
import { abortPendingCanvasSyncCreate, getCanvasSyncPort } from '../../lib/canvasSyncPortClient'
import { isLocalPersist } from '../../lib/persistMode'
import { enqueueAssetAttach, enqueueAssetDetach, serverAssetIdFromUrl } from '../../lib/assetAttachWiring'
import { debugLogger } from '../../store/debugLogStore'
import { useCanvasStore } from '../../store/canvasStore'
import { documentFor } from '../../store/canvasDocumentModel'
import { anchorsToRecords, edgeToRecord, toRecord } from '../../kernel/mapping'

const SOURCE = 'Canvas Sync Runtime'

type SyncSnapshot = {
  canvasId: string
  nodes: Map<string, NodeRecord>
  edges: Map<string, EdgeRecord>
  anchors: Map<string, AnchorRecord>
  nodeOrder: string[]
  edgeOrder: string[]
  anchorOrder: string[]
}

const cloneValue = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readValueAtPath = (record: Record<string, unknown>, fieldPath: FieldPath): unknown => {
  let current: unknown = record
  for (const segment of fieldPath) {
    if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment]
      continue
    }
    if (!isPlainObject(current) || typeof segment !== 'string') return undefined
    current = current[segment]
  }
  return current
}

const classifyFieldPathTarget = (
  beforeRecord: Record<string, unknown>,
  afterRecord: Record<string, unknown>,
  fieldPath: FieldPath,
): FieldPathTarget => {
  const last = fieldPath[fieldPath.length - 1]
  if (typeof last === 'number') return 'array-element'
  const nextValue = readValueAtPath(afterRecord, fieldPath)
  if (Array.isArray(nextValue) || isPlainObject(nextValue)) return 'container'
  const prevValue = readValueAtPath(beforeRecord, fieldPath)
  if (Array.isArray(prevValue) || isPlainObject(prevValue)) return 'container'
  return 'leaf'
}

const valuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      if (!valuesEqual(left[i], right[i])) return false
    }
    return true
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      if (!valuesEqual(left[key], right[key])) return false
    }
    return true
  }
  return false
}

const pushSet = (
  intents: FieldIntent[],
  fieldPath: readonly [string | number, ...(string | number)[]],
  value: unknown,
): void => {
  intents.push({ op: 'set', fieldPath, value: cloneValue(value) })
}

const diffValue = (
  before: unknown,
  after: unknown,
  fieldPath: readonly [string | number, ...(string | number)[]],
  intents: FieldIntent[],
): void => {
  if (valuesEqual(before, after)) return
  if (after === undefined) {
    intents.push({ op: 'delete-field', fieldPath })
    return
  }
  if (before === undefined) {
    if (isPlainObject(after)) {
      for (const [key, value] of Object.entries(after)) {
        diffValue(undefined, value, [...fieldPath, key], intents)
      }
      return
    }
    pushSet(intents, fieldPath, after)
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      pushSet(intents, fieldPath, after)
      return
    }
    for (let i = 0; i < after.length; i += 1) {
      diffValue(before[i], after[i], [...fieldPath, i], intents)
    }
    return
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      diffValue(before[key], after[key], [...fieldPath, key], intents)
    }
    return
  }
  pushSet(intents, fieldPath, after)
}

const stripEmbeddedAnchors = (record: NodeRecord): NodeRecord => {
  const next = { ...record }
  delete next.experimentalAnchors
  return next
}

const recordsFromDocument = (document: CanvasDocument) => {
  const nodes = document.nodes.map((node) => stripEmbeddedAnchors(toRecord(node)))
  const edges = (document.edges || []).map((edge) => edgeToRecord(edge))
  const anchors = document.nodes.flatMap((node) => anchorsToRecords(node.experimentalAnchors))
  return { nodes, edges, anchors }
}

const mapById = <T extends { id: string }>(records: T[]): Map<string, T> =>
  new Map(records.map((record) => [record.id, record]))

// sceneId 可选:缺省快照活跃画布(state.sceneId);传入时快照指定画布(供 wrapMutationForScene
// 给 deferred slot 路径用 —— slot 可建/删于非活跃画布,T2.2 Block 1)。
const snapshotFromState = (state: CanvasState, sceneId?: string): SyncSnapshot => {
  const canvasId = sceneId ?? state.sceneId
  const document = documentFor(state.canvases, canvasId)
  const { nodes, edges, anchors } = recordsFromDocument(document)
  return {
    canvasId,
    nodes: mapById(nodes),
    edges: mapById(edges),
    anchors: mapById(anchors),
    nodeOrder: nodes.map((node) => node.id),
    edgeOrder: edges.map((edge) => edge.id),
    anchorOrder: anchors.map((anchor) => anchor.id),
  }
}

const intentsForRecord = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldIntent[] => {
  const intents: FieldIntent[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (key === 'id' || key === 'revision') continue
    diffValue(before[key], after[key], [key], intents)
  }
  return intents
}

const filterValidIntents = (
  changeKind: 'edit-node' | 'edit-edge' | 'edit-anchor',
  recordId: string,
  beforeRecord: Record<string, unknown>,
  afterRecord: Record<string, unknown>,
  intents: FieldIntent[],
): FieldIntent[] => {
  const valid: FieldIntent[] = []
  for (const intent of intents) {
    try {
      validateFieldIntent(
        intent,
        (fieldPath) => classifyFieldPathTarget(beforeRecord, afterRecord, fieldPath),
      )
      valid.push(intent)
    } catch (error) {
      const detail =
        error instanceof FieldIntentError
          ? error.violation
          : error instanceof Error
            ? error.message
            : String(error)
      debugLogger.error(
        SOURCE,
        `drop invalid ${changeKind} intent for ${recordId}: ${detail} (${JSON.stringify(intent.fieldPath)})`,
      )
    }
  }
  return valid
}

const ordersEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const appendReorderIfNeeded = (
  changes: CanvasChange[],
  childType: 'node' | 'edge' | 'anchor',
  before: string[],
  after: string[],
): void => {
  if (!ordersEqual(before, after)) {
    changes.push({ kind: 'reorder-children', childType, orderedIds: [...after] })
  }
}

const isCreateChange = (
  change: CanvasChange,
): change is Extract<CanvasChange, { kind: 'create-node' | 'create-edge' | 'create-anchor' }> =>
  change.kind === 'create-node' || change.kind === 'create-edge' || change.kind === 'create-anchor'

export const buildCanvasSyncChanges = (before: SyncSnapshot, after: SyncSnapshot): CanvasChange[] => {
  const changes: CanvasChange[] = []

  for (const recordId of after.nodeOrder) {
    const next = after.nodes.get(recordId)
    const prev = before.nodes.get(recordId)
    if (!next) continue
    if (!prev) {
      changes.push({ kind: 'create-node', node: next })
      continue
    }
    const intents = filterValidIntents(
      'edit-node',
      recordId,
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
      intentsForRecord(prev as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>),
    )
    if (intents.length > 0) changes.push({ kind: 'edit-node', nodeId: recordId, intents })
  }
  for (const recordId of before.nodeOrder) {
    if (!after.nodes.has(recordId)) changes.push({ kind: 'delete-node', nodeId: recordId })
  }

  for (const recordId of after.edgeOrder) {
    const next = after.edges.get(recordId)
    const prev = before.edges.get(recordId)
    if (!next) continue
    if (!prev) {
      changes.push({ kind: 'create-edge', edge: next })
      continue
    }
    const intents = filterValidIntents(
      'edit-edge',
      recordId,
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
      intentsForRecord(prev as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>),
    )
    if (intents.length > 0) changes.push({ kind: 'edit-edge', edgeId: recordId, intents })
  }
  for (const recordId of before.edgeOrder) {
    if (!after.edges.has(recordId)) changes.push({ kind: 'delete-edge', edgeId: recordId })
  }

  for (const recordId of after.anchorOrder) {
    const next = after.anchors.get(recordId)
    const prev = before.anchors.get(recordId)
    if (!next) continue
    if (!prev) {
      changes.push({ kind: 'create-anchor', anchor: next })
      continue
    }
    const intents = filterValidIntents(
      'edit-anchor',
      recordId,
      prev as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
      intentsForRecord(prev as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>),
    )
    if (intents.length > 0) changes.push({ kind: 'edit-anchor', anchorId: recordId, intents })
  }
  for (const recordId of before.anchorOrder) {
    if (!after.anchors.has(recordId)) changes.push({ kind: 'delete-anchor', anchorId: recordId })
  }

  appendReorderIfNeeded(changes, 'node', before.nodeOrder, after.nodeOrder)
  appendReorderIfNeeded(changes, 'edge', before.edgeOrder, after.edgeOrder)
  appendReorderIfNeeded(changes, 'anchor', before.anchorOrder, after.anchorOrder)

  return changes
}

// ── Block 3 (A2-S4): asset attach/detach side-effects ──────────────────────────
// 从 before/after SyncSnapshot diff 出「新建/删除的带 server 资产的 node」→ attach/detach 候选。
// submitChanges 在对应 create-node/delete-node accepted 后 enqueue(R1 方案 A:attach 依赖 server 端 node 已落,
// gate ① persist.getChild 才能找到;detach 在 delete-node accepted 后清残留 ref —— server 不级联清 asset ref)。
// 只覆盖走 wrapMutation 的 mutation(duplicate/paste/delete);import/generate/mask-edit 走 deferred 路径不经
// wrapMutation(node 不落 server,attach 无对象,Block 3 裁定 OUT,见 PR 残余风险段)。
type AssetSideEffects = { attach: Map<string, string>; detach: Map<string, string> }

export const computeAssetSideEffects = (before: SyncSnapshot, after: SyncSnapshot): AssetSideEffects => {
  const attach = new Map<string, string>()
  const detach = new Map<string, string>()
  for (const recordId of after.nodeOrder) {
    if (before.nodes.has(recordId)) continue
    const assetId = serverAssetIdFromUrl(after.nodes.get(recordId)?.asset?.url)
    if (assetId) attach.set(recordId, assetId)
  }
  for (const recordId of before.nodeOrder) {
    if (after.nodes.has(recordId)) continue
    const assetId = serverAssetIdFromUrl(before.nodes.get(recordId)?.asset?.url)
    if (assetId) detach.set(recordId, assetId)
  }
  return { attach, detach }
}

const queueByCanvas = new Map<string, Promise<void>>()

const submitChanges = async (
  canvasId: string,
  changes: CanvasChange[],
  port: CanvasSyncPort,
  assetEffects?: AssetSideEffects,
): Promise<void> => {
  for (const change of changes) {
    const outcome = await port.submitChange(canvasId, change)
    if (outcome.kind === 'accepted') {
      // R1 方案 A(Block 3):node-change submitChange 成功后 enqueue asset side-effect(server 端 node 已落)。
      // attach 须在 create-node accepted 后(gate ① persist.getChild 能找到 node);detach 在 delete-node
      // accepted 后清残留 ref。conflict/retryable/rejected → 下方 return,不发后续(R1:reject 不发 attach)。
      if (change.kind === 'create-node' && assetEffects?.attach.has(change.node.id)) {
        enqueueAssetAttach(canvasId, assetEffects.attach.get(change.node.id) as string, change.node.id)
      } else if (change.kind === 'delete-node' && assetEffects?.detach.has(change.nodeId)) {
        enqueueAssetDetach(canvasId, assetEffects.detach.get(change.nodeId) as string, change.nodeId)
      }
      continue
    }
    if (outcome.kind === 'conflict') {
      const detail = `submitChange conflict for ${canvasId}:${change.kind}; caller rebase not wired in Block 1`
      if (isCreateChange(change)) {
        abortPendingCanvasSyncCreate(port, canvasId, change, detail)
        debugLogger.error(SOURCE, detail)
      } else {
        debugLogger.warn(SOURCE, detail)
      }
      return
    }
    if (outcome.kind === 'retryable') {
      const detail = `submitChange retryable for ${canvasId}:${change.kind} (${outcome.reason})`
      if (isCreateChange(change)) {
        abortPendingCanvasSyncCreate(port, canvasId, change, detail)
        debugLogger.error(SOURCE, detail)
      } else {
        debugLogger.warn(SOURCE, detail)
      }
      return
    }
    debugLogger.warn(
      SOURCE,
      `submitChange rejected for ${canvasId}:${change.kind} (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''})`,
    )
    return
  }
}

export const enqueueCanvasSyncChanges = (
  canvasId: string,
  changes: CanvasChange[],
  port: CanvasSyncPort = getCanvasSyncPort(),
  assetEffects?: AssetSideEffects,
): Promise<void> => {
  if (changes.length === 0) return Promise.resolve()
  const previous = queueByCanvas.get(canvasId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(() => submitChanges(canvasId, changes, port, assetEffects))
  queueByCanvas.set(canvasId, next)
  void next.finally(() => {
    if (queueByCanvas.get(canvasId) === next) queueByCanvas.delete(canvasId)
  })
  return next
}

export const __resetCanvasSyncRuntimeQueue = (): void => {
  queueByCanvas.clear()
}

export const wrapMutation = <TArgs extends unknown[], TResult>(
  mutate: (...args: TArgs) => TResult,
): ((...args: TArgs) => TResult) => {
  return (...args: TArgs): TResult => {
    // local 模式无 server port,直接 mutate 不 submitChange(与 wrapCanvasActionRuntimeWithSync 的 local
    // gate 一致;本 gate 给直接调用 wrapMutation 的快捷键路径用,防 local 模式误发 submitChange)。
    if (isLocalPersist) return mutate(...args)
    const before = snapshotFromState(useCanvasStore.getState())
    const result = mutate(...args)
    const after = snapshotFromState(useCanvasStore.getState())
    if (before.canvasId !== after.canvasId) {
      debugLogger.warn(SOURCE, `scene changed during wrapped mutation (${before.canvasId} -> ${after.canvasId}); skip submitChange`)
      return result
    }
    const changes = buildCanvasSyncChanges(before, after)
    const assetEffects = computeAssetSideEffects(before, after)
    if (changes.length > 0) void enqueueCanvasSyncChanges(before.canvasId, changes, undefined, assetEffects)
    return result
  }
}

// ── T2.2 Block 1:scene-scoped wrapMutation(deferred slot 路径用) ──────────────────
// 与 wrapMutation 同型,但快照/diff/submit 锚定 caller 指定的 targetSceneId,而非 state.sceneId。
// placeholder slot 可建于非活跃画布(prepareChatSlot / prepareMaskEditPlaceholder 的 sceneId 形参);
// 若用 wrapMutation(锚 state.sceneId)会快照错画布 → diff 空 → slot 不落 server。targetSceneId ===
// state.sceneId 时行为与 wrapMutation 一致。OUT 边界:只接 slot create + rollback delete;result
// edit-node(slot→结果原位替换)+ attach 是 Block 2/3(computeAssetSideEffects assetUrl-diff);slot create
// 的 undo 走既有键盘 undo call-site wrap(#246),不在此。
export const wrapMutationForScene = <TArgs extends unknown[], TResult>(
  targetSceneId: string,
  mutate: (...args: TArgs) => TResult,
): ((...args: TArgs) => TResult) => {
  return (...args: TArgs): TResult => {
    // local 模式无 server port,直接 mutate(与 wrapMutation 的 local gate 一致)。
    if (isLocalPersist) return mutate(...args)
    const before = snapshotFromState(useCanvasStore.getState(), targetSceneId)
    const result = mutate(...args)
    const after = snapshotFromState(useCanvasStore.getState(), targetSceneId)
    const changes = buildCanvasSyncChanges(before, after)
    const assetEffects = computeAssetSideEffects(before, after)
    if (changes.length > 0) void enqueueCanvasSyncChanges(targetSceneId, changes, undefined, assetEffects)
    return result
  }
}

export const wrapCanvasActionRuntimeWithSync = (runtime: CanvasActionRuntime): CanvasActionRuntime => {
  if (isLocalPersist) return runtime
  return {
    ...runtime,
    addTextNode: wrapMutation(runtime.addTextNode),
    addFrameNode: wrapMutation(runtime.addFrameNode),
    addAiSlotNode: wrapMutation(runtime.addAiSlotNode),
    addAnnotationNode: wrapMutation(runtime.addAnnotationNode),
    addMarkupNode: wrapMutation(runtime.addMarkupNode),
    updateMarkupStyle: wrapMutation(runtime.updateMarkupStyle),
    updateSectionStyle: wrapMutation(runtime.updateSectionStyle),
    setSectionLockMode: wrapMutation(runtime.setSectionLockMode),
    removeSectionOnly: wrapMutation(runtime.removeSectionOnly),
    duplicateNode: wrapMutation(runtime.duplicateNode),
    duplicateSelectedNodes: wrapMutation(runtime.duplicateSelectedNodes),
    groupSelectedNodes: wrapMutation(runtime.groupSelectedNodes),
    ungroupSelectedNodes: wrapMutation(runtime.ungroupSelectedNodes),
    pasteClipboardNodes: wrapMutation(runtime.pasteClipboardNodes),
    moveNodeLayer: wrapMutation(runtime.moveNodeLayer),
    moveSelectedLayer: wrapMutation(runtime.moveSelectedLayer),
    alignSelectedNodes: wrapMutation(runtime.alignSelectedNodes),
    distributeSelectedNodes: wrapMutation(runtime.distributeSelectedNodes),
    arrangeSelectedNodes: wrapMutation(runtime.arrangeSelectedNodes),
    toggleSelectedNodesLocked: wrapMutation(runtime.toggleSelectedNodesLocked),
    hideSelectedNodes: wrapMutation(runtime.hideSelectedNodes),
    showAllHiddenNodes: wrapMutation(runtime.showAllHiddenNodes),
    deleteNode: wrapMutation(runtime.deleteNode),
    deleteSelectedNodes: wrapMutation(runtime.deleteSelectedNodes),
    // F4:runtime 路径(canvasActionModel 菜单 "Generate into slot" + ai-slot view-details)的 generateIntoAiSlot
    // 注入 onSceneMutation —— catch 删 slot 经回调发 delete-node(与 chat generationFacade 注入对称)。不 wrapMutation
    // (async 生成不能同步 before/after wrap,那是 Block 3);只注入回调,内部失败删 slot 那一步经 wrapMutationForScene
    // 发 delete-node。local 分支早 return runtime → raw,catch default passthrough,行为不退。
    generateIntoAiSlot: (slotId, prompt, options) =>
      runtime.generateIntoAiSlot(slotId, prompt, {
        ...options,
        onSceneMutation: (sceneId: string, mutate: () => void) => wrapMutationForScene(sceneId, mutate)(),
      }),
  }
}
