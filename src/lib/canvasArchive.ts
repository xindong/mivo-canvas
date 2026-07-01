import type { MivoCanvasSnapshot } from '../types/mivoCanvas'
import { normalizeCanvasSnapshotV2 } from '../model/canvasSnapshotModel'
import {
  isImportedAssetUrl,
  restoreSerializedAsset,
  serializeImportedAsset,
  type SerializedCanvasAsset,
} from './assetStorage'
import type { ParsedCanvasImport } from './snapshotValidation'

export type MivoCanvasArchive = {
  kind: 'mivo-canvas-archive'
  version: 2
  snapshot: MivoCanvasSnapshot
  assets: SerializedCanvasAsset[]
}

const isSerializedCanvasAsset = (
  asset: SerializedCanvasAsset | undefined,
): asset is SerializedCanvasAsset => Boolean(asset)

export const createCanvasArchive = async (snapshot: MivoCanvasSnapshot): Promise<MivoCanvasArchive> => {
  const normalizedSnapshot = normalizeCanvasSnapshotV2(snapshot)
  const importedAssetUrls = Array.from(
    new Set(
      normalizedSnapshot.nodes
        .map((node) => node.assetUrl)
        .filter((assetUrl): assetUrl is string => isImportedAssetUrl(assetUrl)),
    ),
  )
  const assets = (
    await Promise.all(importedAssetUrls.map((assetUrl) => serializeImportedAsset(assetUrl)))
  ).filter(isSerializedCanvasAsset)

  return {
    kind: 'mivo-canvas-archive',
    version: 2,
    snapshot: normalizedSnapshot,
    assets,
  }
}

export const stringifyCanvasArchive = async (snapshot: MivoCanvasSnapshot) =>
  JSON.stringify(await createCanvasArchive(snapshot), null, 2)

export const restoreCanvasImportAssets = async (canvasImport: ParsedCanvasImport) => {
  await Promise.all(canvasImport.assets.map((asset) => restoreSerializedAsset(asset)))
}
