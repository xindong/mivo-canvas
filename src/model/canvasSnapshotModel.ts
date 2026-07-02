import type { CanvasEdge, CanvasTask, MivoCanvasNode, MivoCanvasSnapshot } from '../types/mivoCanvas'
import { normalizeCanvasNodeV2 } from './documentModelV2'

const cloneTask = (task: CanvasTask): CanvasTask => ({
  ...task,
  nodeIds: [...task.nodeIds],
})

const normalizeNodeForSnapshot = (node: MivoCanvasNode): MivoCanvasNode => {
  const rotation = node.transform?.rotation ?? 0

  return normalizeCanvasNodeV2({
    ...node,
    transform: {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation,
    },
    fills: undefined,
    strokes: undefined,
    asset: undefined,
    relations: undefined,
  })
}

export const normalizeCanvasSnapshotV2 = (snapshot: MivoCanvasSnapshot): MivoCanvasSnapshot => ({
  version: 2,
  sceneId: snapshot.sceneId,
  nodes: snapshot.nodes.map(normalizeNodeForSnapshot),
  edges: snapshot.edges ? snapshot.edges.map((edge: CanvasEdge) => ({ ...edge })) : [],
  tasks: snapshot.tasks.map(cloneTask),
  selectedNodeId: snapshot.selectedNodeId,
  selectedNodeIds: snapshot.selectedNodeIds ? [...snapshot.selectedNodeIds] : undefined,
})
