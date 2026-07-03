import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { GenerationAdapter, GenerationRequest } from '../types/generation'
import { createAiResultNode } from '../model/aiCanvasCommands'
import { realCaseImages } from './demoScenes'

const createVariantNode = (
  sourceNode: MivoCanvasNode,
  index: number,
  batchId: number,
): MivoCanvasNode =>
  createAiResultNode({
    id: `generated-${batchId}-${index}`,
    title: `Generated ${index + 1}`,
    sourceNodes: [sourceNode],
    anchorNode: sourceNode,
    operation: 'variation',
    prompt: sourceNode.generation?.prompt || '基于当前参考图继续发散 4 个方向',
    placement: 'right',
    position: {
      x: sourceNode.x + sourceNode.width + 90 + (index % 2) * 236,
      y: sourceNode.y + Math.floor(index / 2) * 404,
    },
    size: { width: 204, height: 362 },
    assetUrl: realCaseImages[index % realCaseImages.length],
    createdAt: batchId * 1000 + index,
    taskId: `task-${batchId}`,
    model: sourceNode.generation?.model || 'Mivo Character v3',
    strength: 0.58,
    groupId: `generated-${batchId}`,
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
