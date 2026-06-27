import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { GenerationAdapter, GenerationRequest } from '../types/generation'
import { makeNode, realCaseImages } from './demoScenes'

const createVariantNode = (
  sourceNode: MivoCanvasNode,
  index: number,
  batchId: number,
): MivoCanvasNode =>
  makeNode({
    id: `generated-${batchId}-${index}`,
    title: `Generated ${index + 1}`,
    x: sourceNode.x + sourceNode.width + 90 + (index % 2) * 236,
    y: sourceNode.y + Math.floor(index / 2) * 404,
    width: 204,
    height: 362,
    assetUrl: realCaseImages[index % realCaseImages.length],
    parentIds: [sourceNode.id],
    groupId: `generated-${batchId}`,
    generation: {
      prompt: sourceNode.generation?.prompt || '基于当前参考图继续发散 4 个方向',
      model: sourceNode.generation?.model || 'Mivo Character v3',
      size: sourceNode.generation?.size || '1024x1365',
      seed: batchId * 1000 + index,
      strength: 0.58,
    },
    aiWorkflow: {
      kind: 'result',
      status: 'ready',
      operation: 'variation',
      prompt: sourceNode.generation?.prompt || '基于当前参考图继续发散 4 个方向',
      sourceNodeIds: [sourceNode.id],
      anchorNodeId: sourceNode.id,
      placement: 'right',
      createdAt: batchId,
    },
  })

const generateMockVariations = ({ sourceNode, count, batchId }: GenerationRequest) => {
  const nodes = Array.from({ length: count }, (_, index) =>
    createVariantNode(sourceNode, index, batchId),
  )

  return {
    nodes,
    task: {
      id: `task-${batchId}`,
      label: `基于 ${sourceNode.title} 生成 ${count} 个变体`,
      status: 'done' as const,
      progress: 100,
      nodeIds: nodes.map((node) => node.id),
    },
  }
}

export const mockGenerationAdapter: GenerationAdapter = {
  generateVariations: generateMockVariations,
}
