import { describe, expect, it } from 'vitest'
import type { MivoCanvasSnapshot } from '../types/mivoCanvas'
import { normalizeCanvasSnapshotV2 } from './canvasSnapshotModel'

const currentSnapshot = (): MivoCanvasSnapshot => ({
  version: 2,
  sceneId: 'scene-1',
  nodes: [
    {
      id: 'image-1',
      type: 'image',
      title: 'Image',
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      status: 'ready',
      assetUrl: '/asset-a.png',
      parentIds: ['parent-1'],
    },
  ],
  tasks: [],
  selectedNodeId: 'image-1',
  selectedNodeIds: ['image-1'],
})

describe('canvasSnapshotModel', () => {
  it('normalizes current snapshots with v2 transform, fills, asset, and relations', () => {
    const snapshot = normalizeCanvasSnapshotV2(currentSnapshot())
    const node = snapshot.nodes[0]

    expect(snapshot).not.toBe(currentSnapshot)
    expect(snapshot.version).toBe(2)
    expect(node.transform).toEqual({ x: 10, y: 20, width: 300, height: 200, rotation: 0 })
    expect(node.fills).toEqual([
      {
        id: 'image-1-image-fill',
        kind: 'image',
        assetUrl: '/asset-a.png',
        opacity: 1,
        visible: true,
        scaleMode: 'fill',
      },
    ])
    expect(node.asset).toEqual({ url: '/asset-a.png' })
    expect(node.relations).toEqual({ parentIds: ['parent-1'] })
  })

  it('repairs stale v2 geometry and asset fields from legacy fields while preserving rotation', () => {
    const snapshot = normalizeCanvasSnapshotV2({
      ...currentSnapshot(),
      nodes: [
        {
          ...currentSnapshot().nodes[0],
          x: 44,
          y: 55,
          width: 111,
          height: 222,
          assetUrl: '/current.png',
          transform: { x: 1, y: 2, width: 3, height: 4, rotation: 18 },
          fills: [
            {
              id: 'stale-image-fill',
              kind: 'image',
              assetUrl: '/stale.png',
              opacity: 1,
              visible: true,
              scaleMode: 'fill',
            },
          ],
          asset: { url: '/stale.png' },
          relations: { parentIds: ['stale-parent'] },
        },
      ],
    })
    const node = snapshot.nodes[0]

    expect(node.transform).toEqual({ x: 44, y: 55, width: 111, height: 222, rotation: 18 })
    expect(node.fills?.[0]).toMatchObject({ assetUrl: '/current.png' })
    expect(node.asset).toEqual({ url: '/current.png' })
    expect(node.relations).toEqual({ parentIds: ['parent-1'] })
  })

  it('clones tasks and selection arrays', () => {
    const source = {
      ...currentSnapshot(),
      tasks: [{ id: 'task-1', label: 'Task', status: 'done' as const, progress: 100, nodeIds: ['image-1'] }],
    }
    const snapshot = normalizeCanvasSnapshotV2(source)

    expect(snapshot.tasks).not.toBe(source.tasks)
    expect(snapshot.tasks[0].nodeIds).not.toBe(source.tasks[0].nodeIds)
    expect(snapshot.selectedNodeIds).not.toBe(source.selectedNodeIds)
  })
})
