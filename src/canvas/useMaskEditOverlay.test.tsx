import { describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useMaskEditOverlay } from './useMaskEditOverlay'
import type { MivoCanvasNode } from '../types/mivoCanvas'

// P1 regression guard (Greptile): useMaskEditOverlay must pass the ORIGINAL assetUrl
// (local:// for imported nodes) to useImageNaturalSize, NOT the resolved blob URL.
// getImageMetrics treats non-imported (blob:) URLs as undecodable → returns undefined;
// with no <img onLoad> fallback in the overlay path, a legacy imported node without
// assetSourceDimensions would silently never resolve naturalSize → mask overlay never
// mounts. This test mocks the two hooks and asserts the call arg is the original URL.
//
// Uses renderToStaticMarkup (node, no DOM) — hook calls run during render so the mock
// is invoked; useEffect (the warn-on-missing logger) does not run server-side, which
// is fine: the assertion is about the useImageNaturalSize call arg, not the effect.

const useImageNaturalSizeMock = vi.fn((url?: string, _dims?: unknown) => ({
  naturalSize: url?.startsWith('mivo-asset:') ? { width: 400, height: 300 } : undefined,
  onLoad: vi.fn(),
}))
const useResolvedAssetUrlMock = vi.fn((url?: string) => (url ? `blob:${url}` : undefined))

vi.mock('../lib/useResolvedAssetUrl', () => ({
  useResolvedAssetUrl: (...a: unknown[]) => useResolvedAssetUrlMock(...a as [string | undefined]),
}))
vi.mock('../lib/useImageNaturalSize', () => ({
  useImageNaturalSize: (...a: unknown[]) => useImageNaturalSizeMock(...a as [string | undefined, unknown]),
}))
vi.mock('../store/debugLogStore', () => ({ debugLogger: { warn: vi.fn(), log: vi.fn() } }))

// Legacy imported node: local:// (mivo-asset:) URL, NO assetSourceDimensions — the P1 case.
const legacyNode = { id: 'n1', type: 'image', assetUrl: 'mivo-asset:abc' } as unknown as MivoCanvasNode

function Probe() {
  useMaskEditOverlay('n1', [legacyNode])
  return null
}

describe('useMaskEditOverlay — P1: original assetUrl (not resolved blob) to useImageNaturalSize', () => {
  it('passes the original local:// assetUrl so getImageMetrics runs the IDB decode path', () => {
    renderToStaticMarkup(h(Probe))

    // P1: useImageNaturalSize receives the original local:// URL (decodable via IDB),
    // NOT the resolved blob: URL (non-imported → getImageMetrics returns undefined).
    expect(useImageNaturalSizeMock).toHaveBeenCalledWith('mivo-asset:abc', undefined)
    expect(useImageNaturalSizeMock).not.toHaveBeenCalledWith('blob:mivo-asset:abc', undefined)
  })
})
