import type {
  CanvasChange,
  CanvasSnapshot,
  CanvasSyncPort,
  ChangeOutcome,
  SnapshotCursor,
  Unsubscribe,
  FieldIntent,
} from './canvasSyncPort'
import type {
  CanvasChildUpsertResponse,
  ConflictBody,
  DomainOp as WireDomainOp,
  FieldPath as WireFieldPath,
  GetCanvasResponse,
  Revision,
} from '../../shared/persist-contract.ts'
import { classifyFieldPathBySchema } from '../../shared/persist-contract.ts'
import type { AnchorRecord, EdgeRecord, NodeRecord } from '../kernel/records'
import {
  createFetchServerPersistAdapter,
  defaultFetch,
  HttpError,
  requestJson,
  stripIdRev,
  type FetchAdapterOptions,
  type FetchLike,
  type GetAuthHeaders,
} from './serverPersistAdapter'
import {
  applyAccepted,
  applyConflict,
  buildBundle,
  extractWireBase,
  unwrapBundle,
} from './snapshotCursorBundle'
import { getCanvasCursor, setCanvasCursor, storeCanvasCursor } from './snapshotCursorStore'
import { isLocalPersist, persistMode } from './persistMode'
import {
  FieldIntentError,
  unwiredCanvasSyncPort,
  validateFieldIntent,
  type RejectionReason,
} from './canvasSyncPort'
import { debugLogger } from '../store/debugLogStore'

const SOURCE = 'Canvas Sync Port Client'

const recordIdOf = (change: CanvasChange): string | undefined => {
  switch (change.kind) {
    case 'create-node':
      return change.node.id
    case 'create-edge':
      return change.edge.id
    case 'create-anchor':
      return change.anchor.id
    case 'edit-node':
    case 'delete-node':
      return change.nodeId
    case 'edit-edge':
    case 'delete-edge':
      return change.edgeId
    case 'edit-anchor':
    case 'delete-anchor':
      return change.anchorId
    case 'reorder-children':
    case 'update-meta':
      return undefined
  }
}

const isCreateKind = (
  change: CanvasChange,
): change is Extract<CanvasChange, { kind: 'create-node' | 'create-edge' | 'create-anchor' }> =>
  change.kind === 'create-node' || change.kind === 'create-edge' || change.kind === 'create-anchor'

const childSeg = (type: 'node' | 'edge' | 'anchor'): string => (type === 'node' ? 'nodes' : type === 'edge' ? 'edges' : 'anchors')

const childTypeOf = (change: CanvasChange): 'node' | 'edge' | 'anchor' | undefined => {
  switch (change.kind) {
    case 'create-node':
    case 'edit-node':
    case 'delete-node':
      return 'node'
    case 'create-edge':
    case 'edit-edge':
    case 'delete-edge':
      return 'edge'
    case 'create-anchor':
    case 'edit-anchor':
    case 'delete-anchor':
      return 'anchor'
    case 'reorder-children':
      return change.childType
    case 'update-meta':
      return undefined
  }
}

const childPath = (canvasId: string, type: 'node' | 'edge' | 'anchor', recordId: string): string =>
  `/api/canvas/${encodeURIComponent(canvasId)}/${childSeg(type)}/${encodeURIComponent(recordId)}`

const fieldIntentToDomainOp = (intent: FieldIntent): WireDomainOp =>
  intent.op === 'set'
    ? { kind: 'set', fieldPath: intent.fieldPath as unknown as WireFieldPath, value: intent.value }
    : { kind: 'unset', fieldPath: intent.fieldPath as unknown as WireFieldPath }

const mapHttpRejection = (status: number): RejectionReason | 'retryable' => {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 413) return 'too-large'
  if (status === 422) return 'reuse-conflict'
  if (status === 400 || status === 428) return 'bad-request'
  if (status >= 500 || status === 408 || status === 429) return 'retryable'
  return 'terminal'
}

const materializeNodeRecord = (entry: GetCanvasResponse['nodes'][number]): NodeRecord =>
  ({
    ...(entry.payload as Record<string, unknown>),
    id: entry.id,
    revision: entry.revision,
  }) as NodeRecord

const materializeEdgeRecord = (entry: GetCanvasResponse['edges'][number]): EdgeRecord =>
  ({
    ...(entry.payload as Record<string, unknown>),
    id: entry.id,
    revision: entry.revision,
  }) as EdgeRecord

const materializeAnchorRecord = (entry: GetCanvasResponse['anchors'][number]): AnchorRecord =>
  ({
    ...(entry.payload as Record<string, unknown>),
    id: entry.id,
    revision: entry.revision,
  }) as AnchorRecord

type PendingCreateEntry = {
  phase: 'in-flight' | 'awaiting-retry'
  create: Extract<CanvasChange, { kind: 'create-node' | 'create-edge' | 'create-anchor' }>
  base?: SnapshotCursor
  held: Array<{ change: CanvasChange; resolve: (outcome: ChangeOutcome) => void }>
}

type PendingCreateAwareCanvasSyncPort = CanvasSyncPort & {
  __abortPendingCreate?: (canvasId: string, change: CanvasChange, detail: string) => boolean
}

// F2-ter(T2.2 Block 2 五轮):transport classifier 改用 shared classifyFieldPathBySchema(与生产同实现,单一真相源)。
//   旧 permissive classifier(只看末段 number → 否则 leaf)漏洞:set ['fills']='not-array' 直通(末段 string → leaf → 放行);
//   schema 分类下 ['fills']=required 根数组 → 'container' → set 拒(atomic-value-to-container-path),与生产一致封死。
const validateTransportIntent = (
  intent: FieldIntent,
  recordType: 'node' | 'edge' | 'anchor',
): FieldIntentError | null => {
  try {
    validateFieldIntent(intent, (fieldPath) => classifyFieldPathBySchema(recordType, fieldPath))
    return null
  } catch (error) {
    return error instanceof FieldIntentError ? error : new FieldIntentError('non-atomic-parent-set')
  }
}

export const abortPendingCanvasSyncCreate = (
  port: CanvasSyncPort,
  canvasId: string,
  change: CanvasChange,
  detail: string,
): boolean => {
  const aware = port as PendingCreateAwareCanvasSyncPort
  return aware.__abortPendingCreate?.(canvasId, change, detail) ?? false
}

export const createFetchCanvasSyncPort = (opts: FetchAdapterOptions): CanvasSyncPort => {
  const doFetch: FetchLike = opts.fetch ?? defaultFetch
  const baseUrl = opts.baseUrl ?? ''
  const getAuthHeaders: GetAuthHeaders = opts.getAuthHeaders
  const hydrateAdapter = createFetchServerPersistAdapter({ fetch: doFetch, baseUrl, getAuthHeaders })
  const pendingCreates = new Map<string, PendingCreateEntry>()

  const keyOf = (canvasId: string, recordId: string): string => `${canvasId}::${recordId}`

  const refreshCursor = async (canvasId: string): Promise<SnapshotCursor | undefined> => {
    const resp = await hydrateAdapter.fetchCanvas(canvasId)
    if (!resp) return undefined
    return storeCanvasCursor(resp)
  }

  const currentCursor = async (
    canvasId: string,
    change: CanvasChange,
    seqOrUndefined?: number,
    baseOrUndefined?: string,
    orderCvOrUndefined?: Revision,
  ): Promise<SnapshotCursor> => {
    const existing = getCanvasCursor(canvasId)
    const bundle = existing && unwrapBundle(existing)
    const baseCursor = bundle ? existing : buildBundle(canvasId, {}, 0, 0)
    const next = applyAccepted(baseCursor, change, baseOrUndefined, seqOrUndefined, orderCvOrUndefined)
    setCanvasCursor(canvasId, next)
    return next
  }

  const conflictCursor = async (
    canvasId: string,
    change: CanvasChange,
    body?: ConflictBody,
  ): Promise<SnapshotCursor | undefined> => {
    const refreshed = await refreshCursor(canvasId)
    if (refreshed) return refreshed
    const existing = getCanvasCursor(canvasId)
    if (!existing) return undefined
    if (change.kind === 'reorder-children' && typeof body?.currentRevision === 'number') {
      const next = applyConflict(existing, change, undefined, undefined, body.currentRevision)
      setCanvasCursor(canvasId, next)
      return next
    }
    return existing
  }

  const transport = async (canvasId: string, change: CanvasChange, base?: SnapshotCursor): Promise<ChangeOutcome> => {
    try {
      switch (change.kind) {
        case 'create-node': {
          const response = await requestJson<CanvasChildUpsertResponse>({
            fetch: doFetch,
            baseUrl,
            getAuthHeaders,
            method: 'POST',
            path: childPath(canvasId, 'node', change.node.id),
            body: { clientId: change.node.id, type: 'node' as const, payload: stripIdRev(change.node) },
            idempotencyKey: `create-node:${canvasId}:${change.node.id}`,
          })
          return { kind: 'accepted', cursor: await currentCursor(canvasId, change, response.seq, response.base) }
        }
        case 'create-edge': {
          const response = await requestJson<CanvasChildUpsertResponse>({
            fetch: doFetch,
            baseUrl,
            getAuthHeaders,
            method: 'POST',
            path: childPath(canvasId, 'edge', change.edge.id),
            body: { clientId: change.edge.id, type: 'edge' as const, payload: stripIdRev(change.edge) },
            idempotencyKey: `create-edge:${canvasId}:${change.edge.id}`,
          })
          return { kind: 'accepted', cursor: await currentCursor(canvasId, change, response.seq, response.base) }
        }
        case 'create-anchor': {
          const response = await requestJson<CanvasChildUpsertResponse>({
            fetch: doFetch,
            baseUrl,
            getAuthHeaders,
            method: 'POST',
            path: childPath(canvasId, 'anchor', change.anchor.id),
            body: { clientId: change.anchor.id, type: 'anchor' as const, payload: stripIdRev(change.anchor) },
            idempotencyKey: `create-anchor:${canvasId}:${change.anchor.id}`,
          })
          return { kind: 'accepted', cursor: await currentCursor(canvasId, change, response.seq, response.base) }
        }
        case 'edit-node':
        case 'edit-edge':
        case 'edit-anchor': {
          const recordType = childTypeOf(change)
          if (!recordType) return { kind: 'rejected', reason: 'terminal', detail: `${change.kind} missing child type` }
          const recordId = recordIdOf(change)
          const wireBase = extractWireBase(base ?? getCanvasCursor(canvasId), change)
          if (!recordId || !wireBase) {
            return { kind: 'rejected', reason: 'terminal', detail: `${change.kind} missing bundle base` }
          }
          for (const intent of change.intents) {
            const violation = validateTransportIntent(intent, recordType)
            if (violation) {
              const detail = `invalid field intent ${violation.violation} for ${change.kind}:${recordId}`
              debugLogger.error(SOURCE, detail)
              return { kind: 'rejected', reason: 'bad-request', detail }
            }
          }
          const response = await requestJson<CanvasChildUpsertResponse>({
            fetch: doFetch,
            baseUrl,
            getAuthHeaders,
            method: 'PATCH',
            path: childPath(canvasId, recordType, recordId),
            body: change.intents.map(fieldIntentToDomainOp),
            ifMatch: wireBase,
          })
          return { kind: 'accepted', cursor: await currentCursor(canvasId, change, response.seq, response.base) }
        }
        case 'delete-node':
        case 'delete-edge':
        case 'delete-anchor': {
          const recordType = childTypeOf(change)
          const recordId = recordIdOf(change)
          const wireBase = extractWireBase(base ?? getCanvasCursor(canvasId), change)
          if (!recordType || !recordId || !wireBase) {
            return { kind: 'rejected', reason: 'terminal', detail: `${change.kind} missing bundle base` }
          }
          const response = await requestJson<{ id: string; seq: number }>({
            fetch: doFetch,
            baseUrl,
            getAuthHeaders,
            method: 'DELETE',
            path: childPath(canvasId, recordType, recordId),
            ifMatch: wireBase,
          })
          return { kind: 'accepted', cursor: await currentCursor(canvasId, change, response.seq) }
        }
        case 'reorder-children': {
          const wireBase = extractWireBase(base ?? getCanvasCursor(canvasId), change)
          if (!wireBase) return { kind: 'rejected', reason: 'terminal', detail: 'reorder-children missing order base' }
          const response = await requestJson<{ reordered: number; contentVersion: Revision; base: string }>({
            fetch: doFetch,
            baseUrl,
            getAuthHeaders,
            method: 'POST',
            path: `/api/canvas/${encodeURIComponent(canvasId)}/reorder`,
            body: { type: change.childType, orderedIds: change.orderedIds },
            ifMatch: wireBase,
          })
          return { kind: 'accepted', cursor: await currentCursor(canvasId, change, undefined, undefined, response.contentVersion) }
        }
        case 'update-meta':
          return { kind: 'rejected', reason: 'bad-request', detail: 'update-meta is out of Block 1 scope' }
      }
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 409) {
          // PR-C1 CR-6:archived canvas 写返 409 `{error:'archived'}`(可读不可写)。必须先判此分支——
          //   若落入下方 conflictCursor 路径,archived canvas 的 refetch 会成功(可读)→ 返 conflict +
          //   可读 cursor → 调用方以为编辑可 rebase 重发,实际编辑被静默丢(再发仍 409)。独立返
          //   rejected reason 'archived' 让 canvasSyncRuntime toast "先恢复再编辑",不丢编辑意图。
          const archivedBody = error.body as { error?: string } | undefined
          if (archivedBody?.error === 'archived') {
            return { kind: 'rejected', reason: 'archived', detail: 'canvas archived (CR-6); restore before editing' }
          }
          const cursor = await conflictCursor(canvasId, change, error.body as ConflictBody | undefined)
          if (cursor) return { kind: 'conflict', currentCursor: cursor, diverging: [] }
          return { kind: 'rejected', reason: 'terminal', detail: 'conflict without refreshable cursor' }
        }
        const mapped = mapHttpRejection(error.status)
        if (mapped === 'retryable') return { kind: 'retryable', reason: `http_${error.status}` }
        return { kind: 'rejected', reason: mapped, detail: error.message }
      }
      return { kind: 'retryable', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  const settleCreate = async (canvasId: string, recordId: string, createOutcome: ChangeOutcome): Promise<ChangeOutcome> => {
    const key = keyOf(canvasId, recordId)
    const entry = pendingCreates.get(key)
    if (!entry) return createOutcome
    if (createOutcome.kind === 'accepted') {
      pendingCreates.delete(key)
      for (const held of entry.held) {
        const outcome = await transport(canvasId, held.change, getCanvasCursor(canvasId))
        held.resolve(outcome)
      }
      return createOutcome
    }
    if (createOutcome.kind === 'rejected') {
      pendingCreates.delete(key)
      for (const held of entry.held) {
        held.resolve({ kind: 'rejected', reason: 'dependency-failed', detail: 'create rejected' })
      }
      return createOutcome
    }
    entry.phase = 'awaiting-retry'
    return createOutcome
  }

  const abortPendingCreate = (canvasId: string, change: CanvasChange, detail: string): boolean => {
    if (!isCreateKind(change)) return false
    const recordId = recordIdOf(change)
    if (!recordId) return false
    const key = keyOf(canvasId, recordId)
    const entry = pendingCreates.get(key)
    if (!entry) return false
    pendingCreates.delete(key)
    for (const held of entry.held) {
      held.resolve({ kind: 'rejected', reason: 'dependency-failed', detail })
    }
    return true
  }

  return {
    async loadSnapshot(canvasId: string): Promise<CanvasSnapshot | null> {
      const resp = await hydrateAdapter.fetchCanvas(canvasId)
      if (!resp) return null
      const cursor = storeCanvasCursor(resp)
      return {
        canvasId: resp.id,
        meta: {
          title: resp.title,
          projectId: resp.projectId,
          createdAt: resp.createdAt,
          updatedAt: resp.updatedAt,
        },
        nodes: resp.nodes.map(materializeNodeRecord),
        edges: resp.edges.map(materializeEdgeRecord),
        anchors: resp.anchors.map(materializeAnchorRecord),
        cursor,
      }
    },
    async submitChange(canvasId: string, change: CanvasChange, base?: SnapshotCursor): Promise<ChangeOutcome> {
      const recordId = recordIdOf(change)
      if (!recordId) return transport(canvasId, change, base ?? getCanvasCursor(canvasId))
      const key = keyOf(canvasId, recordId)
      if (isCreateKind(change)) {
        const existing = pendingCreates.get(key)
        if (existing) {
          if (existing.phase === 'in-flight') return transport(canvasId, change, base)
          existing.phase = 'in-flight'
          existing.create = change
          existing.base = base
          return settleCreate(canvasId, recordId, await transport(canvasId, change, base))
        }
        pendingCreates.set(key, { phase: 'in-flight', create: change, base, held: [] })
        return settleCreate(canvasId, recordId, await transport(canvasId, change, base))
      }
      const existing = pendingCreates.get(key)
      if (existing) {
        return new Promise<ChangeOutcome>((resolve) => {
          existing.held.push({ change, resolve })
        })
      }
      return transport(canvasId, change, base ?? getCanvasCursor(canvasId))
    },
    async subscribe(): Promise<Unsubscribe> {
      throw new Error('CanvasSyncPort.subscribe not wired in Block 1')
    },
    __abortPendingCreate: abortPendingCreate,
  } as PendingCreateAwareCanvasSyncPort
}

let wiredPort: CanvasSyncPort | undefined

export const getCanvasSyncPort = (): CanvasSyncPort => {
  if (isLocalPersist) return unwiredCanvasSyncPort
  if (wiredPort) return wiredPort
  wiredPort = createFetchCanvasSyncPort({
    getAuthHeaders: async () => (await import('./authHeaders')).authHeaders(),
  })
  return wiredPort
}

export const __resetCanvasSyncPortSelector = (): void => {
  wiredPort = undefined
}

export { persistMode }
