export type AssetSourceId = 'local' | 'eagle' | 'pinterest'

export type AssetItem = {
  id: string
  sourceId: AssetSourceId
  sourceLabel: string
  name: string
  title: string
  format: string
  sizeBytes: number
  sourcePath: string
  updatedAt: number
  url: string
  thumbnailUrl?: string
  width?: number
  height?: number
  tags?: string[]
  folders?: string[]
  sourceUrl?: string
  annotation?: string
}

export type CanvasAssetClipboardItem = Pick<
  AssetItem,
  | 'id'
  | 'sourceId'
  | 'name'
  | 'title'
  | 'url'
  | 'thumbnailUrl'
  | 'width'
  | 'height'
  | 'sourcePath'
  | 'tags'
>

export type EagleTagItem = {
  id: string
  name: string
  count?: number
}

export type AssetSource = {
  id: AssetSourceId
  label: string
  description: string
  meta: string
  status: string
}

export type LocalAssetResponse = {
  root: string
  assets: Omit<AssetItem, 'sourceId' | 'sourceLabel'>[]
}

export type EagleFolder = {
  id: string
  name: string
  children?: EagleFolder[]
}

export type EagleStatus = {
  connected: boolean
  version?: string
  folderCount?: number
  libraryPath?: string
  message?: string
}

export type EagleAssetsResponse = {
  assets: Omit<AssetItem, 'sourceId' | 'sourceLabel'>[]
}

export type EagleTagsResponse = {
  tags: EagleTagItem[]
}

export type EagleFoldersResponse = {
  folders: EagleFolder[]
}

export type PinterestStatus = {
  connected: boolean
  mode: 'prototype'
}

export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent

  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

export const dimensionsLabel = (dimensions?: { width: number; height: number }) =>
  dimensions ? `${dimensions.width} x ${dimensions.height}` : 'Reading size'

export const thumbnailUrlFor = (asset: AssetItem) => asset.thumbnailUrl || asset.url

export const assetMatchesQuery = (asset: AssetItem, query: string) => {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true

  return [
    asset.name,
    asset.title,
    asset.format,
    asset.sourcePath,
    asset.sourceUrl || '',
    asset.annotation || '',
    ...(asset.tags || []),
  ].some((value) => value.toLowerCase().includes(normalizedQuery))
}

export const flattenEagleFolders = (folders: EagleFolder[], depth = 0): Array<EagleFolder & { depth: number }> =>
  folders.flatMap((folder) => [
    { ...folder, depth },
    ...flattenEagleFolders(folder.children || [], depth + 1),
  ])
