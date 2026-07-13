// scripts/codemap.test.mjs — A7a-4 codemap 注释假阳性修复的 fixture 测试。
// codemap.mjs 的 scanFileImports 现经 extractSpecs 先剔 // 与 /* */ 注释,防 `from '...'`
// 出现在注释里被误判为 import edge(原假阳性:canvasStore.ts:18 自环注释 +
// canvasStateTypes.ts:7 注释,把真值 27 报成 29)。
//
// 本文件为 .mjs:codemap.mjs 是无 .d.ts 的 ESM 脚本,.ts 导入会触发 TS7016;
// vitest 默认 include 覆盖 .test.mjs,且 .mjs 不经 tsc -b,避免类型摩擦。
import { describe, it, expect } from 'vitest'
import { extractSpecs, stripJsonComments } from './codemap.mjs'

describe('codemap extractSpecs (A7a-4: 注释假阳性修复)', () => {
  it('行注释内的 from 不计为 import edge', () => {
    const content = [
      "// 下游 `import type { CanvasState, SliceCreator, ... } from './canvasStore'` 路径零改动。",
      "import { useFoo } from './realDep'",
    ].join('\n')
    const specs = extractSpecs(content)
    expect(specs.has('./canvasStore')).toBe(false) // 注释里的 from 被剔
    expect(specs.has('./realDep')).toBe(true)
  })

  it('块注释内的 from 不计为 import edge', () => {
    const content = [
      '/* Re-export shim — the implementation moved.',
      "   import {x} from './shimTarget' */",
      "import { real } from './realDep'",
    ].join('\n')
    const specs = extractSpecs(content)
    expect(specs.has('./shimTarget')).toBe(false)
    expect(specs.has('./realDep')).toBe(true)
  })

  it('真实静态 import / 动态 import() 正常提取', () => {
    const content = [
      "import { a } from './staticDep'",
      "const b = await import('./dynamicDep')",
    ].join('\n')
    const specs = extractSpecs(content)
    expect(specs.has('./staticDep')).toBe(true)
    expect(specs.has('./dynamicDep')).toBe(true)
  })

  it('自环注释(原 canvasStore.ts:18 假阳性)不计为 self-edge', () => {
    // 原注释 // `import type { ... } from './canvasStore'` 让 codemap 把 canvasStore
    // 自身算成自环(canvasStore → canvasStore),是 27→29 假阳性之一。
    const content = [
      "// `import type { CanvasState, SliceCreator, ... } from './canvasStore'`",
      "import { scenes } from './demoScenes'",
    ].join('\n')
    const specs = extractSpecs(content)
    expect(specs.has('./canvasStore')).toBe(false)
    expect(specs.has('./demoScenes')).toBe(true)
  })

  it('多行 import 语句(换行 spec)正常提取', () => {
    const content = [
      'import {',
      '  a,',
      '  b,',
      "} from './multiLine'",
    ].join('\n')
    const specs = extractSpecs(content)
    expect(specs.has('./multiLine')).toBe(true)
  })
})

describe('codemap stripJsonComments', () => {
  it('剔除 // 行注释与 /* */ 块注释,保留字符串内 //', () => {
    const input = [
      'const url = "http://example.com" // tail comment',
      '/* block comment */ const x = 1',
    ].join('\n')
    const out = stripJsonComments(input)
    expect(out).not.toContain('block comment')
    expect(out).not.toContain('tail comment')
    expect(out).toContain('http://example.com') // 字符串内的 // 不被误剔
  })
})
