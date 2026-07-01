import type {
  AiWorkflowOperation,
  AiWorkflowPlacement,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import { normalizeCanvasNodeV2, setNodeAsset, setNodeRelations } from './documentModelV2'

export type CreateAiResultNodeInput = {
  id: string
  title: string
  sourceNodes: MivoCanvasNode[]
  anchorNode: MivoCanvasNode
  annotationNode?: MivoCanvasNode
  slotNode?: MivoCanvasNode
  operation: AiWorkflowOperation
  prompt: string
  placement: AiWorkflowPlacement
  position: { x: number; y: number }
  size: { width: number; height: number }
  assetUrl: string
  createdAt: number
  taskId: string
  model?: string
  strength?: number
  groupId?: string
}

const uniqueIds = (nodes: Array<MivoCanvasNode | undefined>) => {
  const ids = nodes.map((node) => node?.id).filter((id): id is string => Boolean(id))
  return Array.from(new Set(ids))
}

export const createAiResultNode = ({
  id,
  title,
  sourceNodes,
  anchorNode,
  annotationNode,
  slotNode,
  operation,
  prompt,
  placement,
  position,
  size,
  assetUrl,
  createdAt,
  taskId,
  model = 'Mivo Mock Image Workflow',
  strength,
  groupId,
}: CreateAiResultNodeInput): MivoCanvasNode => {
  const sourceNodeIds = uniqueIds(sourceNodes)
  const parentIds = uniqueIds([...sourceNodes, annotationNode, slotNode])
  const aiWorkflow = {
    kind: 'result' as const,
    status: 'ready' as const,
    operation,
    prompt,
    sourceNodeIds,
    anchorNodeId: anchorNode.id,
    annotationNodeId: annotationNode?.id,
    slotId: slotNode?.id,
    placement,
    createdAt,
  }
  const normalized = normalizeCanvasNodeV2({
    id,
    type: 'image',
    title,
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: Math.round(size.width),
    height: Math.round(size.height),
    assetUrl,
    status: 'ready',
    parentIds,
    groupId,
    generation: {
      prompt,
      model,
      size: `${Math.round(size.width)}x${Math.round(size.height)}`,
      seed: createdAt % 99999,
      strength,
      taskId,
    },
    aiWorkflow,
  })

  return setNodeRelations(setNodeAsset(normalized, { url: assetUrl }), {
    parentIds,
    aiWorkflow,
  })
}
