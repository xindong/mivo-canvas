import type { MivoCanvasNode } from '../types/mivoCanvas'
import { readImportedAssetFile } from './assetStorage'

const safeImageName = (node: MivoCanvasNode) => {
  const baseName = node.assetOriginalName || node.title || 'source-image'
  return /\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}.png`
}

// W1: 生成结果（kind='result'）可能是透明 PNG —— 透明区在 PNG 编码下 RGB 常为 0
// （黑），直接送上游 mask-edit 会被当黑源处理，结果图该区易出黑盘。对 result kind
// 且实测 alpha<255 的图，先 flatten 到白底再送上游。非 result kind（用户导入的源图）
// 透明语义不变，不触发解码。
const flattenAlphaToWhiteIfNeeded = async (file: File, node: MivoCanvasNode): Promise<File> => {
  if (node.aiWorkflow?.kind !== 'result') return file
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close?.(); return file }
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let hasTranslucent = false
    for (let i = 3; i < imageData.data.length; i += 4) {
      if (imageData.data[i] < 255) { hasTranslucent = true; break }
    }
    if (!hasTranslucent) { bitmap.close?.(); return file }
    // flatten: 白底 + 重绘源图（source-over 合成，透明区被白底填充）
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    const mime = file.type || 'image/png'
    const flattened: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, mime))
    return new File([flattened || file], file.name, { type: mime })
  } catch {
    return file // 解码失败 → 保守返回原 file，不阻断生成
  }
}

const readSourceImageFile = async (node: MivoCanvasNode, resolvedAssetUrl?: string): Promise<File> => {
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

export const readCanvasImageBlob = async (node: MivoCanvasNode, resolvedAssetUrl?: string) => {
  const file = await readSourceImageFile(node, resolvedAssetUrl)
  return flattenAlphaToWhiteIfNeeded(file, node)
}
