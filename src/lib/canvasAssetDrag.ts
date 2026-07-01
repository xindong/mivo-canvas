export const localAssetDragType = 'application/x-mivo-local-asset'

export type LocalAssetDragPayload = {
  id?: string
  name: string
  title?: string
  url: string
  sourcePath?: string
  tags?: string[]
  width?: number
  height?: number
}

const dataTransferTypes = (dataTransfer: DataTransfer) => Array.from(dataTransfer.types || [])

export const canReadLocalAssetDrag = (dataTransfer: DataTransfer) =>
  dataTransferTypes(dataTransfer).includes(localAssetDragType)

export const parseLocalAssetDragPayload = (dataTransfer: DataTransfer): LocalAssetDragPayload | undefined => {
  const rawPayload = dataTransfer.getData(localAssetDragType)
  if (!rawPayload) return undefined

  try {
    const payload = JSON.parse(rawPayload) as Partial<LocalAssetDragPayload>
    if (!payload.name || !payload.url) return undefined
    return {
      id: payload.id,
      name: payload.name,
      title: payload.title,
      url: payload.url,
      sourcePath: payload.sourcePath,
      tags: Array.isArray(payload.tags) ? payload.tags : undefined,
      width: payload.width,
      height: payload.height,
    }
  } catch {
    return undefined
  }
}

export const writeLocalAssetDragPayload = (dataTransfer: DataTransfer, payload: LocalAssetDragPayload) => {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(localAssetDragType, JSON.stringify(payload))
  dataTransfer.setData('text/plain', payload.title || payload.name)
}
