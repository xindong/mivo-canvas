import type { CanvasMaskBounds, CanvasTask, MivoCanvasNode } from './mivoCanvas'

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

export type CommittedGenerationKind = 'generate' | 'edit'

export type CommittedGenerationImage = {
  b64?: string
  blob?: Blob
  mimeType?: string
  title?: string
  width?: number
  height?: number
}

export type CommitGenerationResultPayload = {
  sourceNodeId?: string
  resultImages: CommittedGenerationImage[]
  prompt: string
  model: string
  kind: CommittedGenerationKind
  maskBounds?: CanvasMaskBounds
  taskId?: string
  placement?: 'right' | 'below' | 'left'
}
