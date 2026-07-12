#!/usr/bin/env node
// MivoCanvas 结构守卫 (Structure Guard) v2 — P1-f phase 1 / SC5.2
//
// v2 语义(2026-07-04):从「绝对行数基线」改为「PR 增量」。
//   动机:绝对基线被 main 上并行功能开发的自然增长击穿(canvasStore 3168→3180
//   等),P2 拆分落地前每次 main 合并都会误伤。增量语义只盯本 PR 让大文件变大。
//
// 规则:
//  ① 行数守卫 — 递归扫描 src/store/ 与 src/canvas/ 下所有 .ts/.tsx 文件:
//     - 白名单(baseline.fileLines)内文件(存量大文件):
//         有 base 时(CI / 本地有 origin/main):当前行数 > merge-base 处行数 → FAIL
//             (本 PR 让大文件变大才 fail;main 自然增长不算)
//         无 base 时(本地无 origin/main 且无 MIVO_GUARD_BASE_SHA):回退 baseline.json,
//             当前 > baseline 仅 WARN(CI 不走此分支)
//     - 非白名单文件:行数 > 900 → FAIL(绝对值,不变;新文件或新越线)
//  ② getState 守卫 — src/store/chatStore.ts 中 useCanvasStore.getState( 出现次数:
//     - 有 base 时:当前 > merge-base 处计数 → FAIL(PR 增长才算)
//     - 无 base 时:回退 baseline.json 仅 WARN
//
// base 解析顺序:1) env MIVO_GUARD_BASE_SHA(CI 注入 github.event.pull_request.base.sha)
//               2) git merge-base HEAD origin/main(本地)
//               3) 都没有 → 无 base 模式(白名单/getState 只 WARN)
//
// 行数口径与 `wc -l` 一致(统计换行符数量)。
// 退出码:0=通过(允许 WARN),1=有 FAIL。
// 基线文件:scripts/ci/structure-guard.baseline.json(v2 起为参考记录,非硬门槛)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// MIVO_GUARD_ROOT 允许 fixture 测试把扫描根重定向到临时目录(默认 = 仓根)。
const REPO_ROOT = process.env.MIVO_GUARD_ROOT ? resolve(process.env.MIVO_GUARD_ROOT) : resolve(__dirname, '..', '..')
const THRESHOLD = 900
const STATE_CALL_PATTERN = 'useCanvasStore.getState('

// --- server 分层方向规则(rule ④)辅助函数(A7a-3)---
// server 文件的模块归类:server/lib, server/routes, server/persist, server/platform, server/tasks, server。
function serverModuleOf(rel) {
  const parts = rel.split('/')
  if (parts.length >= 3 && parts[0] === 'server') return `${parts[0]}/${parts[1]}`
  return parts[0]
}
// 轻量 lexer:逐字符扫描,跟踪 ' / " / ` / 注释状态,只在 code 状态识别 import token
// (from '...' / import('...') / 裸 import '...'),提取相对 specifier。
// A7a 第二轮返修 P2:原 stripSourceComments+regex 保留字符串内容 → 字符串/模板内的
// `import '../routes/r'` 被当真实 import 误红守卫(sol 只读探针实证)。lexer 在
// string/template/comment 状态跳过内容,只从 code 位置提取,根治字符串假阳性。
function scanRelativeSpecs(content) {
  const specs = new Set()
  const n = content.length
  let i = 0
  // 状态:0=code, 1=lineComment, 2=blockComment, 3=strSingle, 4=strDouble, 5=strTemplate
  let state = 0
  const isIdent = (c) => !!c && /[A-Za-z0-9_$]/.test(c)
  const isRelative = (s) => s.startsWith('./') || s.startsWith('../')
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  // 从当前 i(指向开引号)读引号内 specifier;i 推进到闭合引号后;返回原文(不含引号)。
  const readQuoted = () => {
    const q = content[i]
    i++ // 开引号
    let s = ''
    while (i < n) {
      const c = content[i]
      if (c === '\\') { s += content[i + 1] || ''; i += 2; continue } // 转义(路径无转义,防误判)
      if (c === q) { i++; break }
      s += c
      i++
    }
    return s
  }
  // 检测 i 处是否为关键字 kw(左右均非 ident = 词边界)。
  const atKeyword = (kw) => {
    if (content[i] !== kw[0] || !content.startsWith(kw, i)) return false
    if (isIdent(content[i + kw.length])) return false // 右边界(importA / fromB 不算)
    if (i > 0 && isIdent(content[i - 1])) return false // 左边界(ximport / xfrom 不算)
    return true
  }
  while (i < n) {
    const c = content[i]
    const nx = content[i + 1]
    switch (state) {
      case 0: // code
        if (c === '/' && nx === '/') { state = 1; i += 2; continue }
        if (c === '/' && nx === '*') { state = 2; i += 2; continue }
        if (c === "'") { state = 3; i++; continue } // 字符串/模板字面量 → 跳过其内容(不入 specs)
        if (c === '"') { state = 4; i++; continue }
        if (c === '`') { state = 5; i++; continue }
        // from <ws> '...' / "..."(static import/export ... from '...')
        if (atKeyword('from')) {
          let j = i + 4
          while (j < n && isWs(content[j])) j++
          if (content[j] === "'" || content[j] === '"') {
            i = j
            const s = readQuoted()
            if (isRelative(s)) specs.add(s)
            continue
          }
        }
        // import( '...' (dynamic) / import '...' (bare side-effect)
        if (atKeyword('import')) {
          let k = i + 6
          while (k < n && isWs(content[k])) k++
          if (content[k] === '(') {
            // dynamic import('...')
            k++
            while (k < n && isWs(content[k])) k++
            if (content[k] === "'" || content[k] === '"') {
              i = k
              const s = readQuoted()
              if (isRelative(s)) specs.add(s)
              continue
            }
          } else if (content[k] === "'" || content[k] === '"') {
            // bare side-effect import '...'
            i = k
            const s = readQuoted()
            if (isRelative(s)) specs.add(s)
            continue
          }
          // else: import { ... } / import type / import * — 由后续 from 分支提取,此处只前进
        }
        i++
        continue
      case 1: // line comment
        if (c === '\n') state = 0
        i++; continue
      case 2: // block comment
        if (c === '*' && nx === '/') { state = 0; i += 2; continue }
        i++; continue
      case 3: // str single
      case 4: // str double
        if (c === '\\') { i += 2; continue }
        if ((state === 3 && c === "'") || (state === 4 && c === '"')) { state = 0; i++; continue }
        i++; continue
      case 5: // str template(简化:不递归 ${};模板内的 import 当字符串内容跳过)
        if (c === '\\') { i += 2; continue }
        if (c === '`') { state = 0; i++; continue }
        i++; continue
    }
  }
  return [...specs]
}
// 把相对 spec 解析为 posix 仓内相对路径(仅路径规范化,不查 FS)。
function resolveSpecPath(spec, fromFileRel) {
  if (!spec.startsWith('.')) return null
  const slashIdx = fromFileRel.lastIndexOf('/')
  const segs = slashIdx >= 0 ? fromFileRel.slice(0, slashIdx).split('/') : []
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') { segs.pop(); continue }
    segs.push(part)
  }
  return segs.join('/')
}
// Rule ④: server 非 routes 层(lib/persist/platform/tasks)禁 import server/routes。
// routing 是 server 顶层,下层不得反向依赖 routes。纯函数(入参 [{rel, content}]),便于 fixture 红测。
export function checkServerDirectionRule(files) {
  const violations = []
  for (const f of files) {
    if (!f.rel.startsWith('server/')) continue
    const mod = serverModuleOf(f.rel)
    if (mod === 'server/routes' || mod === 'server') continue
    for (const spec of scanRelativeSpecs(f.content)) {
      const target = resolveSpecPath(spec, f.rel)
      if (target && (target === 'server/routes' || target.startsWith('server/routes/'))) {
        violations.push(`[FAIL] server 分层方向: ${f.rel}(${mod}) import ${spec} → ${target}(server/routes) — 非 routes 层禁依赖 server/routes(routing 是顶层)`)
      }
    }
  }
  return violations
}

const baselinePath = join(__dirname, 'structure-guard.baseline.json')
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))

const warnings = []
const failures = []

function listTsFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(cur, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(full)
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(full)
      }
    }
  }
  return out
}

const countLines = (content) => content.split('\n').length - 1

function countOccurrences(haystack, needle) {
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

// --- base SHA 解析 ---
// 取 merge-base(HEAD, ref) 共同祖先,而非 ref 本身:避免 ref(base)在该文件上
// 减行时(PR head 没改却 > base)的误报。ref 优先 env(CI 注入 PR base SHA),
// 否则 origin/main(本地)。
function resolveBaseSha() {
  const ref = process.env.MIVO_GUARD_BASE_SHA?.trim() || 'origin/main'
  try {
    const mb = execSync(`git merge-base HEAD ${ref}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    if (mb) return mb
  } catch {
    // ref 不存在或 git 不可用
  }
  return null
}

const baseSha = resolveBaseSha()
const hasBase = baseSha !== null

// 取 base SHA 处某文件内容;文件在 base 不存在(新文件)返回 null。
function fileContentAtSha(sha, relPath) {
  try {
    return execSync(`git show ${sha}:${relPath}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

const refDesc = process.env.MIVO_GUARD_BASE_SHA
  ? `env MIVO_GUARD_BASE_SHA="${process.env.MIVO_GUARD_BASE_SHA}"`
  : 'origin/main'
console.log(
  hasBase
    ? `[info] base = ${baseSha.slice(0, 10)}(merge-base HEAD ${refDesc}) — 增量语义(PR 增长才 FAIL)`
    : `[info] 无 base 可比(ref ${refDesc} 不可达)— 白名单/getState 回退 baseline.json 仅 WARN(CI 用增量语义)`
)

// --- 规则 ① 行数守卫 ---
const scanDirs = (baseline._scannedDirs || ['src/store', 'src/canvas']).map((d) =>
  join(REPO_ROOT, d)
)
const sizeBaseline = {}
for (const [k, v] of Object.entries(baseline.fileLines || {})) {
  sizeBaseline[k.replace(/\\/g, '/')] = v
}

const allFiles = []
for (const d of scanDirs) allFiles.push(...listTsFiles(d))

for (const f of allFiles) {
  const rel = relative(REPO_ROOT, f).replace(/\\/g, '/')
  const content = readFileSync(f, 'utf8')
  const lines = countLines(content)
  const isWhitelisted = sizeBaseline[rel] !== undefined

  if (isWhitelisted) {
    if (hasBase) {
      // 增量语义:vs merge-base 处行数
      const baseContent = fileContentAtSha(baseSha, rel)
      const baseLines = baseContent !== null ? countLines(baseContent) : 0
      if (lines > baseLines) {
        failures.push(
          `[FAIL] PR 增长: ${rel} 从 merge-base ${baseLines} 增长到 ${lines}(本 PR 让存量大文件变大;请拆分,或在 PR 描述说明后下调 baseline)`
        )
      } else if (lines > THRESHOLD) {
        warnings.push(
          `[WARN] 已知存量 >${THRESHOLD}: ${rel} ${lines} 行(merge-base ${baseLines},本 PR 未增长)`
        )
      }
    } else {
      // 本地无 base:回退 baseline.json 仅 WARN
      const base = sizeBaseline[rel]
      if (lines > base) {
        warnings.push(
          `[WARN] ${rel} ${lines} 行 > baseline ${base}(本地无 merge-base 可比,仅 WARN;CI 用增量语义判定)`
        )
      } else if (lines > THRESHOLD) {
        warnings.push(`[WARN] 已知存量 >${THRESHOLD}: ${rel} ${lines} 行(baseline ${base})`)
      }
    }
  } else if (lines > THRESHOLD) {
    // 非白名单 >900 → FAIL(绝对,不变)
    failures.push(
      `[FAIL] 非 allowlist 文件 >${THRESHOLD} 行: ${rel} ${lines} 行(拆分后入库,或在 baseline 中说明并上调)`
    )
  }
}

// --- 规则 ② getState 守卫 ---
const chatStoreRel = 'src/store/chatStore.ts'
const chatStorePath = join(REPO_ROOT, chatStoreRel)
let chatStoreSrc
try {
  chatStoreSrc = readFileSync(chatStorePath, 'utf8')
} catch {
  failures.push(`[FAIL] 缺失文件: ${chatStoreRel}(getState 守卫无法执行)`)
}

if (chatStoreSrc !== undefined) {
  const occurrences = countOccurrences(chatStoreSrc, STATE_CALL_PATTERN)
  if (hasBase) {
    const baseSrc = fileContentAtSha(baseSha, chatStoreRel)
    const baseCount = baseSrc !== null ? countOccurrences(baseSrc, STATE_CALL_PATTERN) : 0
    if (occurrences > baseCount) {
      failures.push(
        `[FAIL] ${chatStoreRel} 中 ${STATE_CALL_PATTERN} 调用数 ${occurrences} > merge-base ${baseCount}(本 PR 新增跨 store 直调;优先经事件/state setter 解耦)`
      )
    } else {
      console.log(`[OK] ${chatStoreRel} ${STATE_CALL_PATTERN} = ${occurrences}(merge-base ${baseCount})`)
    }
  } else {
    const stateBase = baseline.chatStoreGetStateCount
    if (occurrences > stateBase) {
      warnings.push(
        `[WARN] ${chatStoreRel} ${STATE_CALL_PATTERN} ${occurrences} > baseline ${stateBase}(本地无 merge-base,仅 WARN)`
      )
    } else {
      console.log(`[OK] ${chatStoreRel} ${STATE_CALL_PATTERN} = ${occurrences}(baseline ${stateBase})`)
    }
  }
}

// --- 规则 ③ mockGeneration ban(roadmap §13 防回潮明文项)---
// 生产路径(排除 *.test.* / *.spec.* / __tests__)出现 mockGeneration 引用或
// mockGenerationAdapter import 即 FAIL。当前基线 0(P2-C2 去 mock 后,已删
// src/store/mockGeneration.ts);任何命中即红(防止 variations/annotation 重新
// 走 mock 回潮)。测试 fixture 放 *.test.* 或 __tests__。
const PROD_BAN_PATTERNS = ['mockGeneration', 'mockGenerationAdapter']
const prodBanFiles = listTsFiles(join(REPO_ROOT, 'src')).filter(
  (f) => !/\.(test|spec)\.(ts|tsx)$/.test(f) && !/__tests__/.test(f)
)
let banHits = 0
for (const f of prodBanFiles) {
  const rel = relative(REPO_ROOT, f).replace(/\\/g, '/')
  const content = readFileSync(f, 'utf8')
  for (const pattern of PROD_BAN_PATTERNS) {
    if (content.includes(pattern)) {
      banHits++
      failures.push(
        `[FAIL] 生产路径引用 ${pattern}: ${rel}(roadmap §13 防回潮:variations/annotation 须接真端点,禁走 mock;测试 fixture 放 *.test.* 或 __tests__)`
      )
    }
  }
}
console.log(`[OK] mockGeneration/mockGenerationAdapter 生产路径 ban: ${prodBanFiles.length} 个生产文件扫描,${banHits} 命中(基线 0,任何命中即 FAIL)`)

// --- 规则 ④ server 分层方向(非 routes 层禁 import server/routes;A7a-3)---
// routing 是 server 顶层,lib/persist/platform/tasks 不得反向 import routes。当前基线 0
// (codemap 模块图:仅 server/routes → 其它,无反向)。绝对 FAIL(同 rule ③,不依赖 base)。
const serverScanFiles = listTsFiles(join(REPO_ROOT, 'server')).filter(
  (f) => !/\.(test|spec)\.(ts|tsx)$/.test(f) && !/__tests__/.test(f)
)
const serverFileList = serverScanFiles.map((f) => ({
  rel: relative(REPO_ROOT, f).replace(/\\/g, '/'),
  content: readFileSync(f, 'utf8'),
}))
const dirViolations = checkServerDirectionRule(serverFileList)
for (const v of dirViolations) failures.push(v)
console.log(`[OK] server 分层方向: ${serverFileList.length} 个生产 server 文件扫描,${dirViolations.length} 方向违规(基线 0,非 routes→routes 即 FAIL)`)

// --- 汇总 ---
console.log(`\n结构守卫: ${allFiles.length} 个文件扫描完毕,${failures.length} FAIL,${warnings.length} WARN`)

if (warnings.length) {
  console.log('\n--- WARNINGS ---')
  for (const w of warnings) console.log(w)
}

if (failures.length) {
  console.log('\n--- FAILURES ---')
  for (const f of failures) console.log(f)
  process.exit(1)
}

process.exit(0)
