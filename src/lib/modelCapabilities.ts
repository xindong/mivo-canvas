import type { GenerationRatio, MivoImageQuality } from '../types/generation'

export type ModelModality = 'image' | 'video'
export type ModelAvailability = 'ok' | 'unavailable'

export type ModelCapabilities = {
  modality: ModelModality
  ratios: GenerationRatio[]
  qualities: MivoImageQuality[]
  defaultRatio: GenerationRatio
  availability: ModelAvailability
  unavailableReason?: string
}

// SYNC NOTE: ratio/availability data is also inlined in vite.config.ts (server-side).
// If you change entries here, update the inline copy in vite.config.ts too.
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'gpt-image-2': {
    modality: 'image',
    ratios: ['1:1', '2:3', '3:2', '9:16', '16:9'],
    qualities: ['low', 'medium', 'high'],
    defaultRatio: '1:1',
    availability: 'ok',
  },
  'gemini-3-pro-image': {
    modality: 'image',
    ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '5:4', '4:5'],
    qualities: ['low', 'medium', 'high'],
    defaultRatio: '1:1',
    availability: 'ok',
  },
  'doubao-seedance-2-0-260128': {
    modality: 'video',
    ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
    qualities: ['medium'],
    defaultRatio: '16:9',
    availability: 'unavailable',
    unavailableReason: 'llm-proxy 未暴露视频生成端点',
  },
  'doubao-seedance-2-0-fast-260128': {
    modality: 'video',
    ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
    qualities: ['medium'],
    defaultRatio: '16:9',
    availability: 'unavailable',
    unavailableReason: 'llm-proxy 未暴露视频生成端点',
  },
}

export const getModelCapabilities = (modelId: string): ModelCapabilities =>
  MODEL_CAPABILITIES[modelId] ?? MODEL_CAPABILITIES['gpt-image-2']
