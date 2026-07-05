import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import { readImportedAssetFile } from './assetStorage'

const safeImageName = (node: MivoCanvasNode) => {
  const baseName = node.assetOriginalName || node.title || 'source-image'
  return /\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}.png`
}

// W1/黑块修复: 生成结果（kind='result'）作为二次编辑源图时，**无条件** canonicalize
// —— 即使实测 alpha 已全 255 也重编码：decode → 白底填充 → drawImage → 校验输出
// alpha 全 255 → 导出 image/png。产品链路对生成结果 bytes 原样透传不重编码
// （canvasStore b64→Blob → assetStorage 不重编码 → readCanvasImageBlob 读回 →
// multipart 原样上行），上游对非 canonical PNG chunk / color profile / 隐藏通道
// 疑似触发整片压黑（黑块高发在二次重绘），统一重编码把这些差异一起消掉。
// 非 result kind（用户导入的源图）透明语义不变，不触发解码。
// 解码/导出失败走 debugLogger.warn 后返回原 file，不静默、不阻断生成。
const normalizeGeneratedResultForEdit = async (file: File, node: MivoCanvasNode): Promise<File> => {
  if (node.aiWorkflow?.kind !== 'result') return file
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      debugLogger.warn('Canvas', `Result source normalize skipped for ${file.name}: no 2d context; sending original`)
      return file
    }
    // flatten: 白底 + 重绘源图（source-over 合成，透明区被白底填充）
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    // 校验输出 alpha 全 255。白底 + source-over 数学上已保证不透明，此处防御性兜底
    // （异常合成实现 / 极端 color profile），仍有 alpha<255 则强制置 255 并告警。
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let translucent = 0
    for (let i = 3; i < imageData.data.length; i += 4) {
      if (imageData.data[i] < 255) {
        imageData.data[i] = 255
        translucent++
      }
    }
    if (translucent > 0) {
      ctx.putImageData(imageData, 0, 0)
      debugLogger.warn(
        'Canvas',
        `Result source normalize forced ${translucent} residual translucent pixel(s) opaque for ${file.name}`,
      )
    }
    const flattened: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!flattened) {
      debugLogger.warn('Canvas', `Result source normalize failed for ${file.name}: PNG export returned null; sending original`)
      return file
    }
    return new File([flattened], file.name, { type: 'image/png' })
  } catch (error) {
    debugLogger.warn(
      'Canvas',
      `Result source normalize failed for ${file.name}: ${error instanceof Error ? error.message : String(error)}; sending original`,
    )
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
  return normalizeGeneratedResultForEdit(file, node)
}
