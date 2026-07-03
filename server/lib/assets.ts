import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Migrated from vite.config.ts L8-L190, L1103-L1185. See server/contracts/local-assets.json
// for the dev-middleware baseline. D2 (realpath guard) is the only intentional change.

export const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])

export const mimeFor = (filePath: string): string => {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.svg') return 'image/svg+xml'
  return 'application/octet-stream'
}

// Magic-byte sniff with extension fallback (vite.config.ts L114-L135).
export const mimeForFile = (file: Buffer, filePath: string): string => {
  if (file.length >= 12 && file.subarray(0, 4).toString('ascii') === 'RIFF' && file.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  if (file.length >= 8 && file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (file.length >= 3 && file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff) {
    return 'image/jpeg'
  }
  if (file.length >= 6 && file.subarray(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif'
  }
  const textPrefix = file.subarray(0, 160).toString('utf8').trimStart()
  if (textPrefix.startsWith('<svg') || textPrefix.startsWith('<?xml')) return 'image/svg+xml'
  return mimeFor(filePath)
}

export const localAssetRoots = (): string[] => {
  const configured = process.env.MIVO_ASSET_DIR?.trim()
  const desktop = path.join(os.homedir(), 'Desktop')
  const candidates = configured
    ? [configured]
    : [path.join(desktop, 'Images'), path.join(desktop, 'images')]
  return candidates.map((candidate) => path.resolve(candidate))
}

export const encodeAssetPath = (filePath: string): string => Buffer.from(filePath).toString('base64url')
export const decodeAssetPath = (id: string): string => Buffer.from(id, 'base64url').toString('utf8')

// Resolve real roots through fs.realpath and dedup case-insensitively
// (vite.config.ts L1105-L1130). Roots that don't exist are dropped.
export const resolveRealRoots = async (roots: string[]): Promise<string[]> => {
  const resolved = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fs.realpath(root)
      } catch {
        return null
      }
    }),
  )
  const seen = new Set<string>()
  const out: string[] = []
  for (const real of resolved) {
    if (!real) continue
    const key = real.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(real)
  }
  return out
}

export type AssetResolution =
  | { kind: 'ok'; realFile: string }
  | { kind: 'outside' } // 403 — resolved path escapes roots (incl. symlink escape)
  | { kind: 'missing' } // 404 — file does not exist / cannot be resolved

// D2 (intentional change vs dev middleware L154-L157): the original serving
// guard used lexical path.resolve, which a root-local symlink pointing outside
// the root would defeat. We keep the lexical pre-check (so /etc/passwd and
// ../x still return 403, not 404, matching dev behavior) and then resolve the
// target through fs.realpath to defeat symlink escape. A file that does not
// exist yields 'missing' (→ 404, preserving dev behavior); a file that resolves
// outside the roots yields 'outside' (→ 403, incl. symlink escape).
export const resolveAssetFile = async (filePath: string, roots: string[]): Promise<AssetResolution> => {
  const absPath = path.resolve(filePath)
  // Lexical pre-check: reject obvious traversals (absolute paths and ../ outside
  // root) with 403, exactly as the dev middleware did. Without this, a
  // non-existent traversal target would fall through to realpath → 404.
  const lexicalInside = roots.some((root) => absPath === root || absPath.startsWith(`${root}${path.sep}`))
  if (!lexicalInside) {
    return { kind: 'outside' }
  }
  // D2: realpath check to defeat symlink escape. A root-local symlink pointing
  // outside the root resolves outside realRoots → 403.
  const realRoots = await resolveRealRoots(roots)
  let realFile: string
  try {
    realFile = await fs.realpath(absPath)
  } catch {
    return { kind: 'missing' }
  }
  const realInside = realRoots.some((root) => realFile === root || realFile.startsWith(`${root}${path.sep}`))
  return realInside ? { kind: 'ok', realFile } : { kind: 'outside' }
}

type LocalAsset = {
  id: string
  name: string
  title: string
  format: string
  sizeBytes: number
  sourcePath: string
  updatedAt: number
  url: string
}

// Migrated from vite.config.ts L1103-L1185. Listing uses realpath for dedup
// (already did); serving guard now also uses realpath via resolveAssetFile.
export const readLocalAssets = async (): Promise<{ root: string; assets: LocalAsset[] }> => {
  const roots = localAssetRoots()
  const realRoots = await resolveRealRoots(roots)

  const assetsByPath = new Map<string, LocalAsset>()
  const assets = (
    await Promise.all(
      realRoots.map(async (root) => {
        const entries = await fs.readdir(root, { withFileTypes: true })
        return Promise.all(
          entries
            .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
            .map(async (entry) => {
              const filePath = path.join(root, entry.name)
              const stat = await fs.stat(filePath)
              const realFilePath = await fs.realpath(filePath)
              const id = encodeAssetPath(filePath)
              return {
                key: realFilePath.toLowerCase(),
                asset: {
                  id,
                  name: entry.name,
                  title: entry.name.replace(/\.[^.]+$/, ''),
                  format: path.extname(entry.name).slice(1).toUpperCase(),
                  sizeBytes: stat.size,
                  sourcePath: filePath.replace(os.homedir(), '~'),
                  updatedAt: stat.mtimeMs,
                  url: `/api/mivo/local-assets/${id}`,
                } satisfies LocalAsset,
              }
            }),
        )
      }),
    )
  )
    .flat()
    .reduce((items, { key, asset }) => {
      if (!items.has(key)) items.set(key, asset)
      return items
    }, assetsByPath)

  return {
    root: realRoots[0]?.replace(os.homedir(), '~') || '~/Desktop/images',
    assets: [...assets.values()].sort((left, right) => right.updatedAt - left.updatedAt),
  }
}
