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

  // W3: external/cross-origin images fail the direct fetch with a TypeError
  // ("Failed to fetch") due to CORS. Fall back to the BFF CORS proxy; if that
  // also fails, surface a Chinese actionable error so the user knows to import
  // the image locally instead of hot-linking.
  const isHttpUrl = url.startsWith('http://') || url.startsWith('https://')
  const proxyUrl = isHttpUrl ? `/api/mivo/proxy-image?url=${encodeURIComponent(url)}` : null
  const externalImageMessage = '无法读取外链图片，请下载后重新导入'

  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    // TypeError = network/CORS failure. Only retry via proxy for http(s) URLs.
    if (proxyUrl && error instanceof TypeError) {
      try {
        response = await fetch(proxyUrl)
      } catch (proxyError) {
        throw new Error(externalImageMessage, { cause: proxyError })
      }
    } else {
      throw new Error(externalImageMessage, { cause: error })
    }
  }
  if (!response.ok) {
    // !ok from the direct fetch (e.g. 403 CORS preflight) → try proxy once.
    if (proxyUrl) {
      try {
        const proxied = await fetch(proxyUrl)
        if (proxied.ok) {
          const blob = await proxied.blob()
          return new File([blob], safeImageName(node), {
            type: blob.type || node.assetMimeType || 'image/png',
          })
        }
      } catch {
        // fall through to the Chinese error below
      }
    }
    throw new Error(externalImageMessage, { cause: `direct fetch status ${response.status}` })
  }
  const blob = await response.blob()
  return new File([blob], safeImageName(node), {
    type: blob.type || node.assetMimeType || 'image/png',
  })
}
