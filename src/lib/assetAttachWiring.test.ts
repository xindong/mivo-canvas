// src/lib/assetAttachWiring.test.ts
// Block 3 (A2-S4) helper 单测:serverAssetIdFromUrl(URL 过滤)+ enqueueAssetAttach/Detach(经 enqueuePersistWrite 入队)。
// 覆盖预检 §5 #1(helper 契约 body)+ #4(URL 过滤:只 server 资产 enqueue)。
import { beforeEach, describe, expect, it, vi } from 'vitest'

// spy enqueuePersistWrite(persistBoot):helper 的 enqueue* 经它入队;mock 成 no-op 避免真 IDB 队列。
vi.mock('./persistBoot', () => ({
  enqueuePersistWrite: vi.fn(() => undefined),
}))

import { enqueuePersistWrite } from './persistBoot'
import { enqueueAssetAttach, enqueueAssetDetach, serverAssetIdFromUrl } from './assetAttachWiring'

const enqueueSpy = vi.mocked(enqueuePersistWrite)

describe('assetAttachWiring (Block 3 helper)', () => {
  beforeEach(() => {
    enqueueSpy.mockClear()
  })

  describe('serverAssetIdFromUrl — URL 过滤(§5 #4)', () => {
    it('抽 server 资产 url 的 content-hash assetId(剥 mivo-sasset: 前缀)', () => {
      expect(serverAssetIdFromUrl('mivo-sasset:abc123def')).toBe('abc123def')
    })

    it('非 server 资产 url 返回 undefined —— local://、asset://、/path.png 都不发 attach/detach', () => {
      expect(serverAssetIdFromUrl('local://xyz')).toBeUndefined()
      expect(serverAssetIdFromUrl('asset://xyz')).toBeUndefined()
      expect(serverAssetIdFromUrl('/image.png')).toBeUndefined()
      expect(serverAssetIdFromUrl('data:image/png;base64,xxx')).toBeUndefined()
    })

    it('undefined/空 url 返回 undefined(无 asset 字段的 node)', () => {
      expect(serverAssetIdFromUrl(undefined)).toBeUndefined()
      expect(serverAssetIdFromUrl('')).toBeUndefined()
    })
  })

  it('enqueueAssetAttach → enqueuePersistWrite {kind attachAsset, canvasId, assetId, nodeId} (§5 #1)', () => {
    enqueueAssetAttach('c1', 'a1', 'n1')
    expect(enqueueSpy).toHaveBeenCalledWith({
      kind: 'attachAsset',
      canvasId: 'c1',
      assetId: 'a1',
      nodeId: 'n1',
    })
  })

  it('enqueueAssetDetach → enqueuePersistWrite {kind detachAsset, canvasId, assetId, nodeId} (§5 #1)', () => {
    enqueueAssetDetach('c2', 'a2', 'n2')
    expect(enqueueSpy).toHaveBeenCalledWith({
      kind: 'detachAsset',
      canvasId: 'c2',
      assetId: 'a2',
      nodeId: 'n2',
    })
  })
})
