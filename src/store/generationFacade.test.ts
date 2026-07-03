import { describe, expect, it, vi, beforeEach } from 'vitest'

// Hermetic setup (mirrors generation.contract.test.ts): stub the demo-image renderer,
// the asset store, the remote debug flusher, and the mivoImageClient network layer.
vi.mock('../lib/demoImages', () => ({ createDemoImage: () => 'data:image/png;base64,mock-demo-image' }))
vi.mock('../lib/assetStorage', () => ({
  saveGeneratedAsset: vi.fn(async (_blob: Blob, name: string, type: string) => ({
    assetUrl: 'mivo-asset://mock-asset', name, type, sizeBytes: 1234, hasTransparency: false, size: '300x200', sourceDimensions: { width: 300, height: 200 },
  })),
  saveImportedAsset: vi.fn(),
  readImportedAssetFile: vi.fn(),
}))
vi.mock('./remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))
const mocks = vi.hoisted(() => ({ editMivoImage: vi.fn(), generateMivoImage: vi.fn(), assetBlobForNode: vi.fn() }))
vi.mock('../lib/mivoImageClient', () => ({
  editMivoImage: mocks.editMivoImage,
  generateMivoImage: mocks.generateMivoImage,
  assetBlobForNode: mocks.assetBlobForNode,
  MivoImageRequestError: class MivoImageRequestError extends Error { kind: string; constructor(m: string, k: string) { super(m); this.name = 'MivoImageRequestError'; this.kind = k } },
  enhanceMivoPrompt: vi.fn(),
}))

import { useCanvasStore } from './canvasStore'
import { generationFacade } from './generationFacade'
import type { MivoCanvasNode } from '../types/mivoCanvas'

const imageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'img-1', type: 'image', title: 'Image', x: 10, y: 20, width: 300, height: 200, status: 'ready', assetUrl: '/a.png', ...overrides,
})
const slotNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'slot-1', type: 'ai-slot', title: 'Slot', x: 0, y: 0, width: 200, height: 200, status: 'ready', ...overrides,
})

const seedCanvas = (nodes: MivoCanvasNode[], sceneId = 'c1') => {
  useCanvasStore.setState({
    sceneId,
    nodes,
    canvases: { [sceneId]: { title: 'Canvas One', nodes, edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] } },
    selectedNodeId: undefined,
    selectedNodeIds: [],
    historyPast: [],
    historyFuture: [],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  seedCanvas([imageNode(), slotNode()])
})

describe('generationFacade.prepareChatSlot', () => {
  it('beside mode when hasSelectedImage + selectedNodeId', () => {
    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', selectedNodeId: 'img-1', hasSelectedImage: true, prompt: 'p' })
    expect(prep).toEqual({ mode: 'beside', slotId: undefined })
  })

  it('slot mode creates a new ai-slot when no image selected', () => {
    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, prompt: 'a cat' })
    expect(prep.mode).toBe('slot')
    expect(prep.slotId).toBeTruthy()
    // the slot was committed to the canvas
    const created = useCanvasStore.getState().nodes.find((n) => n.id === prep.slotId)
    expect(created?.type).toBe('ai-slot')
  })

  it('reuses an existing pendingSlotId when the slot is still present', () => {
    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, pendingSlotId: 'slot-1', prompt: 'p' })
    expect(prep).toEqual({ mode: 'slot', slotId: 'slot-1' })
    // no new slot created
    expect(useCanvasStore.getState().nodes.filter((n) => n.type === 'ai-slot')).toHaveLength(1)
  })

  it('creates a new slot if the pendingSlotId is gone', () => {
    const prep = generationFacade.prepareChatSlot({ sceneId: 'c1', hasSelectedImage: false, pendingSlotId: 'missing-slot', prompt: 'p' })
    expect(prep.mode).toBe('slot')
    expect(prep.slotId).not.toBe('missing-slot')
    expect(useCanvasStore.getState().nodes.filter((n) => n.type === 'ai-slot')).toHaveLength(2)
  })

  it('throws if the target canvas was deleted', () => {
    expect(() => generationFacade.prepareChatSlot({ sceneId: 'gone', hasSelectedImage: false, prompt: 'p' })).toThrow('目标画布已删除')
  })
})

describe('generationFacade.getSceneChangeInfo', () => {
  it('reports no change when the scene is still active', () => {
    const info = generationFacade.getSceneChangeInfo('c1')
    expect(info.sceneChanged).toBe(false)
    expect(info.currentSceneId).toBe('c1')
    expect(info.sceneTitle).toBe('Canvas One')
  })

  it('reports a change + the current scene when the user switched scenes', () => {
    useCanvasStore.setState({ sceneId: 'c2', canvases: { c1: useCanvasStore.getState().canvases['c1'], c2: { title: 'Canvas Two', nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] } } })
    const info = generationFacade.getSceneChangeInfo('c1')
    expect(info.sceneChanged).toBe(true)
    expect(info.currentSceneId).toBe('c2')
    expect(info.sceneTitle).toBe('Canvas One') // title of the generation scene, not the current
  })
})

describe('generationFacade — delegation + failure rethrow (SC3.1 / A1 quirks)', () => {
  it('generateBesideNode delegates to the store action + returns its nodeIds', async () => {
    const spy = vi.spyOn(useCanvasStore.getState(), 'generateBesideNode').mockResolvedValue(['res-1', 'res-2'])
    const nodeIds = await generationFacade.generateBesideNode('img-1', 'p', { sceneId: 'c1' })
    expect(nodeIds).toEqual(['res-1', 'res-2'])
    expect(spy).toHaveBeenCalledWith('img-1', 'p', { sceneId: 'c1' })
    spy.mockRestore()
  })

  it('generateIntoAiSlot delegates to the store action', async () => {
    const spy = vi.spyOn(useCanvasStore.getState(), 'generateIntoAiSlot').mockResolvedValue(['res-slot'])
    const nodeIds = await generationFacade.generateIntoAiSlot('slot-1', 'p', { sceneId: 'c1' })
    expect(nodeIds).toEqual(['res-slot'])
    expect(spy).toHaveBeenCalledWith('slot-1', 'p', { sceneId: 'c1' })
    spy.mockRestore()
  })

  it('rethrows on failure (chatStore catch depends on the throw — A1 quirk)', async () => {
    const spy = vi.spyOn(useCanvasStore.getState(), 'generateBesideNode').mockRejectedValue(new Error('upstream 500'))
    await expect(generationFacade.generateBesideNode('img-1', 'p', { sceneId: 'c1' })).rejects.toThrow('upstream 500')
    spy.mockRestore()
  })
})
