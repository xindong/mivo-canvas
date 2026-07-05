import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock 'leafer-ui' with lightweight fake display objects so the paint module can
// be exercised without a real canvas. The fakes record props (for geometry/url
// assertions), track children (for crop Group assertions), and no-op remove().
vi.mock('leafer-ui', () => {
  class FakeUI {
    props: Record<string, unknown>
    removed = false
    constructor(props: Record<string, unknown> = {}) {
      this.props = { ...props }
    }
    set(props: Record<string, unknown>) {
      this.props = { ...this.props, ...props }
    }
    remove() {
      this.removed = true
    }
  }
  class FakeImage extends FakeUI {}
  class FakeRect extends FakeUI {}
  class FakeGroup extends FakeUI {
    children: FakeUI[] = []
    add(child: FakeUI) {
      this.children.push(child)
    }
  }
  return { Image: FakeImage, Group: FakeGroup, Rect: FakeRect }
})

// Force engine LOD on with a 32px threshold so the LOD↔HD transition is testable
// (default is 'off' because the URL has no ?lod=on, which would make every node
// HD and the LOD path unreachable).
vi.mock('./engineLodMode', () => ({
  engineLodMode: 'on',
  engineLodThresholdPx: 32,
  isEngineLodRequested: true,
}))

// Mock assetStorage so `mivo-asset:` URLs resolve to deterministic blob URLs
// (the real resolver reads IDB, which is absent in the test env → would return
// '' and never create a lease entry, defeating the balance assertions).
vi.mock('../lib/assetStorage', () => ({
  isImportedAssetUrl: (url?: string) => Boolean(url && url.startsWith('mivo-asset:')),
  resolveAssetUrl: (url?: string) =>
    Promise.resolve(url && url.startsWith('mivo-asset:') ? `blob:${url}` : url ?? ''),
  readImportedAssetFile: () => Promise.resolve(undefined),
}))

// Importing AFTER vi.mock (hoisted) so the module sees the mocked deps.
import { __leaseMapSize } from '../lib/assetUrlLease'
import { createLeaferImagePaint, cropChildLocal, imageLayer } from './leaferImagePaint'
import type { LeaferImagePaint } from './leaferImagePaint'
import { Layer } from './layers'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { RendererSyncContext } from './rendererAdapter'
import type { Leafer } from 'leafer-ui'
import moduleSource from './leaferImagePaint.ts?raw'

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

type FakeUI = { props: Record<string, unknown>; removed: boolean; set: (p: Record<string, unknown>) => void; remove: () => void }
type FakeGroup = FakeUI & { children: FakeUI[]; add: (c: FakeUI) => void }

const makeFakeLeafer = () => {
  const children: FakeUI[] = []
  return {
    add: (child: FakeUI) => children.push(child),
    children,
  } as unknown as Leafer & { children: FakeUI[] }
}

const ctx = (scale = 1): RendererSyncContext => ({
  viewport: { x: 0, y: 0, scale },
  selectedNodeIds: new Set<string>(),
  isPanning: false,
})

type NodeOpts = {
  id?: string
  assetUrl?: string
  width?: number
  height?: number
  x?: number
  y?: number
  imageCrop?: { x: number; y: number; width: number; height: number }
}

const imgNode = (opts: NodeOpts = {}): MivoCanvasNode =>
  ({
    id: opts.id ?? 'n1',
    type: 'image',
    status: 'ready',
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    width: opts.width ?? 500,
    height: opts.height ?? 500,
    assetUrl: opts.assetUrl ?? 'mivo-asset:abc',
    imageCrop: opts.imageCrop,
  }) as unknown as MivoCanvasNode

describe('cropChildLocal — CSS negative-offset equivalence', () => {
  it('center 50% crop on a 100×100 node → image 200×200 at (-50, -50)', () => {
    // CSS: left=-(0.25/0.5)*100%=-50%, width=100/0.5%=200% → image 200 wide, offset -50
    const geo = cropChildLocal(100, 100, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })
    expect(geo).toEqual({ x: -50, y: -50, width: 200, height: 200 })
  })

  it('no crop (full image) → identity (0,0,nodeW,nodeH)', () => {
    const geo = cropChildLocal(216, 384, { x: 0, y: 0, width: 1, height: 1 })
    expect(geo).toEqual({ x: 0, y: 0, width: 216, height: 384 })
  })

  it('top-left 25% quadrant crop → image 4x at (-0,-0)', () => {
    const geo = cropChildLocal(200, 200, { x: 0, y: 0, width: 0.25, height: 0.25 })
    expect(geo).toEqual({ x: 0, y: 0, width: 800, height: 800 })
  })
})

describe('imageLayer — 2b-2 z-order', () => {
  it('images paint in Layer.Content (Layer.Frame reserved for frame/section)', () => {
    expect(imageLayer()).toBe(Layer.Content)
    expect(imageLayer()).not.toBe(Layer.Frame)
  })
})

describe('createLeaferImagePaint — lease 收支平衡 (acquire/release symmetric)', () => {
  let leafer: ReturnType<typeof makeFakeLeafer>
  let paint: LeaferImagePaint

  beforeEach(() => {
    leafer = makeFakeLeafer()
    paint = createLeaferImagePaint(leafer)
  })

  it('three images sharing one mivo-asset URL → one lease entry; sync([]) revokes it', async () => {
    const url = 'mivo-asset:shared'
    paint.sync([imgNode({ id: 'a', assetUrl: url }), imgNode({ id: 'b', assetUrl: url }), imgNode({ id: 'c', assetUrl: url })], ctx())
    await flushPromises()
    // 3 acquires for the same URL dedup to one blob entry (refCount 3)
    expect(__leaseMapSize()).toBe(1)
    expect(paint.paintedCount()).toBe(3)

    const counts = paint.sync([], ctx())
    await flushPromises()
    expect(counts).toEqual({ created: 0, updated: 0, deleted: 3 })
    // last release revokes the blob → leaseMap empty (收支平衡)
    expect(__leaseMapSize()).toBe(0)
  })

  it('assetUrl change on the same node releases the old lease and acquires a new one', async () => {
    paint.sync([imgNode({ id: 'a', assetUrl: 'mivo-asset:one' })], ctx())
    await flushPromises()
    expect(__leaseMapSize()).toBe(1)

    paint.sync([imgNode({ id: 'a', assetUrl: 'mivo-asset:two' })], ctx())
    await flushPromises()
    // old 'mivo-asset:one' released (refCount 0 → revoked), new 'mivo-asset:two' acquired
    expect(__leaseMapSize()).toBe(1)

    paint.sync([], ctx())
    await flushPromises()
    expect(__leaseMapSize()).toBe(0)
  })

  it('LOD↔HD transition: zoom below threshold releases the lease; back to HD re-acquires; delete balances', async () => {
    const big = imgNode({ id: 'a', assetUrl: 'mivo-asset:big', width: 500, height: 500 })
    // scale 1 → 500px screen projection, HD → lease acquired
    paint.sync([big], ctx(1))
    await flushPromises()
    expect(__leaseMapSize()).toBe(1)

    // scale 0.01 → 5px < 32 threshold → LOD solid rect, lease released
    const lodCounts = paint.sync([big], ctx(0.01))
    await flushPromises()
    expect(lodCounts).toEqual({ created: 0, updated: 1, deleted: 0 })
    expect(__leaseMapSize()).toBe(0)

    // back to scale 1 → HD, kind swaps back to image, lease re-acquired
    paint.sync([big], ctx(1))
    await flushPromises()
    expect(__leaseMapSize()).toBe(1)

    paint.sync([], ctx(1))
    await flushPromises()
    expect(__leaseMapSize()).toBe(0)
  })

  it('dispose() (Leafer destroy path) releases every in-flight + resolved lease', async () => {
    paint.sync([imgNode({ id: 'a', assetUrl: 'mivo-asset:x' }), imgNode({ id: 'b', assetUrl: 'mivo-asset:y' })], ctx())
    // dispose BEFORE awaiting — leases are still in flight; dispose must mark
    // them disposed so the .then releases instead of applying
    paint.dispose()
    await flushPromises()
    expect(__leaseMapSize()).toBe(0)
    expect(paint.paintedCount()).toBe(0)
  })

  it('a node deleted while its lease is still in flight still releases (no leak)', async () => {
    paint.sync([imgNode({ id: 'a', assetUrl: 'mivo-asset:fast' })], ctx())
    // delete before flush — the in-flight .then must see disposed=true and release
    paint.sync([], ctx())
    await flushPromises()
    expect(__leaseMapSize()).toBe(0)
  })
})

describe('createLeaferImagePaint — diffReconcilePlan 收支 (no leak, no resurrect)', () => {
  let leafer: ReturnType<typeof makeFakeLeafer>
  let paint: LeaferImagePaint

  beforeEach(() => {
    leafer = makeFakeLeafer()
    paint = createLeaferImagePaint(leafer)
  })

  it('create/update/delete counts match the id diff', () => {
    // http URLs (pass-through, no lease) so counts are the only concern
    const c1 = paint.sync([imgNode({ id: 'a', assetUrl: 'http://x' }), imgNode({ id: 'b', assetUrl: 'http://y' })], ctx())
    expect(c1).toEqual({ created: 2, updated: 0, deleted: 0 })
    expect(paint.paintedCount()).toBe(2)

    const c2 = paint.sync([imgNode({ id: 'b', assetUrl: 'http://y' }), imgNode({ id: 'c', assetUrl: 'http://z' })], ctx())
    expect(c2).toEqual({ created: 1, updated: 1, deleted: 1 })
    expect(paint.paintedCount()).toBe(2)

    const c3 = paint.sync([], ctx())
    expect(c3).toEqual({ created: 0, updated: 0, deleted: 2 })
    expect(paint.paintedCount()).toBe(0)
  })

  it('a deleted id is never resurrected by the same sync (created ∩ deleted = ∅)', () => {
    paint.sync([imgNode({ id: 'a', assetUrl: 'http://x' })], ctx())
    paint.sync([imgNode({ id: 'b', assetUrl: 'http://y' })], ctx())
    // 'a' was deleted, 'b' was created in the same sync — no id is in both buckets
    // (the contract invariant; here verified by the counts above + painted size)
    expect(paint.paintedCount()).toBe(1)
  })
})

describe('createLeaferImagePaint — crop via Group(overflow:hidden) + child Image', () => {
  it('a cropped image paints a Group(overflow:hidden) at the node box with a child Image at cropChildLocal offset', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferImagePaint(leafer)
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    paint.sync([imgNode({ id: 'a', assetUrl: 'http://x', width: 100, height: 100, imageCrop: crop })], ctx())

    const group = leafer.children[0] as unknown as FakeGroup
    expect(group.props.overflow).toBe('hidden')
    expect(group.props.x).toBe(0)
    expect(group.props.y).toBe(0)
    expect(group.props.width).toBe(100)
    expect(group.props.height).toBe(100)
    expect(group.children.length).toBe(1)

    const child = group.children[0]
    // cropChildLocal(100, 100, {0.25,0.25,0.5,0.5}) = {x:-50, y:-50, width:200, height:200}
    expect(child.props.x).toBe(-50)
    expect(child.props.y).toBe(-50)
    expect(child.props.width).toBe(200)
    expect(child.props.height).toBe(200)
  })

  it('a non-cropped image paints a bare Image (no Group, no overflow)', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferImagePaint(leafer)
    paint.sync([imgNode({ id: 'a', assetUrl: 'http://x', width: 216, height: 384 })], ctx())

    const img = leafer.children[0] as unknown as FakeUI
    expect(img.props.overflow).toBeUndefined()
    expect(img.props.width).toBe(216)
    expect(img.props.height).toBe(384)
  })

  it('clearing imageCrop on an existing node swaps from Group to bare Image (kind swap)', () => {
    const leafer = makeFakeLeafer()
    const paint = createLeaferImagePaint(leafer)
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    paint.sync([imgNode({ id: 'a', assetUrl: 'http://x', width: 100, height: 100, imageCrop: crop })], ctx())
    const groupBefore = leafer.children[0] as unknown as FakeGroup
    expect(groupBefore.children.length).toBe(1)

    paint.sync([imgNode({ id: 'a', assetUrl: 'http://x', width: 100, height: 100 })], ctx())
    // kind swapped image-crop → image; the old Group was removed and a bare Image added
    const after = leafer.children[1] as unknown as FakeUI
    expect(groupBefore.removed).toBe(true)
    expect(after.props.overflow).toBeUndefined()
    expect(after.props.width).toBe(100)
  })
})

describe('createLeaferImagePaint — D1 source-contract (pure paint, no Leafer back-write)', () => {
  it('module source never subscribes to Leafer events (no .on( call)', () => {
    // D1: the paint module must not call leafer.on / object.on — that would let
    // Leafer back-write the store. The only Leafer surface it touches is add/remove/set.
    expect(moduleSource).not.toMatch(/\.on\(/)
  })

  it('module source never reads zoomLayer (no camera back-write)', () => {
    expect(moduleSource).not.toMatch(/zoomLayer/)
  })
})
