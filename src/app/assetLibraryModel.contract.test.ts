// src/app/assetLibraryModel.contract.test.ts
//
// 资产源总线契约测试 (T2.1 / arch plan §3 + §10 M2 + §11 机制#3)。
//
// 为什么是契约测试:资产源总线是 §3 第二条"已形式化"的总线(Local/Eagle 2+ 实现已在场,
// Pinterest 占位)。本测试锁住"源枚举(AssetSourceId)+ 资产项数据结构(AssetItem,在总线
// 里流动的"消息")+ 纯函数行为(已收敛的"逻辑面",含错误/边界语义)"——任何新增资产源、
// 改动 AssetItem 必填字段、或改动纯函数边界行为,都会被本测试拦下,强制契约变更显式化。
// 这是 §11 机制#3"过契约测试即可合入"对资产源总线的兜底。
//
// 契约面(锁定对象,与生产代码一一对应,零行为变化):
//   - AssetSourceId = 'local' | 'eagle' | 'pinterest' (源枚举,唯一真相源)
//   - AssetItem: 资产项数据结构(总线"消息":必填 id/sourceId/sourceLabel/name/title/
//     format/sizeBytes/sourcePath/updatedAt/url + 可选 thumbnailUrl/width/height/tags/
//     folders/sourceUrl/annotation)
//   - AssetSource: 源元数据 { id, label, description, meta, status }
//   - 纯函数(逻辑面): formatBytes / dimensionsLabel / thumbnailUrlFor /
//     assetMatchesQuery / flattenEagleFolders
//
// §3 目标 AssetSource{ list, search, thumbnail, importToCanvas } 接口尚未抽象——Local/Eagle/
// Pinterest 的 list/search/importToCanvas 逻辑当前内联在 LibraryWorkspace.tsx,无 connector
// 接口对象。本 PR 不抽 connector(防行为变化 = 解耦阶段非重写);connector 接口提取留待后续
// (届时本测试同步扩为"每 connector 过 list/search/thumbnail/importToCanvas 契约")。本测试
// 先锁 TYPE 面 + 已收敛纯函数行为,把"现在能锁的"锁死。
//
// 维护契约(给后续贡献者):
//   新增资产源 → ① 加进 AssetSourceId union ② 加进下方 EXPECTED_ASSET_SOURCES ③ 在
//   LibraryWorkspace 补分支。漏 ①/② 本测试 fail。改动纯函数边界行为 → 同步本测试。
//   改 AssetItem 必填字段 → 更新下方 sampleAsset 与必填字段断言。

import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  dimensionsLabel,
  thumbnailUrlFor,
  assetMatchesQuery,
  flattenEagleFolders,
} from './assetLibraryModel'
import type { AssetItem, AssetSourceId } from './assetLibraryModel'
import assetLibrarySource from './assetLibraryModel.ts?raw'

// 唯一真相源 = AssetSourceId union。新增源必须同步。
const EXPECTED_ASSET_SOURCES: AssetSourceId[] = ['local', 'eagle', 'pinterest']

// 合法 AssetItem 样本(契约面:必填字段齐全;override 便于各用例聚焦)。
const sampleAsset = (overrides: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1',
  sourceId: 'local',
  sourceLabel: 'Local',
  name: 'cat.png',
  title: 'Cat',
  format: 'png',
  sizeBytes: 2048,
  sourcePath: '/imgs/cat.png',
  updatedAt: 1000,
  url: 'file:///imgs/cat.png',
  ...overrides,
})

describe('资产源总线契约 — 源枚举(AssetSourceId 双向锁)', () => {
  it('AssetSourceId union 恰好含 local/eagle/pinterest(?raw 锁定义,防偷偷加第 4 个源)', () => {
    // 提取 union 定义体
    const match = assetLibrarySource.match(/export\s+type\s+AssetSourceId\s*=\s*([^\n]+)/)
    expect(match, 'AssetSourceId union 定义消失 —— 类型被重命名?更新本测试').not.toBeNull()
    const unionBody = match![1]
    // 每个 EXPECTED 源都在 union 里
    for (const id of EXPECTED_ASSET_SOURCES) {
      expect(unionBody, `AssetSourceId 缺 '${id}'`).toContain(`'${id}'`)
    }
    // union 里的字符串字面量数 == EXPECTED 数(防加了第 4 个源而不更新本测试)
    const literalCount = (unionBody.match(/'[^']+'/g) || []).length
    expect(
      literalCount,
      `AssetSourceId 有 ${literalCount} 个字面量,EXPECTED 只列 ${EXPECTED_ASSET_SOURCES.length} 个 —— 新增源必须同步本测试`,
    ).toBe(EXPECTED_ASSET_SOURCES.length)
  })

  it('EXPECTED_ASSET_SOURCES 与 union 一致且无重复', () => {
    expect(new Set(EXPECTED_ASSET_SOURCES).size).toBe(EXPECTED_ASSET_SOURCES.length)
    expect(EXPECTED_ASSET_SOURCES.length).toBe(3)
  })

  it('AssetSource 元数据类型面稳定:{ id, label, description, meta, status }(?raw 锁字段集)', () => {
    // 锁 AssetSource 必填字段集 —— 改字段名/删字段 = 契约变更,本测试 fail。
    const match = assetLibrarySource.match(/export\s+type\s+AssetSource\s*=\s*\{([^}]+)\}/s)
    expect(match, 'AssetSource 类型定义消失或结构改了(非单层 type literal?)').not.toBeNull()
    const body = match![1]
    for (const field of ['id', 'label', 'description', 'meta', 'status'] as const) {
      expect(body, `AssetSource 缺字段 ${field}`).toContain(field)
    }
  })
})

describe('资产源总线契约 — 纯函数行为(错误/边界语义锁定)', () => {
  describe('formatBytes', () => {
    // 正路径:数值 → 单位换算
    it.each([
      [1, '1 B'],
      [512, '512 B'],
      [1023, '1023 B'],
      [1024, '1.0 KB'],
      [1536, '1.5 KB'],
      [10240, '10 KB'], // value >= 10 → 取整(非 toFixed)
      [1048576, '1.0 MB'],
      [1073741824, '1.0 GB'],
    ])('formatBytes(%i) === %s', (input, expected) => {
      expect(formatBytes(input)).toBe(expected)
    })
    // 边界:非正/非有限 → 兜底 "0 B"(防 NaN/负数产出 "-1 B" / "NaN B" 污染 UI)
    it('formatBytes(0) === "0 B"(非正兜底)', () => {
      expect(formatBytes(0)).toBe('0 B')
    })
    it('formatBytes(-1) === "0 B"(负数兜底)', () => {
      expect(formatBytes(-1)).toBe('0 B')
    })
    it('formatBytes(NaN) === "0 B"(非有限兜底)', () => {
      expect(formatBytes(NaN)).toBe('0 B')
    })
  })

  describe('dimensionsLabel', () => {
    it('undefined → "Reading size"(尺寸未就绪兜底)', () => {
      expect(dimensionsLabel(undefined)).toBe('Reading size')
    })
    it('{ width: 100, height: 200 } → "100 x 200"', () => {
      expect(dimensionsLabel({ width: 100, height: 200 })).toBe('100 x 200')
    })
  })

  describe('thumbnailUrlFor', () => {
    it('有 thumbnailUrl → 返回 thumbnailUrl', () => {
      expect(thumbnailUrlFor(sampleAsset({ thumbnailUrl: 'thumb.png' }))).toBe('thumb.png')
    })
    it('无 thumbnailUrl → 回落 url(契约:thumbnail 非必填,url 兜底)', () => {
      expect(thumbnailUrlFor(sampleAsset({ thumbnailUrl: undefined }))).toBe('file:///imgs/cat.png')
    })
  })

  describe('assetMatchesQuery', () => {
    const asset = sampleAsset({
      tags: ['kawaii', 'animal'],
      sourceUrl: 'https://x/y',
      annotation: 'note',
    })
    it('空/纯空白 query → true(全匹配)', () => {
      expect(assetMatchesQuery(asset, '')).toBe(true)
      expect(assetMatchesQuery(asset, '   ')).toBe(true)
    })
    it('大小写不敏感子串匹配(仅 lowercase 比对)', () => {
      expect(assetMatchesQuery(asset, 'CAT')).toBe(true)
      expect(assetMatchesQuery(asset, 'cat')).toBe(true)
    })
    it('命中 name/title/format/sourcePath/sourceUrl/annotation/tags 任一字段 → true', () => {
      expect(assetMatchesQuery(asset, 'Cat')).toBe(true) // title
      expect(assetMatchesQuery(asset, 'png')).toBe(true) // format
      expect(assetMatchesQuery(asset, '/imgs/')).toBe(true) // sourcePath
      expect(assetMatchesQuery(asset, 'x/y')).toBe(true) // sourceUrl
      expect(assetMatchesQuery(asset, 'note')).toBe(true) // annotation
      expect(assetMatchesQuery(asset, 'kawaii')).toBe(true) // tag
    })
    it('无任何字段命中 → false', () => {
      expect(assetMatchesQuery(asset, 'zzz-nope')).toBe(false)
    })
    it('tags 缺失(undefined)不崩,仅查其余字段', () => {
      const noTags = sampleAsset({ tags: undefined })
      expect(assetMatchesQuery(noTags, 'cat')).toBe(true) // name 命中
      expect(assetMatchesQuery(noTags, 'kawaii')).toBe(false) // tag 没了
    })
  })

  describe('flattenEagleFolders', () => {
    it('空数组 → []', () => {
      expect(flattenEagleFolders([])).toEqual([])
    })
    it('嵌套 children 按 depth 平铺,保留 depth 标记,顺序为父→子→下一个父', () => {
      const folders = [
        { id: 'a', name: 'A', children: [{ id: 'a1', name: 'A1' }] },
        { id: 'b', name: 'B' },
      ]
      const flat = flattenEagleFolders(folders)
      expect(flat.map((f) => [f.id, f.depth])).toEqual([
        ['a', 0],
        ['a1', 1],
        ['b', 0],
      ])
    })
    it('children 为 undefined → 当作空,不崩', () => {
      const folders = [{ id: 'x', name: 'X' /* no children */ }]
      expect(flattenEagleFolders(folders).map((f) => [f.id, f.depth])).toEqual([['x', 0]])
    })
  })
})

describe('资产源总线契约 — AssetItem 数据结构面(总线"消息"字段锁)', () => {
  it('sampleAsset 含全部必填字段(若 AssetItem 必填字段变了,sampleAsset 构造会先编译红)', () => {
    // 这是编译期锁:sampleAsset 返回 AssetItem,缺必填字段 TS 报错。此 it 仅占位
    // 让契约在运行期也"可见",并锁 id 字段稳定(总线里唯一标识不能漂移)。
    const a = sampleAsset()
    expect(a.id).toBe('a1')
    expect(a.sourceId).toBe('local')
    expect(a.url).toBe('file:///imgs/cat.png')
  })

  it('AssetItem 必填字段集稳定(?raw 锁定义)', () => {
    // 锁 AssetItem type 的必填字段名 —— 改名/删字段 = 契约变更,本测试 fail。
    const match = assetLibrarySource.match(/export\s+type\s+AssetItem\s*=\s*\{([\s\S]*?)\}/)
    expect(match, 'AssetItem 类型定义消失 —— 结构被改?更新本测试').not.toBeNull()
    const body = match![1]
    // 必填(非可选)字段 —— 用 `field:` 且不在 `?:` 里。这里只锁字段名存在(可选/必填
    // 区分交给 TS 编译期),runtime 不易精确区分可选,故锁字段名集。
    for (const field of [
      'id', 'sourceId', 'sourceLabel', 'name', 'title', 'format',
      'sizeBytes', 'sourcePath', 'updatedAt', 'url',
    ]) {
      expect(body, `AssetItem 缺字段 ${field}`).toContain(field)
    }
  })
})
