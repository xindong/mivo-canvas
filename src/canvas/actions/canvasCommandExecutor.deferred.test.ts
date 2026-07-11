// src/canvas/actions/canvasCommandExecutor.deferred.test.ts
// T2.3 PR2 — two-stage-asset apply (with a CanvasCommandAssetBridge).
//
// PR1 (canvasCommandExecutor.test.ts) covers the sync commands + the no-bridge
// deferral throw. This suite covers the PR2 deliverable: when a bridge IS passed,
// the 7 deferred kinds (import-asset / 5 generation / mask-edit) really apply —
// resolve assetIds → File/Blob via /api/assets (T1.5 #195), then dispatch. Plus
// the two-stage asset failure paths (tagged CanvasCommandAssetResolveError, never
// silent). The no-bridge boundary (still throws DeferredError) stays in the PR1
// file so both PR1/PR2 boundaries are visible in test output.

import { describe, expect, it, vi } from 'vitest'
import {
  applyCanvasCommand,
  CanvasCommandAssetResolveError,
  CanvasCommandDeferredError,
} from './canvasCommandExecutor'
import type { CanvasCommandAssetBridge } from './canvasCommandExecutor'
import { createMockRuntime } from './canvasCommandExecutorTestFactories'

/**
 * Build a fully-mocked CanvasCommandAssetBridge (PR2 two-stage seam). Each method
 * is a vi.fn spy so tests can assert resolve/dispatch intent + args. resolveAssetFile
 * returns a distinct File per assetId; tests override it (mockRejectedValueOnce)
 * to exercise the 404 / resolve-failure path. addImportedAssetNode /
 * submitImageMaskEdit return fixed ids so the apply return value is observable.
 */
const createMockAssetBridge = (): CanvasCommandAssetBridge => {
  const methods = {
    resolveAssetFile: vi.fn(async (assetId: string): Promise<File> => {
      const blob = new Blob([`asset:${assetId}`], { type: 'application/octet-stream' })
      return new File([blob], assetId, { type: 'application/octet-stream' })
    }),
    addImportedAssetNode: vi.fn(async (): Promise<string> => 'imported-node-id'),
    submitImageMaskEdit: vi.fn(async (): Promise<string[]> => ['mask-result-id']),
  }
  return { ...methods } as unknown as CanvasCommandAssetBridge & typeof methods
}

describe('applyCanvasCommand — two-stage asset apply with bridge (PR2)', () => {
  it('import-asset → resolve assetId → addImportedAssetNode; returns new id', async () => {
    const rt = createMockRuntime()
    const bridge = createMockAssetBridge()
    const result = await applyCanvasCommand(
      {
        kind: 'import-asset',
        assetId: 'asset-1',
        mimeType: 'image/png',
        originalName: 'cat.png',
        position: { x: 10, y: 20 },
      },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledWith('asset-1')
    expect(vi.mocked(bridge.addImportedAssetNode)).toHaveBeenCalledWith({
      assetId: 'asset-1',
      file: expect.any(File),
      mimeType: 'image/png',
      originalName: 'cat.png',
      position: { x: 10, y: 20 },
    })
    expect(result).toBe('imported-node-id')
    // import goes through the bridge, NOT a runtime generation call.
    expect(vi.mocked(rt.generateImageEdit)).not.toHaveBeenCalled()
  })

  it('import-asset (no originalName) → addImportedAssetNode with originalName undefined', async () => {
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      { kind: 'import-asset', assetId: 'a', mimeType: 'image/jpeg', position: { x: 0, y: 0 } },
      createMockRuntime(),
      bridge,
    )
    expect(vi.mocked(bridge.addImportedAssetNode)).toHaveBeenCalledWith(
      expect.objectContaining({ originalName: undefined }),
    )
  })

  it('generate-image-edit → resolve referenceAssetIds → runtime.generateImageEdit; returns ids', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateImageEdit).mockResolvedValue(['gen-1', 'gen-2'])
    const bridge = createMockAssetBridge()
    const result = await applyCanvasCommand(
      {
        kind: 'generate-image-edit',
        sourceNodeId: 'img-1',
        operation: 'upscale',
        prompt: 'sharper',
        options: { referenceAssetIds: ['ref-a', 'ref-b'], quality: 'high' },
      },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledWith('ref-a')
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledWith('ref-b')
    expect(vi.mocked(rt.generateImageEdit)).toHaveBeenCalledWith(
      'img-1',
      'upscale',
      'sharper',
      expect.objectContaining({
        referenceFiles: [expect.any(File), expect.any(File)],
        quality: 'high',
      }),
    )
    // referenceAssetIds is NOT passed through (it is command-only; the runtime
    // sees referenceFiles instead).
    expect(vi.mocked(rt.generateImageEdit).mock.calls[0][3]).not.toHaveProperty(
      'referenceAssetIds',
    )
    expect(result).toEqual(['gen-1', 'gen-2'])
  })

  it('generate-image-edit (no options) → no resolve, runtime called with undefined options', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateImageEdit).mockResolvedValue([])
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      { kind: 'generate-image-edit', sourceNodeId: 'i', operation: 'upscale', prompt: 'p' },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).not.toHaveBeenCalled()
    expect(vi.mocked(rt.generateImageEdit)).toHaveBeenCalledWith('i', 'upscale', 'p', undefined)
  })

  it('generate-image-edit (options but no referenceAssetIds) → no resolve, scalars pass through', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateImageEdit).mockResolvedValue([])
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      {
        kind: 'generate-image-edit',
        sourceNodeId: 'i',
        operation: 'upscale',
        prompt: 'p',
        options: { quality: 'medium', model: 'gpt-image-2' },
      },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).not.toHaveBeenCalled()
    expect(vi.mocked(rt.generateImageEdit)).toHaveBeenCalledWith(
      'i',
      'upscale',
      'p',
      expect.objectContaining({ quality: 'medium', model: 'gpt-image-2' }),
    )
  })

  it('generate-variations → resolve refs → runtime.generateVariations; returns ids', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateVariations).mockResolvedValue(['v-1'])
    const bridge = createMockAssetBridge()
    const variations = [{ prompt: 'a cat', quality: 'high' as const }]
    const result = await applyCanvasCommand(
      {
        kind: 'generate-variations',
        sourceNodeId: 'img',
        variations,
        options: { referenceAssetIds: ['r1'] },
      },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledWith('r1')
    expect(vi.mocked(rt.generateVariations)).toHaveBeenCalledWith(
      'img',
      variations,
      expect.objectContaining({ referenceFiles: [expect.any(File)] }),
    )
    expect(result).toEqual(['v-1'])
  })

  it('generate-beside-node → resolve refs → runtime.generateBesideNode', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateBesideNode).mockResolvedValue(['b-1'])
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      {
        kind: 'generate-beside-node',
        sourceNodeId: 'img',
        prompt: 'a red car to the right',
        options: { referenceAssetIds: ['r1', 'r2'] },
      },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(rt.generateBesideNode)).toHaveBeenCalledWith(
      'img',
      'a red car to the right',
      expect.objectContaining({ referenceFiles: expect.any(Array) }),
    )
  })

  it('generate-into-ai-slot → resolve refs → runtime.generateIntoAiSlot', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateIntoAiSlot).mockResolvedValue(['s-1'])
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      { kind: 'generate-into-ai-slot', slotId: 'slot-1', prompt: 'cat', options: { referenceAssetIds: ['r1'] } },
      rt,
      bridge,
    )
    expect(vi.mocked(rt.generateIntoAiSlot)).toHaveBeenCalledWith(
      'slot-1',
      'cat',
      expect.objectContaining({ referenceFiles: [expect.any(File)] }),
    )
  })

  it('generate-from-annotation → resolve refs → runtime.generateFromAnnotation', async () => {
    const rt = createMockRuntime()
    vi.mocked(rt.generateFromAnnotation).mockResolvedValue(['a-1'])
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      { kind: 'generate-from-annotation', annotationNodeId: 'ann-1', options: { referenceAssetIds: ['r1'] } },
      rt,
      bridge,
    )
    expect(vi.mocked(rt.generateFromAnnotation)).toHaveBeenCalledWith(
      'ann-1',
      expect.objectContaining({ referenceFiles: [expect.any(File)] }),
    )
  })

  it('mask-edit → resolve maskAssetId + markedImageAssetId → submitImageMaskEdit with assembled payload', async () => {
    const rt = createMockRuntime()
    const bridge = createMockAssetBridge()
    vi.mocked(bridge.submitImageMaskEdit).mockResolvedValue(['mask-1'])
    const result = await applyCanvasCommand(
      {
        kind: 'mask-edit',
        sourceNodeId: 'img-1',
        prompt: 'remove the cat',
        maskAssetId: 'mask-asset',
        markedImageAssetId: 'marked-asset',
        maskBounds: { x: 0, y: 0, width: 100, height: 100 },
        sourceSize: { width: 800, height: 600 },
        quality: 'high',
        model: 'gemini-3-pro-image',
        subjectLabel: 'cat',
        subjects: [{ label: 'cat', bounds: { x: 0, y: 0, width: 50, height: 50 } }],
      },
      rt,
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledWith('mask-asset')
    expect(vi.mocked(bridge.resolveAssetFile)).toHaveBeenCalledWith('marked-asset')
    expect(vi.mocked(bridge.submitImageMaskEdit)).toHaveBeenCalledWith(
      'img-1',
      expect.objectContaining({
        prompt: 'remove the cat',
        mask: expect.any(File),
        markedImage: expect.any(File),
        maskBounds: { x: 0, y: 0, width: 100, height: 100 },
        sourceSize: { width: 800, height: 600 },
        quality: 'high',
        model: 'gemini-3-pro-image',
        subjectLabel: 'cat',
        subjects: [{ label: 'cat', bounds: { x: 0, y: 0, width: 50, height: 50 } }],
      }),
    )
    expect(result).toEqual(['mask-1'])
  })

  it('mask-edit (no mask / no markedImage) → no resolve, payload carries undefined blobs', async () => {
    const bridge = createMockAssetBridge()
    await applyCanvasCommand(
      { kind: 'mask-edit', sourceNodeId: 'img', prompt: 'p', sourceSize: { width: 1, height: 1 } },
      createMockRuntime(),
      bridge,
    )
    expect(vi.mocked(bridge.resolveAssetFile)).not.toHaveBeenCalled()
    expect(vi.mocked(bridge.submitImageMaskEdit)).toHaveBeenCalledWith(
      'img',
      expect.objectContaining({
        prompt: 'p',
        mask: undefined,
        markedImage: undefined,
        sourceSize: { width: 1, height: 1 },
      }),
    )
  })
})

describe('applyCanvasCommand — two-stage asset failure paths (tagged, not silent)', () => {
  // The bridge throws CanvasCommandAssetResolveError on 404 / resolve failure
  // (contract: never return null silently). apply must propagate that as a
  // rejection and fail-closed — NO runtime dispatch, NO silent empty result.
  // The executor also enforces the tag at its own boundary (resolveAssetFileTagged
  // re-wraps non-tagged bridge rejections), covered by the last test below.

  it('import-asset — assetId 404 → rejects with CanvasCommandAssetResolveError, no node added', async () => {
    const bridge = createMockAssetBridge()
    vi.mocked(bridge.resolveAssetFile).mockRejectedValueOnce(
      new CanvasCommandAssetResolveError('missing', '404'),
    )
    const rt = createMockRuntime()
    await expect(
      applyCanvasCommand(
        { kind: 'import-asset', assetId: 'missing', mimeType: 'image/png', position: { x: 0, y: 0 } },
        rt,
        bridge,
      ),
    ).rejects.toBeInstanceOf(CanvasCommandAssetResolveError)
    expect(vi.mocked(bridge.addImportedAssetNode)).not.toHaveBeenCalled()
  })

  it('generate-image-edit — referenceAssetId resolve failure → rejects, runtime NOT called', async () => {
    const bridge = createMockAssetBridge()
    vi.mocked(bridge.resolveAssetFile).mockRejectedValueOnce(
      new CanvasCommandAssetResolveError('bad-ref', 'network error'),
    )
    const rt = createMockRuntime()
    await expect(
      applyCanvasCommand(
        {
          kind: 'generate-image-edit',
          sourceNodeId: 'i',
          operation: 'upscale',
          prompt: 'p',
          options: { referenceAssetIds: ['bad-ref', 'good-ref'] },
        },
        rt,
        bridge,
      ),
    ).rejects.toBeInstanceOf(CanvasCommandAssetResolveError)
    // Promise.all short-circuits on first failure; the runtime must never run.
    expect(vi.mocked(rt.generateImageEdit)).not.toHaveBeenCalled()
  })

  it('mask-edit — maskAssetId resolve failure → rejects, submit NOT called', async () => {
    const bridge = createMockAssetBridge()
    vi.mocked(bridge.resolveAssetFile).mockRejectedValueOnce(
      new CanvasCommandAssetResolveError('bad-mask', 'purged'),
    )
    const rt = createMockRuntime()
    await expect(
      applyCanvasCommand(
        {
          kind: 'mask-edit',
          sourceNodeId: 'i',
          prompt: 'p',
          sourceSize: { width: 1, height: 1 },
          maskAssetId: 'bad-mask',
        },
        rt,
        bridge,
      ),
    ).rejects.toBeInstanceOf(CanvasCommandAssetResolveError)
    expect(vi.mocked(bridge.submitImageMaskEdit)).not.toHaveBeenCalled()
  })

  it('tagged error carries assetId + reason (distinct from DeferredError)', async () => {
    const bridge = createMockAssetBridge()
    vi.mocked(bridge.resolveAssetFile).mockRejectedValueOnce(
      new CanvasCommandAssetResolveError('asset-abc', '404 not found'),
    )
    let thrown: unknown
    try {
      await applyCanvasCommand(
        { kind: 'import-asset', assetId: 'asset-abc', mimeType: 'image/png', position: { x: 0, y: 0 } },
        createMockRuntime(),
        bridge,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CanvasCommandAssetResolveError)
    const resolveErr = thrown as CanvasCommandAssetResolveError
    expect(resolveErr.assetId).toBe('asset-abc')
    expect(resolveErr.reason).toContain('404')
    // A resolve failure is NOT a deferral — they must be distinguishable.
    expect(thrown).not.toBeInstanceOf(CanvasCommandDeferredError)
  })

  it('bridge rejecting a plain Error → executor re-wraps to CanvasCommandAssetResolveError with assetId', async () => {
    // Greptile P2: the executor enforces the tagged-error contract at its OWN
    // boundary — it does not rely on the bridge impl to self-tag. A naive bridge
    // that rejects a plain Error is re-wrapped carrying the failed assetId, so a
    // downstream caller can always tell "asset resolve failed" (tagged) apart
    // from a real generation/import failure, regardless of how the bridge throws.
    const bridge = createMockAssetBridge()
    vi.mocked(bridge.resolveAssetFile).mockRejectedValueOnce(new Error('network timeout'))
    const rt = createMockRuntime()
    let thrown: unknown
    try {
      await applyCanvasCommand(
        {
          kind: 'generate-image-edit',
          sourceNodeId: 'i',
          operation: 'upscale',
          prompt: 'p',
          options: { referenceAssetIds: ['plain-err-id'] },
        },
        rt,
        bridge,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CanvasCommandAssetResolveError)
    const resolveErr = thrown as CanvasCommandAssetResolveError
    expect(resolveErr.assetId).toBe('plain-err-id')
    expect(resolveErr.reason).toContain('network timeout')
    expect(vi.mocked(rt.generateImageEdit)).not.toHaveBeenCalled()
  })
})
