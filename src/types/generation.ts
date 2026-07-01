import type { CanvasMaskBounds, CanvasTask, MivoCanvasNode } from './mivoCanvas'

export type MivoImageRatio = '1:1' | '3:2' | '2:3' | '16:9' | '9:16'
export type MivoImageQuality = 'low' | 'medium' | 'high'

export type MivoGenerateRequest = {
  prompt: string
  imgRatio?: MivoImageRatio
  quality?: MivoImageQuality
  n?: number
  model?: string
}

export type MivoEditRequest = MivoGenerateRequest & {
  image: Blob
  mask?: Blob
  reference?: Blob[]
}

export type MivoImageResponse = {
  images: Array<{ b64: string }>
}

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
