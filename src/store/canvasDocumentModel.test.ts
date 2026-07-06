import { describe, expect, it, vi } from 'vitest'

// Persist middleware only attaches `api.persist` when a storage resolves; install an
// in-memory localStorage + window before the store module loads (same hermetic setup
// as canvasStore.contract.test.ts) so store-action timestamp tests can exercise
// createCanvas/duplicateCanvas/resetCurrentScene/undo/redo/replaceSnapshot.
vi.hoisted(() => {
  const store = new Map<string, string>()
  const memStorage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => {
      store.delete(k)
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
    },
  }
  const g = globalThis as Record<string, unknown>
  if (g.window === undefined) g.window = { localStorage: memStorage }
  if (g.localStorage === undefined) g.localStorage = memStorage
})

vi.mock('../lib/demoImages', () => ({
  createDemoImage: () => 'data:image/png;base64,mock-demo-image',
}))

vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset',
    name,
    type,
    sizeBytes: 1234,
    hasTransparency: false,
    size: '300x200',
    sourceDimensions: { width: 300, height: 200 },
  })),
  saveImportedAsset: vi.fn(async () => ({ assetUrl: 'mivo-asset://mock-imported' })),
  readImportedAssetFile: vi.fn(),
}))

vi.mock('./remoteDebugReporter', () => ({
  reportRemoteDebugEntry: () => {},
}))

import type { MivoCanvasNode, CanvasDocument } from '../types/mivoCanvas'
import {
  applySnapshot,
  firstAnchorImageFor,
  normalizeCanvasNodes,
  normalizeDocument,
  patchCanvasDocument,
  rollbackLatestHistoryBaseline,
} from './canvasDocumentModel'
import { useCanvasStore } from './canvasStore'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'img-1',
  type: 'image',
  title: 'Image',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  status: 'ready',
  assetUrl: '/a.png',
  ...overrides,
})

const textNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'text-1',
  type: 'text',
  title: 'Text',
  x: 0,
  y: 0,
  width: 100,
  height: 40,
  status: 'ready',
  text: 'hello',
  ...overrides,
})

describe('firstAnchorImageFor', () => {
  it('selects the leftmost visible image on the top visual row', () => {
    const anchor = firstAnchorImageFor([
      imageNode({ id: 'lower-left', x: 0, y: 340, height: 200 }),
      imageNode({ id: 'top-right', x: 300, y: 100, height: 200 }),
      imageNode({ id: 'top-left', x: 50, y: 120, height: 200 }),
      imageNode({ id: 'hidden-earlier', x: -100, y: 80, hidden: true }),
      textNode({ id: 'text-earlier', x: -200, y: 70 }),
    ])

    expect(anchor?.id).toBe('top-left')
  })

  it('does not pull images from a lower row outside the half-median-height tolerance', () => {
    const anchor = firstAnchorImageFor([
      imageNode({ id: 'top', x: 100, y: 100, height: 100 }),
      imageNode({ id: 'lower-but-left', x: 0, y: 170, height: 100 }),
    ])

    expect(anchor?.id).toBe('top')
  })

  it('returns undefined when there is no visible image', () => {
    expect(firstAnchorImageFor([
      textNode({ id: 'text-only' }),
      imageNode({ id: 'hidden-image', hidden: true }),
    ])).toBeUndefined()
  })
})

describe('rollbackLatestHistoryBaseline', () => {
  it('removes the current placeholder and restores reflowed nodes from the baseline', () => {
    const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
    const obstacleBefore = imageNode({ id: 'obstacle', x: 156, y: 0, width: 100, height: 100 })
    const slot = imageNode({ id: 'slot', type: 'ai-slot', x: 156, y: 0, width: 100, height: 100 })
    const obstacleAfter = imageNode({ id: 'obstacle', x: 312, y: 0, width: 100, height: 100 })
    const currentNodes = [source, slot, obstacleAfter]
    const baselineNodes = [source, obstacleBefore]
    const state = {
      sceneId: 'c1',
      nodes: currentNodes,
      edges: [],
      tasks: [{ id: 'task-1', label: 'running', status: 'running', progress: 0, nodeIds: [] }],
      selectedNodeId: 'slot',
      selectedNodeIds: ['slot'],
      historyPast: [{
        version: 2,
        sceneId: 'c1',
        nodes: baselineNodes,
        edges: [],
        tasks: [],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      }],
      historyFuture: [{
        version: 2,
        sceneId: 'c1',
        nodes: currentNodes,
        edges: [],
        tasks: [],
        selectedNodeId: 'slot',
        selectedNodeIds: ['slot'],
      }],
      canvases: {
        c1: {
          title: 'Canvas',
          nodes: currentNodes,
          edges: [],
          tasks: [],
          selectedNodeId: 'slot',
          selectedNodeIds: ['slot'],
        },
      },
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', { removeNodeId: 'slot' })

    expect(patch).toBeDefined()
    if (!patch) return
    const patchNodes = patch.nodes || []
    expect(patchNodes.map((node) => node.id)).toEqual(['src', 'obstacle'])
    expect(patchNodes.find((node) => node.id === 'obstacle')?.x).toBe(156)
    expect(patch.historyPast).toEqual([])
    expect(patch.historyFuture).toEqual([])
    expect(patch.selectedNodeId).toBeUndefined()
  })

  it('S01: rolls back normally when expectedBaseline matches the栈顶 snapshot (same reference)', () => {
    const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
    const slot = imageNode({ id: 'slot', type: 'ai-slot', x: 156, y: 0, width: 100, height: 100 })
    const currentNodes = [source, slot]
    const baselineSnapshot = {
      version: 2 as const,
      sceneId: 'c1',
      nodes: [source],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    }
    const state = {
      sceneId: 'c1',
      nodes: currentNodes,
      edges: [],
      tasks: [],
      selectedNodeId: 'slot',
      selectedNodeIds: ['slot'],
      historyPast: [baselineSnapshot],
      historyFuture: [],
      canvases: {
        c1: {
          title: 'Canvas',
          nodes: currentNodes,
          edges: [],
          tasks: [],
          selectedNodeId: 'slot',
          selectedNodeIds: ['slot'],
        },
      },
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', {
      removeNodeId: 'slot',
      expectedBaseline: baselineSnapshot,
    })

    expect(patch).toBeDefined()
    expect(patch?.historyPast).toEqual([])
  })

  it('S01: returns undefined when expectedBaseline does not match the栈顶 (user edited during async)', () => {
    // 异步生成期间用户编辑过 → pushHistory 推了新快照 → 栈顶已不是生成基线引用。
    // expectedBaseline 指向生成开始时的基线，与栈顶不是同一引用 → 返回 undefined，
    // caller 走 filter-removal 保留用户编辑（保编辑 > 还原位移）。
    const source = imageNode({ id: 'src', x: 0, y: 0, width: 100, height: 100 })
    const obstacleBefore = imageNode({ id: 'obstacle', x: 156, y: 0, width: 100, height: 100 })
    const slot = imageNode({ id: 'slot', type: 'ai-slot', x: 156, y: 0, width: 100, height: 100 })
    const userEditNode = imageNode({ id: 'user-edit', x: 500, y: 0 })
    const currentNodes = [source, slot, userEditNode]
    const generationBaseline = {
      version: 2 as const,
      sceneId: 'c1',
      nodes: [source, obstacleBefore],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    }
    // 用户编辑后栈顶：与 generationBaseline 不是同一引用
    const topAfterUserEdit = {
      version: 2,
      sceneId: 'c1',
      nodes: [source, slot, userEditNode],
      edges: [],
      tasks: [],
      selectedNodeId: 'user-edit',
      selectedNodeIds: ['user-edit'],
    }
    const state = {
      sceneId: 'c1',
      nodes: currentNodes,
      edges: [],
      tasks: [],
      selectedNodeId: 'user-edit',
      selectedNodeIds: ['user-edit'],
      historyPast: [generationBaseline, topAfterUserEdit],
      historyFuture: [],
      canvases: {
        c1: {
          title: 'Canvas',
          nodes: currentNodes,
          edges: [],
          tasks: [],
          selectedNodeId: 'user-edit',
          selectedNodeIds: ['user-edit'],
        },
      },
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', {
      removeNodeId: 'slot',
      expectedBaseline: generationBaseline,
    })

    expect(patch).toBeUndefined()
  })
})

describe('normalizeCanvasNodes — write-path reference preservation (R01 fast path)', () => {
  // The R01 fast path (commit #2) makes normalizeCanvasNodesV2 return the SAME reference
  // for already-normalized nodes. This locks the write-path contract: unmoved, non-
  // connector, membership-unchanged nodes keep their reference through the full 3-layer
  // pipeline (sectionMembership → connectorMarkup → normalizeCanvasNodesV2), so
  // CanvasNodeView's React.memo skips re-render for them during a drag frame. Connectors
  // always rebuild in layer 2 (setNodeTransform); membership-changed nodes rebuild in
  // layer 1 + layer 3. Both are excluded from the "retains ref" assertion.

  // 20 normalized nodes: 1 frame (section), 2 members inside it, 1 markup-arrow
  // connector bound to member-1 + outside-1, 16 outside images. Members carry
  // sectionId='frame-1' matching their geometric membership so layer 1 returns same ref.
  const buildFixture = (): MivoCanvasNode[] => {
    const frame = normalizeCanvasNodeV2({
      id: 'frame-1',
      type: 'frame',
      title: 'F',
      status: 'ready',
      x: 0,
      y: 0,
      width: 500,
      height: 500,
      sectionFillColor: '#eee',
    })
    const member = (id: string, x: number, y: number): MivoCanvasNode =>
      normalizeCanvasNodeV2({
        id,
        type: 'image',
        title: id,
        status: 'ready',
        x,
        y,
        width: 80,
        height: 80,
        assetUrl: `/${id}.png`,
        sectionId: 'frame-1',
      })
    const outside = (id: string, x: number, y: number): MivoCanvasNode =>
      normalizeCanvasNodeV2({
        id,
        type: 'image',
        title: id,
        status: 'ready',
        x,
        y,
        width: 80,
        height: 80,
        assetUrl: `/${id}.png`,
      })
    const connector = normalizeCanvasNodeV2({
      id: 'conn-1',
      type: 'markup',
      title: 'C1',
      status: 'ready',
      markupKind: 'arrow',
      x: 180,
      y: 140,
      width: 820,
      height: 860,
      markupStrokeColor: '#497466',
      markupStrokeWidth: 3,
      markupStrokeStyle: 'solid',
      markupOpacity: 0.82,
      markupPoints: [
        { x: 0, y: 0 },
        { x: 820, y: 860 },
      ],
      connectorStart: { nodeId: 'member-1', anchor: 'right' },
      connectorEnd: { nodeId: 'outside-1', anchor: 'left' },
    })

    const members = [member('member-1', 100, 100), member('member-2', 300, 300)]
    const outsides = Array.from({ length: 16 }, (_, index) =>
      outside(`outside-${index + 1}`, 1000 + index * 100, 1000 + index * 100),
    )
    return [frame, ...members, connector, ...outsides]
  }

  // Helper: a normalized node moved to a new position (transform + legacy x/y kept in sync
  // so the result is still normalized — the fast path returns the same ref for it too).
  const movedNode = (node: MivoCanvasNode, newX: number, newY: number): MivoCanvasNode => ({
    ...node,
    x: newX,
    y: newY,
    transform: { ...node.transform!, x: newX, y: newY },
  })

  it('a) unmoved non-connector / membership-unchanged nodes retain their reference (toBe)', () => {
    const fixture = buildFixture()
    const originalByIndex = fixture.map((node) => node)
    // move outside-2 (non-member, non-connector, not bound to the connector) to a new
    // position that is still outside the frame → its sectionId stays undefined
    const movedIndex = fixture.findIndex((node) => node.id === 'outside-2')
    const moved = movedNode(fixture[movedIndex], 5000, 5000)
    const input = fixture.map((node, index) => (index === movedIndex ? moved : node))

    const result = normalizeCanvasNodes(input)

    // the moved node is excluded; the connector is excluded (always rebuilds in layer 2)
    const connectorIndex = fixture.findIndex((node) => node.id === 'conn-1')
    result.forEach((node, index) => {
      if (index === movedIndex || index === connectorIndex) return
      expect(node).toBe(originalByIndex[index])
    })
  })

  it('b) the moved node lands at its new position', () => {
    const fixture = buildFixture()
    const movedIndex = fixture.findIndex((node) => node.id === 'outside-3')
    const input = fixture.map((node, index) =>
      index === movedIndex ? movedNode(node, 4321, 1234) : node,
    )
    const result = normalizeCanvasNodes(input)
    expect(result[movedIndex].x).toBe(4321)
    expect(result[movedIndex].y).toBe(1234)
    expect(result[movedIndex].transform?.x).toBe(4321)
  })

  it('c) connector geometry recomputes when a bound endpoint moves', () => {
    const fixture = buildFixture()
    const connectorIndex = fixture.findIndex((node) => node.id === 'conn-1')
    const originalConnector = fixture[connectorIndex]
    // move member-1 (a bound endpoint) within the frame so its membership is unchanged
    const memberIndex = fixture.findIndex((node) => node.id === 'member-1')
    const input = fixture.map((node, index) =>
      index === memberIndex ? movedNode(node, 150, 150) : node,
    )
    const result = normalizeCanvasNodes(input)
    const connector = result[connectorIndex]
    // layer 2 always rebuilds a bound connector → new reference
    expect(connector).not.toBe(originalConnector)
    // geometry follows the moved endpoint → at least one of x/y/width/height differs
    const geometryChanged =
      connector.x !== originalConnector.x ||
      connector.y !== originalConnector.y ||
      connector.width !== originalConnector.width ||
      connector.height !== originalConnector.height
    expect(geometryChanged).toBe(true)
  })

  it('d) frame dragged over a non-member recomputes that node sectionId', () => {
    const fixture = buildFixture()
    const frameIndex = fixture.findIndex((node) => node.id === 'frame-1')
    const targetIndex = fixture.findIndex((node) => node.id === 'outside-4') // currently outside
    expect(fixture[targetIndex].sectionId).toBeUndefined()
    // move the frame so it now covers outside-4 (originally at 1300,1300)
    const frame = fixture[frameIndex]
    const movedFrame: MivoCanvasNode = {
      ...frame,
      x: 1100,
      y: 1100,
      transform: { ...frame.transform!, x: 1100, y: 1100 },
    }
    const input = fixture.map((node, index) => (index === frameIndex ? movedFrame : node))
    const result = normalizeCanvasNodes(input)
    // outside-4's center is now inside the moved frame → sectionId recomputed to frame-1
    expect(result[targetIndex].sectionId).toBe('frame-1')
    // and because membership changed, layer 1 produced a new object → not the same ref
    expect(result[targetIndex]).not.toBe(fixture[targetIndex])
  })
})

// ---------------------------------------------------------------------------
// updatedAt bump hub (Phase 1 — C4). Documents gain createdAt/updatedAt; content
// patches bump updatedAt, selection-only patches do not, and an explicit
// bumpUpdatedAt:false override covers high-frequency machine updates (mask-edit
// poll progress). These pure-function tests cover the contract that mask-edit
// (src/canvas/maskEditGeneration.ts) routes through once 1d lands.
// ---------------------------------------------------------------------------

const blankDoc = (overrides: Partial<CanvasDocument> = {}): CanvasDocument => ({
  title: 'C',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  nodes: [],
  edges: [],
  tasks: [],
  selectedNodeId: undefined,
  selectedNodeIds: [],
  ...overrides,
})

const stateWith = (canvases: Record<string, CanvasDocument>, sceneId: string) =>
  ({
    canvases,
    sceneId,
    nodes: canvases[sceneId]?.nodes ?? [],
    edges: canvases[sceneId]?.edges ?? [],
    tasks: canvases[sceneId]?.tasks ?? [],
    selectedNodeId: canvases[sceneId]?.selectedNodeId,
    selectedNodeIds: canvases[sceneId]?.selectedNodeIds ?? [],
    activeTool: 'select',
    clipboardNodes: [],
    clipboardAssets: [],
    historyPast: [],
    historyFuture: [],
    projects: [],
  }) as unknown as Parameters<typeof patchCanvasDocument>[0]

describe('updatedAt bump hub: patchCanvasDocument', () => {
  const node = (id: string): MivoCanvasNode =>
    normalizeCanvasNodeV2({
      id,
      type: 'image',
      title: id,
      status: 'ready',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      assetUrl: `/${id}.png`,
    })

  it('bumps updatedAt when the patch contains nodes (content change)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const state = stateWith({ c1: blankDoc({ updatedAt: before, nodes: [node('n1')] }) }, 'c1')
    const result = patchCanvasDocument(state, 'c1', { nodes: [node('n1'), node('n2')] })
    const updated = (result.canvases as Record<string, CanvasDocument>)['c1']
    expect(updated.updatedAt > before).toBe(true)
    // ISO 8601 shape sanity
    expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('bumps updatedAt when the patch contains tasks or edges or title', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const state = stateWith({ c1: blankDoc({ updatedAt: before, nodes: [node('n1')] }) }, 'c1')
    const tasks = [{ id: 'task-1', label: 't', status: 'done' as const, progress: 100, nodeIds: [] }]
    const result = patchCanvasDocument(state, 'c1', { tasks })
    expect((result.canvases as Record<string, CanvasDocument>)['c1'].updatedAt > before).toBe(true)
  })

  it('does NOT bump updatedAt on a selection-only patch (selectedNodeId/selectedNodeIds)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const state = stateWith({ c1: blankDoc({ updatedAt: before, nodes: [node('n1')] }) }, 'c1')
    const result = patchCanvasDocument(state, 'c1', { selectedNodeId: 'n1', selectedNodeIds: ['n1'] })
    expect((result.canvases as Record<string, CanvasDocument>)['c1'].updatedAt).toBe(before)
  })

  it('does NOT bump updatedAt when bumpUpdatedAt:false is passed explicitly (mask-edit poll progress path)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const state = stateWith({ c1: blankDoc({ updatedAt: before, nodes: [node('n1')] }) }, 'c1')
    const result = patchCanvasDocument(state, 'c1', { nodes: [node('n1')] }, { bumpUpdatedAt: false })
    expect((result.canvases as Record<string, CanvasDocument>)['c1'].updatedAt).toBe(before)
  })

  it('bumps updatedAt on the active-scene path too (patchActiveCanvas)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const state = stateWith({ c1: blankDoc({ updatedAt: before, nodes: [node('n1')] }) }, 'c1')
    const result = patchCanvasDocument(state, 'c1', { nodes: [node('n1'), node('n2')] })
    // active scene surfaces nodes at top level + writes canvases
    expect((result.canvases as Record<string, CanvasDocument>)['c1'].updatedAt > before).toBe(true)
  })
})

describe('updatedAt bump hub: normalizeDocument backfill', () => {
  it('backfills createdAt/updatedAt with now when missing (defensive for old snapshots/demo scenes)', () => {
    const before = Date.now()
    const doc = normalizeDocument({
      title: 'Legacy',
      nodes: [],
      edges: [],
      tasks: [],
    } as unknown as CanvasDocument)
    const after = Date.now()
    expect(doc.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(doc.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const updatedAtMs = Date.parse(doc.updatedAt)
    expect(updatedAtMs >= before).toBe(true)
    expect(updatedAtMs <= after).toBe(true)
  })

  it('preserves existing timestamps rather than overwriting them', () => {
    const doc = normalizeDocument({
      title: 'Existing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
      nodes: [],
      edges: [],
      tasks: [],
    } as CanvasDocument)
    expect(doc.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(doc.updatedAt).toBe('2026-02-02T00:00:00.000Z')
  })
})

describe('updatedAt bump hub: applySnapshot / rollbackLatestHistoryBaseline', () => {
  const node = (id: string): MivoCanvasNode =>
    normalizeCanvasNodeV2({
      id,
      type: 'image',
      title: id,
      status: 'ready',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      assetUrl: `/${id}.png`,
    })

  it('applySnapshot bumps updatedAt (undo/redo/replaceSnapshot = user action)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const state = stateWith({ c1: blankDoc({ updatedAt: before, nodes: [node('n1')] }) }, 'c1')
    const result = applySnapshot(state, {
      version: 2,
      sceneId: 'c1',
      nodes: [node('n1'), node('n2')],
      edges: [],
      tasks: [],
    })
    expect((result.canvases as Record<string, CanvasDocument>)['c1'].updatedAt > before).toBe(true)
  })

  it('rollbackLatestHistoryBaseline bumps updatedAt (mask-edit failure/cancel rollback = content change)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    const source = node('src')
    const obstacleBefore = node('obstacle')
    const slot = { ...node('slot'), type: 'ai-slot' as const }
    const state = {
      ...stateWith(
        { c1: blankDoc({ updatedAt: before, nodes: [source, slot] }) },
        'c1',
      ),
      historyPast: [{
        version: 2 as const,
        sceneId: 'c1',
        nodes: [source, obstacleBefore],
        edges: [],
        tasks: [],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      }],
      historyFuture: [],
    } as unknown as Parameters<typeof rollbackLatestHistoryBaseline>[0]

    const patch = rollbackLatestHistoryBaseline(state, 'c1', { removeNodeId: 'slot' })
    expect(patch).toBeDefined()
    expect((patch!.canvases as Record<string, CanvasDocument>)['c1'].updatedAt > before).toBe(true)
  })
})

describe('updatedAt bump hub: store actions (createCanvas / duplicateCanvas / resetCurrentScene / replaceSnapshot)', () => {
  const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
    id: 'img-1',
    type: 'image',
    title: 'Image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    status: 'ready',
    assetUrl: '/a.png',
    ...overrides,
  })

  const baseState = useCanvasStore.getState()
  const seedStore = (canvases: Record<string, CanvasDocument>, sceneId: string) =>
    useCanvasStore.setState(
      {
        ...baseState,
        canvases,
        sceneId,
        nodes: canvases[sceneId]?.nodes ?? [],
        edges: canvases[sceneId]?.edges ?? [],
        tasks: canvases[sceneId]?.tasks ?? [],
        selectedNodeId: undefined,
        selectedNodeIds: [],
      } as never,
      true,
    )

  it('createCanvas sets createdAt = updatedAt = now', () => {
    const before = Date.now()
    const id = useCanvasStore.getState().createCanvas('Fresh')
    const after = Date.now()
    const doc = useCanvasStore.getState().canvases[id]
    expect(doc.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(doc.updatedAt).toBe(doc.createdAt)
    const ms = Date.parse(doc.createdAt)
    expect(ms >= before).toBe(true)
    expect(ms <= after).toBe(true)
  })

  it('duplicateCanvas sets fresh createdAt/updatedAt = now (does NOT inherit source timestamps — C8)', () => {
    const sourceTime = '2026-01-01T00:00:00.000Z'
    const sourceId = useCanvasStore.getState().createCanvas('Original')
    // Pin the source to an old timestamp (merge mode — replace=true would strip
    // the store's action functions, so only the canvases slice is updated here).
    useCanvasStore.setState((s) => ({
      canvases: {
        ...s.canvases,
        [sourceId]: { ...s.canvases[sourceId], createdAt: sourceTime, updatedAt: sourceTime },
      },
    }) as never)

    const before = Date.now()
    const dupId = useCanvasStore.getState().duplicateCanvas(sourceId)
    const after = Date.now()
    const dup = useCanvasStore.getState().canvases[dupId!]
    expect(dup.createdAt).not.toBe(sourceTime)
    expect(dup.updatedAt).not.toBe(sourceTime)
    expect(dup.createdAt).toBe(dup.updatedAt)
    const ms = Date.parse(dup.createdAt)
    expect(ms >= before).toBe(true)
    expect(ms <= after).toBe(true)
  })

  it('resetCurrentScene bumps updatedAt (user explicit reset)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    // Use a non-demo scene id so resetCurrentScene falls back to createBlankDocument
    seedStore({ 'custom-scene': blankDoc({ title: 'Custom', updatedAt: before, nodes: [imageNode({ id: 'n1' })] }) }, 'custom-scene')
    useCanvasStore.getState().resetCurrentScene()
    expect(useCanvasStore.getState().canvases['custom-scene'].updatedAt > before).toBe(true)
  })

  it('replaceSnapshot bumps updatedAt (user explicit replace)', () => {
    const before = '2026-07-01T00:00:00.000Z'
    seedStore({ 'c1': blankDoc({ title: 'C', updatedAt: before, nodes: [imageNode({ id: 'n1' })] }) }, 'c1')
    useCanvasStore.getState().replaceSnapshot({
      version: 2,
      sceneId: 'c1',
      nodes: [imageNode({ id: 'n1' }), imageNode({ id: 'n2', x: 200 })],
      edges: [],
      tasks: [],
    })
    expect(useCanvasStore.getState().canvases['c1'].updatedAt > before).toBe(true)
  })
})

// Mask-edit routing (1d): patchMaskEditSlotStatus / patchMaskEditProgress /
// removeMaskEditPlaceholder all route through patchCanvasDocument after 1d. The
// bumpUpdatedAt contract they rely on is covered by the patchCanvasDocument
// describe above (content patch bumps; bumpUpdatedAt:false on the poll-progress
// path does not). The end-to-end mask-edit flow is exercised by Phase 6 e2e.

