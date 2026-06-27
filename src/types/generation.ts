import type { CanvasTask, MivoCanvasNode } from './mivoCanvas'

export type GenerationRequest = {
  sourceNode: MivoCanvasNode
  count: number
  batchId: number
}

export type GenerationResult = {
  nodes: MivoCanvasNode[]
  task: CanvasTask
}

export type GenerationAdapter = {
  generateVariations: (request: GenerationRequest) => GenerationResult
}
