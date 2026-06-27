import type { MivoCanvasNode } from '../types/mivoCanvas'
import { isImportedAssetUrl, readImportedAssetFile } from './assetStorage'

const extensionForType = (type?: string) => {
  if (!type) return ''
  if (type.includes('jpeg')) return '.jpg'
  if (type.includes('png')) return '.png'
  if (type.includes('webp')) return '.webp'
  if (type.includes('gif')) return '.gif'
  if (type.includes('svg')) return '.svg'
  return ''
}

const cleanFilename = (name: string) =>
  name
    .trim()
    .replace(/[/:*?"<>|\\]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120)

const filenameFromUrl = (assetUrl: string) => {
  try {
    const url = new URL(assetUrl, window.location.href)
    const lastSegment = url.pathname.split('/').filter(Boolean).at(-1)
    return lastSegment ? decodeURIComponent(lastSegment) : undefined
  } catch {
    return undefined
  }
}

const filenameFor = (node: MivoCanvasNode, type?: string) => {
  const sourceName = node.assetUrl ? filenameFromUrl(node.assetUrl) : undefined
  const name = cleanFilename(sourceName || node.title || 'mivo-image')
  const hasExtension = /\.[a-z0-9]{2,8}$/i.test(name)

  return hasExtension ? name : `${name}${extensionForType(type)}`
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export const downloadCanvasNodeOriginal = async (node: MivoCanvasNode) => {
  if (!node.assetUrl) return

  if (isImportedAssetUrl(node.assetUrl)) {
    const asset = await readImportedAssetFile(node.assetUrl)
    if (!asset) return

    downloadBlob(asset.blob, cleanFilename(asset.name) || filenameFor(node, asset.type))
    return
  }

  const response = await fetch(node.assetUrl)
  if (!response.ok) return

  const blob = await response.blob()
  downloadBlob(blob, filenameFor(node, blob.type))
}
