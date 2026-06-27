import { useEffect, useState } from 'react'
import { isImportedAssetUrl, resolveAssetUrl } from './assetStorage'

export function useResolvedAssetUrl(assetUrl?: string) {
  const [resolvedAsset, setResolvedAsset] = useState<{ source?: string; url: string }>({ url: '' })

  useEffect(() => {
    if (!assetUrl || !isImportedAssetUrl(assetUrl)) return

    let active = true
    let objectUrl: string | undefined

    void resolveAssetUrl(assetUrl).then((nextUrl) => {
      if (!active) {
        if (nextUrl.startsWith('blob:')) URL.revokeObjectURL(nextUrl)
        return
      }

      if (nextUrl.startsWith('blob:')) {
        objectUrl = nextUrl
      }

      setResolvedAsset({ source: assetUrl, url: nextUrl })
    })

    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [assetUrl])

  if (!assetUrl) return ''
  if (!isImportedAssetUrl(assetUrl)) return assetUrl

  return resolvedAsset.source === assetUrl ? resolvedAsset.url : ''
}
