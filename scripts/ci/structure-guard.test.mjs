// scripts/ci/structure-guard.test.mjs — A7a-3 新规则红测。
// 两条新规则各配「故意违规 → FAIL」+「干净 → PASS」:
//  ④ server 分层方向(非 routes 层禁 import server/routes)
//  ① 扩面:src/app 入扫描(LibraryWorkspace 白名单;非白名单 >900 绝对 FAIL)
//
// 用 MIVO_GUARD_ROOT 把扫描根重定向到临时 fixture 目录,spawn 真守卫脚本,验实际行为。
// .mjs:守卫是无 .d.ts 的 ESM 脚本,.ts 导入触发 TS7016;且守卫内联执行(导入会跑全脚本),
// 故走 spawn 集成而非单测。
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const GUARD = join(process.cwd(), 'scripts', 'ci', 'structure-guard.mjs')
const fixtures = []
afterEach(() => {
  for (const d of fixtures) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
  fixtures.length = 0
})

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'mivo-guard-'))
  for (const f of files) {
    const abs = join(root, f.path)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, f.content)
  }
  fixtures.push(root)
  return root
}

function runGuard(root) {
  // fixture 在 tmpdir(非 git 仓)→ 守卫走 no-base 模式(白名单/getState 仅 WARN),
  // 但 rule ③ mockGeneration ban 与 rule ④ server 方向与新文件的 >900 绝对 FAIL 仍生效。
  try {
    const out = execFileSync('node', [GUARD], {
      cwd: root,
      env: { ...process.env, MIVO_GUARD_ROOT: root },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { exit: 0, out }
  } catch (e) {
    return { exit: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// 最小 chatStore fixture:让 rule ②(getState 守卫,硬编码读 src/store/chatStore.ts)能读到文件、
// 不产生「缺失文件」FAIL。0 处 useCanvasStore.getState(,no-base 下 0>0 不报。
const CHATSTORE = { path: 'src/store/chatStore.ts', content: 'export const useChatStore = { setState() {}, getState() {} }\n' }
const bigTsx = (n) => `${'// line\n'.repeat(n)}`

describe('structure-guard rule ④ server 分层方向 (A7a-3)', () => {
  it('RED: server/lib import server/routes → FAIL + 方向违规消息', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "import { r } from '../routes/r'\n" },
      { path: 'server/routes/r.ts', content: 'export const r = 1\n' },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(1)
    expect(out).toContain('server 分层方向')
    expect(out).toContain('server/lib/x.ts')
    expect(out).toContain('server/routes')
  })

  it('CLEAN: server/lib import server/persist(非 routes)→ PASS', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "import { p } from '../persist/p'\n" },
      { path: 'server/persist/p.ts', content: 'export const p = 1\n' },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向') // OK 汇总行含 "server 分层方向",只判 FAIL 前缀
  })

  it('CLEAN: server/routes import server/lib(routes 是顶层,正向)→ PASS', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/routes/r.ts', content: "import { lib } from '../lib/l'\n" },
      { path: 'server/lib/l.ts', content: 'export const lib = 1\n' },
    ])
    const { exit } = runGuard(root)
    expect(exit).toBe(0)
  })

  it('CLEAN: 注释内的 `from ../routes` 不误判(stripSourceComments 剔注释)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "// import { r } from '../routes/r'\nimport { p } from '../persist/p'\n" },
      { path: 'server/persist/p.ts', content: 'export const p = 1\n' },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
  })

  // A7a 返修 P2-2:side-effect 裸 import `import '../routes/r'`(无 from 无 ())原两 regex 都不命中,
  // rule④ 可被绕过。补 RE_GUARD_SIDE 收口 + RED fixture。
  it('RED: side-effect 裸 import `import "../routes/r"`(server/lib)→ FAIL', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "import '../routes/r'\n" },
      { path: 'server/routes/r.ts', content: 'export const r = 1\n' },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(1)
    expect(out).toContain('[FAIL] server 分层方向')
    expect(out).toContain('server/lib/x.ts')
  })

  it('CLEAN: side-effect 裸 import 在 server/routes 内(exempt,正向)→ PASS', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/routes/r.ts', content: "import '../lib/l'\n" },
      { path: 'server/lib/l.ts', content: 'export const l = 1\n' },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
  })

  it('CLEAN: side-effect 裸 import 在注释内 → PASS(剔注释)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "// import '../routes/r'\nimport { p } from '../persist/p'\n" },
      { path: 'server/persist/p.ts', content: 'export const p = 1\n' },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
  })

  // A7a 第二轮返修 P2:RE_GUARD_SIDE 字符串假阳性——lexer 只从 code 位置提取,字符串/模板内的
  // `import '...'` 当字符串内容跳过,不误红。3 CLEAN fixture:
  it('CLEAN: 普通字符串含 `import "../routes/r"` 文本 → PASS(lexer 跳过字符串内容)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: `const sample = "import '../routes/r'"\n` },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
    expect(out).not.toContain('server/lib/x.ts')
  })

  it('CLEAN: 模板字符串含 `import "../routes/r"` 文本 → PASS(lexer 跳过模板内容)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "const sample = `import '../routes/r'`\n" },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
  })

  it('CLEAN: 裸 import 非 relative(`import "polyfill"`)→ PASS(非 ./ ../,非 routes back-edge)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "import 'polyfill'\n" },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
  })

  // A7a 第三轮返修(lead 指定 + sol 探针):改走 TS AST 后,补手写 lexer 漏检/误报的三例边界。
  it('RED: 模板插值内 dynamic import("../routes/r") → FAIL(AST 递归进 ${} 找到 CallExpression)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "const url = `${import('../routes/r')}?q=1`\n" },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(1)
    expect(out).toContain('[FAIL] server 分层方向')
    expect(out).toContain('server/lib/x.ts')
  })

  it('RED: 正则字面量后下一行真实 side-effect import → FAIL(AST 不被正则误切状态吞下行)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "const re = /['\"]/\nimport '../routes/r'\n" },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(1)
    expect(out).toContain('[FAIL] server 分层方向')
    expect(out).toContain('server/lib/x.ts')
  })

  it('CLEAN: 正则字面量仅含 import routes 文本 → PASS(AST 当 RegexLiteral,不提取)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'server/lib/x.ts', content: "const re = /import routes r/\n" },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('[FAIL] server 分层方向')
  })
})

describe('structure-guard rule ① 扩面:src/app 入扫描 (A7a-3)', () => {
  it('RED: src/app 非白名单文件 >900 行 → FAIL', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'src/app/BigFile.tsx', content: bigTsx(901) },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(1)
    expect(out).toContain('src/app/BigFile.tsx')
    expect(out).toMatch(/>900/)
  })

  it('CLEAN: src/app 文件 <900 行 → PASS(扫描覆盖但不误伤)', () => {
    const root = makeFixture([
      CHATSTORE,
      { path: 'src/app/SmallFile.tsx', content: bigTsx(100) },
    ])
    const { exit, out } = runGuard(root)
    expect(exit).toBe(0)
    expect(out).not.toContain('BigFile')
  })
})
