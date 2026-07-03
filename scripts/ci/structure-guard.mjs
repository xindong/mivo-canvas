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
const REPO_ROOT = resolve(__dirname, '..', '..')
const THRESHOLD = 900
const STATE_CALL_PATTERN = 'useCanvasStore.getState('

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
