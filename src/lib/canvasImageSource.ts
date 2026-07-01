import type { MivoCanvasNode } from '../types/mivoCanvas'
import { readImportedAssetFile } from './assetStorage'

const safeImageName = (node: MivoCanvasNode) => {
  const baseName = node.assetOriginalName || node.title || 'source-image'
  return /\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}.png`
}

export const readCanvasImageBlob = async (node: MivoCanvasNode, resolvedAssetUrl?: string) => {
  const importedAsset = await readImportedAssetFile(node.assetUrl)
  if (importedAsset) {
    return new File([importedAsset.blob], importedAsset.name || safeImageName(node), {
      type: importedAsset.type || node.assetMimeType || importedAsset.blob.type || 'image/png',
    })
  }

  const url = resolvedAssetUrl || node.assetUrl
  if (!url) throw new Error('Unable to read source image for generation')

  const response = await fetch(url)
  if (!response.ok) throw new Error('Unable to read source image for generation')
  const blob = await response.blob()
  return new File([blob], safeImageName(node), {
    type: blob.type || node.assetMimeType || 'image/png',
  })
}
