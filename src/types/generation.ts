import type { CanvasMaskBounds, CanvasTask, MivoCanvasNode } from './mivoCanvas'
import type { CanvasId } from './mivoCanvas'

export type MivoImageRatio = '1:1' | '3:2' | '2:3' | '16:9' | '9:16'
export type MivoImageQuality = 'low' | 'medium' | 'high'

export type GenerationRatio = MivoImageRatio | '3:4' | '4:3' | '21:9' | '5:4' | '4:5'

export type EnhanceRequest = {
  prompt: string
  modelId?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  hasSelectedImage?: boolean
  sceneId?: string
  signal?: AbortSignal
}

export type EnhanceResponse = {
  enhanced: boolean
  mode?: 'chat' | 'generate'
  replyText?: string
  scene?: string
  reasoning?: string
  richPrompt?: string
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  degradedReason?: 'timeout' | 'bad-json' | 'no-key' | 'upstream-error'
}

export type MivoGenerateRequest = {
  prompt: string
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  n?: number
  model?: string
  signal?: AbortSignal
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
  sceneId?: CanvasId
  sourceNodeId?: string
  createDerivationEdge?: boolean
  resultImages: CommittedGenerationImage[]
  prompt: string
  model: string
  kind: CommittedGenerationKind
  maskBounds?: CanvasMaskBounds
  taskId?: string
  placement?: 'right' | 'below' | 'left'
}
