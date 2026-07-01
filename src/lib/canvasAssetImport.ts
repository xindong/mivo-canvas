import type { ImageDimensions, ImportedImageMetadata } from './imageSizing'
import { importedImageDisplaySize } from './imageSizing'
import { saveImportedAsset } from './assetStorage'
import { debugLogger } from '../store/debugLogStore'
import type { CanvasAssetNodeType } from '../types/mivoCanvas'

export type AddImportedImage = (
  assetUrl: string,
  title?: string,
  size?: string,
  position?: { x: number; y: number },
  metadata?: ImportedImageMetadata,
) => void

export type ImportedFileMetadata = ImportedImageMetadata & {
  mimeType?: string
  originalName?: string
  sizeBytes?: number
  text?: string
}

export type AddImportedFileNode = (
  type: CanvasAssetNodeType,
  assetUrl: string,
  title?: string,
  size?: string,
  position?: { x: number; y: number },
  metadata?: ImportedFileMetadata,
) => void

export type CanvasImageImportSource = {
  file: File
  position: { x: number; y: number }
  offset?: number
  addImportedImage: AddImportedImage
}

export type CanvasFileImportSource = {
  file: File
  position: { x: number; y: number }
  offset?: number | { x: number; y: number }
  addImportedFileNode: AddImportedFileNode
}

type PreparedCanvasFileImport = {
  type: CanvasAssetNodeType
  asset: Awaited<ReturnType<typeof saveImportedAsset>>
  displaySize: { width: number; height: number }
  sizeLabel: string
  metadata: ImportedFileMetadata
}

const extensionMimeMap: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  markdown: 'text/markdown',
  md: 'text/markdown',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  webm: 'video/webm',
  webp: 'image/webp',
}

const mimeFromFilename = (filename: string) => {
  const extension = filename.split('.').pop()?.toLowerCase() || ''
  return extensionMimeMap[extension] || 'application/octet-stream'
}

const markdownFilePattern = /\.(md|markdown)$/i
const imageFilePattern = /\.(png|jpe?g|webp|gif|svg)$/i
const pdfFilePattern = /\.pdf$/i
const videoFilePattern = /\.(mp4|m4v|mov|webm)$/i

export const canvasAssetNodeTypeForFile = (file: File): CanvasAssetNodeType | undefined => {
  const mimeType = file.type || mimeFromFilename(file.name)

  if (mimeType.startsWith('image/') || imageFilePattern.test(file.name)) return 'image'
  if (mimeType === 'text/markdown' || markdownFilePattern.test(file.name)) return 'markdown'
  if (mimeType === 'application/pdf' || pdfFilePattern.test(file.name)) return 'pdf'
  if (mimeType.startsWith('video/') || videoFilePattern.test(file.name)) return 'video'

  return undefined
}

export const canImportCanvasFile = (file: File) => Boolean(canvasAssetNodeTypeForFile(file))

const markdownTextFor = async (file: File, type: CanvasAssetNodeType) => {
  if (type !== 'markdown') return undefined

  try {
    return await file.text()
  } catch {
    return ''
  }
}

export const markdownDocumentWidth = 560
export const markdownPreviewHeight = 620
export const markdownShouldUsePreviewMode = (text?: string) => {
  const source = text || ''
  const lines = source.split(/\r?\n/)
  const imageCount = lines.filter((line) => /^\s*!\[/.test(line) || /<img\b/i.test(line)).length

  return source.length > 3500 || lines.length > 60 || imageCount > 4
}

const markdownDocumentSizeFor = (text?: string) => {
  const width = markdownDocumentWidth
  if (markdownShouldUsePreviewMode(text)) {
    return { width, height: markdownPreviewHeight }
  }

  const charsPerLine = 58
  const lines = (text || '').split(/\r?\n/)
  let height = 96
  let inCode = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line.startsWith('```')) {
      inCode = !inCode
      height += 24
      continue
    }

    if (!line) {
      height += 10
      continue
    }

    if (inCode) {
      height += 22
      continue
    }

    if (/^#{1}\s+/.test(line)) {
      height += 48
      continue
    }

    if (/^#{2}\s+/.test(line)) {
      height += 38
      continue
    }

    if (/^#{3,6}\s+/.test(line)) {
      height += 32
      continue
    }

    if (/^\|.*\|$/.test(line)) {
      height += /^(\|\s*:?-+:?\s*)+\|?$/.test(line) ? 0 : 34
      continue
    }

    const wrappedLines = Math.max(1, Math.ceil(line.length / charsPerLine))
    height += wrappedLines * 23 + 5
  }

  return {
    width,
    height: Math.max(320, Math.min(5200, Math.round(height))),
  }
}

const videoDimensionsFor = async (file: File, type: CanvasAssetNodeType): Promise<ImageDimensions | undefined> => {
  if (type !== 'video') return undefined

  const url = URL.createObjectURL(file)

  return new Promise((resolve) => {
    const video = document.createElement('video')
    let settled = false
    const settle = (dimensions?: ImageDimensions) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(dimensions)
    }

    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.onloadedmetadata = () => {
      settle(
        video.videoWidth > 0 && video.videoHeight > 0
          ? {
              width: video.videoWidth,
              height: video.videoHeight,
            }
          : undefined,
      )
    }
    video.onerror = () => settle()
    window.setTimeout(() => settle(), 2200)
    video.src = url
    video.load()
  })
}

const defaultDisplaySizeFor = (type: CanvasAssetNodeType, dimensions?: ImportedImageMetadata['dimensions']) => {
  if (type === 'image' || type === 'video') {
    return dimensions ? importedImageDisplaySize(dimensions) : type === 'video' ? { width: 420, height: 236 } : importedImageDisplaySize()
  }
  if (type === 'pdf') return { width: 340, height: 440 }
  if (type === 'markdown') return { width: 560, height: 320 }
  return { width: 360, height: 280 }
}

const sizeLabelFor = (
  type: CanvasAssetNodeType,
  asset: Awaited<ReturnType<typeof saveImportedAsset>>,
  markdownText?: string,
  dimensions?: ImageDimensions,
) => {
  if (type === 'image') return asset.size
  if (type === 'markdown') return `${markdownText?.length || 0} chars`
  if (type === 'pdf') return 'PDF'
  if (type === 'video') return dimensions ? `${dimensions.width}x${dimensions.height}` : 'video'
  return 'source'
}

const prepareCanvasFileImport = async (file: File): Promise<PreparedCanvasFileImport | undefined> => {
  const type = canvasAssetNodeTypeForFile(file)
  if (!type) {
    debugLogger.warn('Canvas Import', `Unsupported file skipped: ${file.name}`)
    return undefined
  }

  const asset = await saveImportedAsset(file)
  const text = await markdownTextFor(file, type)
  const videoDimensions = await videoDimensionsFor(file, type)
  const sourceDimensions = videoDimensions || asset.sourceDimensions
  const dimensions = videoDimensions || asset.dimensions
  const displaySize = type === 'markdown' ? markdownDocumentSizeFor(text) : defaultDisplaySizeFor(type, dimensions)

  return {
    type,
    asset,
    displaySize,
    sizeLabel: sizeLabelFor(type, asset, text, sourceDimensions),
    metadata: {
      ...asset,
      mimeType: asset.type,
      originalName: asset.name,
      sizeBytes: asset.sizeBytes,
      text,
      dimensions,
      sourceDimensions,
    },
  }
}

const addPreparedImportToCanvas = (
  prepared: PreparedCanvasFileImport,
  position: { x: number; y: number },
  addImportedFileNode: AddImportedFileNode,
) => {
  addImportedFileNode(
    prepared.type,
    prepared.asset.assetUrl,
    prepared.asset.title,
    prepared.sizeLabel,
    position,
    prepared.metadata,
  )
}

export const importFileToCanvas = async ({
  file,
  position,
  offset = 0,
  addImportedFileNode,
}: CanvasFileImportSource) => {
  const prepared = await prepareCanvasFileImport(file)
  if (!prepared) return undefined
  const offsetPoint = typeof offset === 'number' ? { x: offset, y: offset } : offset || { x: 0, y: 0 }

  addPreparedImportToCanvas(
    prepared,
    {
      x: position.x - prepared.displaySize.width / 2 + offsetPoint.x,
      y: position.y - prepared.displaySize.height / 2 + offsetPoint.y,
    },
    addImportedFileNode,
  )

  debugLogger.log('Canvas Import', `Imported file: ${file.name}`)
  return prepared.asset
}

export const importImageFileToCanvas = async ({
  file,
  position,
  offset = 0,
  addImportedImage,
}: CanvasImageImportSource) => {
  const asset = await saveImportedAsset(file)
  const displaySize = importedImageDisplaySize(asset.dimensions)

  addImportedImage(
    asset.assetUrl,
    asset.title,
    asset.size,
    {
      x: position.x - displaySize.width / 2 + offset,
      y: position.y - displaySize.height / 2 + offset,
    },
    asset,
  )

  debugLogger.log('Canvas Import', `Imported image file: ${file.name}`)
  return asset
}

export const importImageFilesToCanvas = async (
  files: File[],
  position: { x: number; y: number },
  addImportedImage: AddImportedImage,
) => {
  const imageFiles = files.filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name))
  const skippedCount = files.length - imageFiles.length
  if (skippedCount) debugLogger.warn('Canvas Import', `Skipped ${skippedCount} non-image file${skippedCount === 1 ? '' : 's'}`)

  for (const [index, file] of imageFiles.entries()) {
    await importImageFileToCanvas({
      file,
      position,
      offset: index * 28,
      addImportedImage,
    })
  }

  debugLogger.log('Canvas Import', `Imported ${imageFiles.length} image file${imageFiles.length === 1 ? '' : 's'}`)
  return imageFiles.length
}

export const importFilesToCanvas = async (
  files: File[],
  position: { x: number; y: number },
  addImportedFileNode: AddImportedFileNode,
) => {
  const supportedFiles = files.filter(canImportCanvasFile)
  const skippedCount = files.length - supportedFiles.length
  if (skippedCount) debugLogger.warn('Canvas Import', `Skipped ${skippedCount} unsupported file${skippedCount === 1 ? '' : 's'}`)
  const preparedFiles = (await Promise.all(supportedFiles.map(prepareCanvasFileImport))).filter(
    (prepared): prepared is PreparedCanvasFileImport => Boolean(prepared),
  )
  const rowGap = 56
  const columnGap = 56
  const maxRowWidth = 860
  const rows: Array<{
    items: PreparedCanvasFileImport[]
    width: number
    height: number
  }> = []

  preparedFiles.forEach((prepared) => {
    const currentRow = rows.at(-1)
    const nextWidth = currentRow
      ? currentRow.width + columnGap + prepared.displaySize.width
      : prepared.displaySize.width

    if (currentRow && nextWidth <= maxRowWidth) {
      currentRow.items.push(prepared)
      currentRow.width = nextWidth
      currentRow.height = Math.max(currentRow.height, prepared.displaySize.height)
      return
    }

    rows.push({
      items: [prepared],
      width: prepared.displaySize.width,
      height: prepared.displaySize.height,
    })
  })

  let rowTop = position.y - (rows[0]?.height || 0) / 2

  rows.forEach((row) => {
    let itemLeft = position.x - row.width / 2

    row.items.forEach((prepared) => {
      addPreparedImportToCanvas(
        prepared,
        {
          x: itemLeft,
          y: rowTop + (row.height - prepared.displaySize.height) / 2,
        },
        addImportedFileNode,
      )
      itemLeft += prepared.displaySize.width + columnGap
    })

    rowTop += row.height + rowGap
  })

  debugLogger.log('Canvas Import', `Imported ${preparedFiles.length} canvas file${preparedFiles.length === 1 ? '' : 's'}`)
  return preparedFiles.length
}

export const fileFromImageUrl = async (url: string, filename: string) => {
  const response = await fetch(url)
  if (!response.ok) {
    debugLogger.error('Canvas Import', `Unable to import image source ${filename}: ${response.status}`)
    throw new Error(`Unable to import image source: ${response.status}`)
  }

  const blob = await response.blob()
  debugLogger.log('Canvas Import', `Fetched image source: ${filename}`)
  return new File([blob], filename, {
    type: blob.type || mimeFromFilename(filename),
  })
}

export const importImageUrlToCanvas = async (
  url: string,
  filename: string,
  position: { x: number; y: number },
  addImportedImage: AddImportedImage,
) => {
  const file = await fileFromImageUrl(url, filename)

  return importImageFileToCanvas({
    file,
    position,
    addImportedImage,
  })
}
