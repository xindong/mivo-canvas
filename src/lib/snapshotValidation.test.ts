import { describe, expect, it } from 'vitest'
import { parseCanvasSnapshot } from './snapshotValidation'
import type { MivoCanvasSnapshot, MivoCanvasNode, CanvasTask, CanvasEdge } from '../types/mivoCanvas'
import type { SerializedCanvasAsset } from './assetStorage'

// Helpers ---------------------------------------------------------------------

const validImageNode = (overrides: Partial<MivoCanvasNode> = {}): MivoCanvasNode => ({
  id: 'image-1',
  type: 'image',
  title: 'Image',
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  status: 'ready',
  assetUrl: '/asset-a.png',
  ...overrides,
})

const validTask = (overrides: Partial<CanvasTask> = {}): CanvasTask => ({
  id: 'task-1',
  label: 'Running task',
  status: 'running',
  progress: 40,
  nodeIds: ['image-1'],
  ...overrides,
})

const validEdge = (overrides: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id: 'edge-1',
  from: 'image-1',
  to: 'image-2',
  type: 'generate',
  prompt: 'derive',
  createdAt: 1000,
  ...overrides,
})

const validSnapshot = (overrides: Partial<MivoCanvasSnapshot> = {}): MivoCanvasSnapshot => ({
  version: 2,
  sceneId: 'scene-1',
  nodes: [validImageNode()],
  edges: [],
  tasks: [],
  ...overrides,
})

const validAsset = (overrides: Partial<SerializedCanvasAsset> = {}): SerializedCanvasAsset => ({
  assetUrl: '/asset-a.png',
  name: 'asset-a.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  createdAt: 1000,
  ...overrides,
})

const wrapArchive = (snapshot: MivoCanvasSnapshot, assets: SerializedCanvasAsset[] = []) => ({
  kind: 'mivo-canvas-archive',
  version: 2,
  snapshot,
  assets,
})

const parse = (value: unknown) => parseCanvasSnapshot(JSON.stringify(value))

// Tests -----------------------------------------------------------------------

describe('parseCanvasSnapshot', () => {
  describe('valid snapshots', () => {
    it('accepts a plain v2 snapshot and returns it with no assets', () => {
      const result = parse(validSnapshot())

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.assets).toEqual([])
      expect(result.snapshot.version).toBe(2)
      expect(result.snapshot.sceneId).toBe('scene-1')
      // v2 normalization fills transform/fills/asset/relations from legacy fields
      const node = result.snapshot.nodes[0]
      expect(node.transform).toEqual({ x: 10, y: 20, width: 300, height: 200, rotation: 0 })
      expect(node.fills?.[0]).toMatchObject({ kind: 'image', assetUrl: '/asset-a.png' })
      expect(node.asset).toEqual({ url: '/asset-a.png' })
    })

    it('accepts a snapshot with optional fields (edges, selectedNodeId, selectedNodeIds) present', () => {
      const result = parse(
        validSnapshot({
          nodes: [validImageNode({ id: 'image-1' }), validImageNode({ id: 'image-2', x: 400 })],
          edges: [validEdge()],
          tasks: [validTask()],
          selectedNodeId: 'image-1',
          selectedNodeIds: ['image-1', 'image-2'],
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.snapshot.edges).toHaveLength(1)
      expect(result.snapshot.tasks).toHaveLength(1)
      expect(result.snapshot.selectedNodeId).toBe('image-1')
      expect(result.snapshot.selectedNodeIds).toEqual(['image-1', 'image-2'])
    })

    it('accepts an archive (kind=mivo-canvas-archive, v2) with snapshot + assets', () => {
      const result = parse(wrapArchive(validSnapshot(), [validAsset()]))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.assets).toHaveLength(1)
      expect(result.assets[0]).toMatchObject({ name: 'asset-a.png', type: 'image/png' })
      expect(result.snapshot.sceneId).toBe('scene-1')
    })

    it('treats missing edges and selection as optional (still valid)', () => {
      const snapshot = validSnapshot()
      // edges / selectedNodeId / selectedNodeIds all absent
      const result = parse(snapshot)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.snapshot.edges).toEqual([])
    })
  })

  describe('invalid JSON / shape', () => {
    it('rejects malformed JSON with the JSON-format message', () => {
      const result = parseCanvasSnapshot('{ not json')

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('JSON 文件格式无效。')
    })

    it('rejects a non-object root', () => {
      const result = parse(42)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照内容必须是对象。')
    })

    it('rejects an array root (arrays pass isRecord but fail the version check)', () => {
      const result = parse([1, 2, 3])

      expect(result.ok).toBe(false)
      if (result.ok) return
      // Arrays are typeof 'object' so isRecord lets them through; with no .version they
      // fall through to the version guard. This characterizes the current validator.
      expect(result.message).toBe('暂不支持这个快照版本。')
    })
  })

  describe('version branches (v1 rejected, v2 accepted)', () => {
    it('rejects a plain snapshot with version 1', () => {
      const result = parse(validSnapshot({ version: 1 as unknown as 2 }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('暂不支持这个快照版本。')
    })

    it('rejects a plain snapshot with version 3', () => {
      const result = parse(validSnapshot({ version: 3 as unknown as 2 }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('暂不支持这个快照版本。')
    })

    it('rejects an archive with version 1 (archive-version message)', () => {
      const result = parse({ ...wrapArchive(validSnapshot()), version: 1 })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('暂不支持这个 Mivo 归档版本。')
    })
  })

  describe('field-level invalid snapshots', () => {
    it('rejects an empty sceneId', () => {
      const result = parse(validSnapshot({ sceneId: '  ' }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的场景 ID 无效。')
    })

    it('rejects nodes that are not an array', () => {
      const result = parse(validSnapshot({ nodes: 'nope' as unknown as MivoCanvasNode[] }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的画布节点无效。')
    })

    it('rejects a node missing id', () => {
      const badNode = validImageNode()
      delete (badNode as Partial<MivoCanvasNode>).id
      const result = parse(validSnapshot({ nodes: [badNode] }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的画布节点无效。')
    })

    it('rejects a node with an unknown type', () => {
      const result = parse(
        validSnapshot({ nodes: [validImageNode({ type: 'mystery' as MivoCanvasNode['type'] })] }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的画布节点无效。')
    })

    it('rejects a node with an unknown status', () => {
      const result = parse(
        validSnapshot({ nodes: [validImageNode({ status: 'wat' as MivoCanvasNode['status'] })] }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的画布节点无效。')
    })

    it('rejects an image crop whose rect exceeds the 0..1 range', () => {
      const result = parse(
        validSnapshot({
          nodes: [validImageNode({ imageCrop: { x: 0, y: 0, width: 1.5, height: 1 } })],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的画布节点无效。')
    })

    it('rejects a generation missing a prompt', () => {
      const result = parse(
        validSnapshot({
          nodes: [
            validImageNode({
              generation: { model: 'gpt-image-2' } as MivoCanvasNode['generation'],
            }),
          ],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的画布节点无效。')
    })

    it('rejects tasks that are not an array', () => {
      const result = parse(validSnapshot({ tasks: 'nope' as unknown as CanvasTask[] }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的任务列表无效。')
    })

    it('rejects a task with an unknown status', () => {
      const result = parse(
        validSnapshot({ tasks: [validTask({ status: 'unknown' as CanvasTask['status'] })] }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的任务列表无效。')
    })

    it('rejects edges with an invalid type', () => {
      const result = parse(
        validSnapshot({ edges: [validEdge({ type: 'weird' as CanvasEdge['type'] })] }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的派生关系无效。')
    })

    it('rejects a non-string selectedNodeId', () => {
      const result = parse(validSnapshot({ selectedNodeId: 5 as unknown as string }))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的选中节点无效。')
    })

    it('rejects a non-string-array selectedNodeIds', () => {
      const result = parse(
        validSnapshot({ selectedNodeIds: [1, 2] as unknown as string[] }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的多选节点无效。')
    })
  })

  describe('archive assets', () => {
    it('rejects an archive whose asset dataUrl is not a data: URL', () => {
      const result = parse(wrapArchive(validSnapshot(), [validAsset({ dataUrl: 'https://x/y.png' })]))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('归档里的素材数据无效。')
    })

    it('rejects an archive with a snapshot that fails validation, surfacing the snapshot message', () => {
      const result = parse(wrapArchive(validSnapshot({ sceneId: '' }), []))

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toBe('快照里的场景 ID 无效。')
    })
  })
})
