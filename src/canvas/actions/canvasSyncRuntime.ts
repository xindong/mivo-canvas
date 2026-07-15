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
    // F1(T2.2 Block 2 review):plainObject container 整体消失时分解为子 key 的 leaf delete,而非 container-level
    //   delete-field(后者被 validateFieldIntent 拒 'container-delete-field' → 静默丢,server 永不知字段消失 +
    //   本块 computeAssetSideEffects 的 detach 会与被丢的 change 错位 → 混合批次悬空资产)。leaf delete 合规放行
    //   (validateFieldIntent 注释:合法 optional leaf delete 放行),是 container 消失在 clobber 契约下的唯一合规
    //   表达。asset 消失 → delete ['asset','url'] 等,让 edit-node change 真发出 → attach/detach 可对齐真相源
    //   (见 computeAssetSideEffects 的 changes 过滤)。数组消失不分解(Array 非 plainObject,走下方 delete-field;
    //   数组元素 delete-field 被 structural 拒 array-element-structure-delete,行为不变)。
    if (isPlainObject(before)) {
      for (const key of Object.keys(before)) {
        diffValue(before[key], undefined, [...fieldPath, key], intents)
      }
      return
    }
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
// Block 2(T2.2):扩 edit-node 的 assetUrl 变更 —— before/after 都存在的 node 做 assetId diff,堵 slot→result
// 同 id edit-node 场景下结果图资产 refcount=0 → 7 天误删(详见 computeAssetSideEffects edit-node 分支)。
// 只覆盖走 wrapMutation 的 mutation(duplicate/paste/delete + Block 2 edit-node assetUrl-diff);import/generate/
// mask-edit 的「产生 assetUrl 变更的调用方」仍走 deferred 路径不经 wrapMutation(diff 机制已就位,接线是 Block 3)。
type AssetSideEffects = { attach: Map<string, string>; detach: Map<string, string> }

export const computeAssetSideEffects = (
  before: SyncSnapshot,
  after: SyncSnapshot,
  changes?: readonly CanvasChange[],
): AssetSideEffects => {
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
  // Block 2(T2.2):edit-node(before/after 都存在的 node)的 assetUrl 变更 diff。旧逻辑只认 create/delete,
  // edit 变 assetUrl 时 attach 永不触发 → slot→result 同 id edit-node 的结果图资产 refcount=0 → 7 天误删。
  //   旧无→新有:attach 新 | 旧有→新无:detach 旧 | 旧≠新(都 server):detach 旧 + attach 新 | 其余(相同/都非 server)不动。
  for (const recordId of after.nodeOrder) {
    if (!before.nodes.has(recordId)) continue // create 由首循环处理
    const prevAssetId = serverAssetIdFromUrl(before.nodes.get(recordId)?.asset?.url)
    const nextAssetId = serverAssetIdFromUrl(after.nodes.get(recordId)?.asset?.url)
    if (prevAssetId === nextAssetId) continue // 相同(含都 undefined / 都非 server url)→ 不动
    if (prevAssetId) {
      // 旧有 server 资产:detach 旧(server A→B 与 server→无 都先 detach 旧)
      detach.set(recordId, prevAssetId)
      if (nextAssetId) {
        // 旧≠新(都 server):attach 新
        attach.set(recordId, nextAssetId)
      }
    } else if (nextAssetId) {
      // 旧无→新有(旧非 server/无 asset → 新 server):attach 新
      attach.set(recordId, nextAssetId)
    }
  }
  // F1(T2.2 Block 2 review):edit-node 的 attach/detach 对齐到 buildCanvasSyncChanges 真实产出的 changes ——
  //   只有 changes 里有对应 edit-node change 且含 asset 叶子 intent(fieldPath[0]==='asset')的 entry 才保留。
  //   一个真相源:asset 变更被 validator 丢(container-delete)或未分解 → change 无 asset 叶子 intent →
  //   side effect 也不发,防"asset 移除被丢但 detach 仍发"的悬空资产。create/delete 的 entry 对应的
  //   create-node/delete-node change 必在 changes(nodeId 仅在 before 或仅 after),不过滤。
  if (changes) {
    const editAssetChanged = new Set<string>()
    for (const change of changes) {
      if (change.kind === 'edit-node' && change.intents.some((intent) => intent.fieldPath[0] === 'asset')) {
        editAssetChanged.add(change.nodeId)
      }
    }
    for (const recordId of attach.keys()) {
      if (before.nodes.has(recordId) && after.nodes.has(recordId) && !editAssetChanged.has(recordId)) {
        attach.delete(recordId)
      }
    }
    for (const recordId of detach.keys()) {
      if (before.nodes.has(recordId) && after.nodes.has(recordId) && !editAssetChanged.has(recordId)) {
        detach.delete(recordId)
      }
    }
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
      } else if (change.kind === 'edit-node') {
        // Block 2(T2.2):edit-node accepted 后,按 computeAssetSideEffects 的 assetUrl-diff 结果 enqueue
        // detach 旧 + attach 新(顺序先 detach 旧再 attach 新,与 computeAssetSideEffects server A→B 分支语义对齐)。
        // slot→result 同 id edit-node 在此接出 attach —— 堵结果图资产 refcount=0 → 7 天误删。
        // attach 合法:edit-node accepted 意味 node 仍在 server(非 delete),attach gate ① persist.getChild 能找到。
        // 两个 if 非 else:A→B 时 detach 与 attach 都要发;assetUrl 不变的 edit 两 map 都无该 nodeId → 都不发。
        if (assetEffects?.detach.has(change.nodeId)) {
          enqueueAssetDetach(canvasId, assetEffects.detach.get(change.nodeId) as string, change.nodeId)
        }
        if (assetEffects?.attach.has(change.nodeId)) {
          enqueueAssetAttach(canvasId, assetEffects.attach.get(change.nodeId) as string, change.nodeId)
        }
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
    const assetEffects = computeAssetSideEffects(before, after, changes)
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
    const assetEffects = computeAssetSideEffects(before, after, changes)
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
