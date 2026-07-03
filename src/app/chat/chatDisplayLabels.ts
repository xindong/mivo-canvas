export const modelDisplayLabel = (modelId: string) => {
  switch (modelId) {
    case 'gpt-image-2':
      return 'GPT Image 2'
    case 'gemini-3-pro-image':
      return 'Gemini 3 Pro'
    case 'doubao-seedance-2-0-260128':
      return 'Seedance 2.0'
    case 'doubao-seedance-2-0-fast-260128':
      return 'Seedance 2.0 Fast'
    default:
      return modelId
  }
}

export const modelShortLabel = (modelId: string) => {
  switch (modelId) {
    case 'gpt-image-2':
      return 'GPT'
    case 'gemini-3-pro-image':
      return 'Gemini'
    case 'doubao-seedance-2-0-260128':
      return 'Seedance'
    case 'doubao-seedance-2-0-fast-260128':
      return 'Seedance Fast'
    default:
      return modelDisplayLabel(modelId)
  }
}

export const qualityDisplayLabel = (quality: string) => {
  switch (quality) {
    case 'auto':
      return '自动'
    case 'low':
      return '低'
    case 'medium':
      return '中'
    case 'high':
      return '高'
    default:
      return quality
  }
}
