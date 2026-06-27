export type ImageDimensions = {
  width: number
  height: number
}

export type ImportedImageMetadata = {
  dimensions?: ImageDimensions
  sourceDimensions?: ImageDimensions
  hasTransparency?: boolean
}

const fallbackImportedImageSize = {
  width: 230,
  height: 302,
}

const maxImportedImageEdge = 360
const minImportedImageEdge = 96

export const importedImageDisplaySize = (dimensions?: ImageDimensions) => {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return fallbackImportedImageSize
  }

  const longestEdge = Math.max(dimensions.width, dimensions.height)
  const scale = Math.min(maxImportedImageEdge / longestEdge, Math.max(1, minImportedImageEdge / longestEdge))

  return {
    width: Math.round(dimensions.width * scale),
    height: Math.round(dimensions.height * scale),
  }
}
