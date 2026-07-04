import type { CanvasMaskBounds } from './mivoCanvas'
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
  // P2-C2: annotation area-edit — when maskBounds (+ sourceSize) is present and
  // `mask` is absent, the BFF generates the mask PNG. Mutually exclusive with
  // `mask` in practice (brush mask vs bounds-derived mask).
  maskBounds?: NormalizedMaskBounds
  sourceSize?: { width: number; height: number }
}

export type MivoImageResponse = {
  images: Array<{ b64: string }>
}

// P2-C2: normalized 0-1 mask bounds (relative to the source image's natural pixel
// grid). The client derives this from an annotation node's canvas-coordinate
// annotationBounds; the BFF synthesizes the area mask PNG from it (see
// server/lib/maskPng.ts).
export type NormalizedMaskBounds = { x: number; y: number; width: number; height: number }

// P2-C2: one variation in a variations batch. Each becomes a parallel llm-proxy
// /edits call sharing the source image. All fields optional — the action fills
// sensible defaults from the source node when omitted.
export type VariationParam = {
  prompt?: string
  imgRatio?: GenerationRatio
  quality?: MivoImageQuality
  model?: string
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
  // S07: previously smuggled via `as` in documentSlice — now declared on the
  // payload type. replaceSlotId swaps an existing ai-slot in place; lineageSourceId
  // overrides the derivation-edge source (defaults to sourceNodeId); reflow pushes
  // right-side obstacles after placing the result.
  replaceSlotId?: string
  lineageSourceId?: string
  reflow?: boolean
  createDerivationEdge?: boolean
  resultImages: CommittedGenerationImage[]
  prompt: string
  model: string
  kind: CommittedGenerationKind
  maskBounds?: CanvasMaskBounds
  taskId?: string
  placement?: 'right' | 'below' | 'left'
}
