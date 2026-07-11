import { useEffect, useState } from 'react'
import { acquireAssetUrl } from './assetUrlLease'
import { isImportedAssetUrl } from './assetStorage'

export function useResolvedAssetUrl(assetUrl?: string) {
  const [resolvedAsset, setResolvedAsset] = useState<{ source?: string; url: string }>({ url: '' })

  useEffect(() => {
    if (!assetUrl || !isImportedAssetUrl(assetUrl)) return

    let active = true
    // localRelease is set on the happy path (mount still active when the lease
    // resolves). The cleanup and the .then form a mutual-exclusion pair: exactly
    // one of them releases the lease.
    // - If cleanup fires first (unmount during pending): active=false, localRelease
    //   unset → the .then sees active=false and releases.
    // - If .then fires first: localRelease=release → cleanup releases on unmount.
    let localRelease: (() => void) | undefined

    void acquireAssetUrl(assetUrl)
      .then(({ url, release }) => {
        if (!active) {
          // Unmounted while the lease was in flight. The acquire already counted
          // our reference, so we must release it exactly once here.
          release()
          return
        }
        localRelease = release
        setResolvedAsset({ source: assetUrl, url })
      })
      .catch(() => {
        // P2.7: defensive — the fetch + lease layers already swallow network errors
        // (→ null → ''), so this catch should never fire in practice. But a stray
        // throw must never surface as an unhandled rejection in the effect.
        if (active) setResolvedAsset({ source: undefined, url: '' })
      })

    return () => {
      active = false
      if (localRelease) localRelease()
    }
  }, [assetUrl])

  if (!assetUrl) return ''
  if (!isImportedAssetUrl(assetUrl)) return assetUrl

  return resolvedAsset.source === assetUrl ? resolvedAsset.url : ''
}
