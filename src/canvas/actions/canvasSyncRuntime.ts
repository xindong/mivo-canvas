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

const snapshotFromState = (state: CanvasState): SyncSnapshot => {
  const canvasId = state.sceneId
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

const queueByCanvas = new Map<string, Promise<void>>()

const submitChanges = async (
  canvasId: string,
  changes: CanvasChange[],
  port: CanvasSyncPort,
): Promise<void> => {
  for (const change of changes) {
    const outcome = await port.submitChange(canvasId, change)
    if (outcome.kind === 'accepted') continue
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
): Promise<void> => {
  if (changes.length === 0) return Promise.resolve()
  const previous = queueByCanvas.get(canvasId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(() => submitChanges(canvasId, changes, port))
  queueByCanvas.set(canvasId, next)
  void next.finally(() => {
    if (queueByCanvas.get(canvasId) === next) queueByCanvas.delete(canvasId)
  })
  return next
}

export const __resetCanvasSyncRuntimeQueue = (): void => {
  queueByCanvas.clear()
}

const wrapMutation = <TArgs extends unknown[], TResult>(
  mutate: (...args: TArgs) => TResult,
): ((...args: TArgs) => TResult) => {
  return (...args: TArgs): TResult => {
    const before = snapshotFromState(useCanvasStore.getState())
    const result = mutate(...args)
    const after = snapshotFromState(useCanvasStore.getState())
    if (before.canvasId !== after.canvasId) {
      debugLogger.warn(SOURCE, `scene changed during wrapped mutation (${before.canvasId} -> ${after.canvasId}); skip submitChange`)
      return result
    }
    const changes = buildCanvasSyncChanges(before, after)
    if (changes.length > 0) void enqueueCanvasSyncChanges(before.canvasId, changes)
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
  }
}
