#!/usr/bin/env node
// MivoCanvas 结构守卫 (Structure Guard) — P1-f phase 1 / SC5.2
//
// 防回潮守卫。本地可跑: node scripts/ci/structure-guard.mjs
// CI 中由 .github/workflows/ci.yml 的 structure-guard job 调用。
//
// 规则:
//  ① 行数守卫 — 递归扫描 src/store/ 与 src/canvas/ 下所有 .ts/.tsx 文件:
//     - 白名单(baseline.fileLines)内文件: 当前行数 > 记录基线 → FAIL(回潮)
//     - 白名单内 >900 行的已知存量: 仅 WARN(未增长即不 fail)
//     - 非白名单文件: 行数 > 900 → FAIL(新文件或新越线,需纳入基线或先拆分)
//  ② getState 守卫 — src/store/chatStore.ts 中 useCanvasStore.getState( 出现次数
//     > baseline.chatStoreGetStateCount → FAIL(跨 store 耦合回潮)
//
// 行数口径与 `wc -l` 一致(统计换行符数量)。
// 退出码: 0=通过(允许 WARN), 1=有 FAIL。
// 基线文件: scripts/ci/structure-guard.baseline.json

import { readFileSync, readdirSync, statSync } from 'node:fs'
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

// 与 `wc -l` 等价: 统计 '\n' 个数
function countLines(content) {
  return content.split('\n').length - 1
}

function countOccurrences(haystack, needle) {
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

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
  const base = sizeBaseline[rel]
  if (base !== undefined) {
    if (lines > base) {
      failures.push(
        `[FAIL] 行数回潮: ${rel} 从基线 ${base} 增长到 ${lines}(请拆分或在 baseline 中说明后下调)`
      )
    } else if (lines > THRESHOLD) {
      warnings.push(
        `[WARN] 已知存量 >${THRESHOLD}: ${rel} ${lines} 行(基线 ${base},未增长)`
      )
    }
    // 白名单内且 <= base 且 <= THRESHOLD: 沉默 OK
  } else if (lines > THRESHOLD) {
    failures.push(
      `[FAIL] 非 allowlist 文件 >${THRESHOLD} 行: ${rel} ${lines} 行(白名单未收录:拆分后入库,或在 baseline 中说明并上调)`
    )
  }
}

// --- 规则 ② getState 守卫 ---
const chatStorePath = join(REPO_ROOT, 'src', 'store', 'chatStore.ts')
let chatStoreSrc
try {
  chatStoreSrc = readFileSync(chatStorePath, 'utf8')
} catch {
  failures.push(`[FAIL] 缺失文件: ${relative(REPO_ROOT, chatStorePath)}(getState 守卫无法执行)`)
}

if (chatStoreSrc !== undefined) {
  const occurrences = countOccurrences(chatStoreSrc, STATE_CALL_PATTERN)
  const stateBase = baseline.chatStoreGetStateCount
  if (stateBase === undefined || stateBase === null) {
    failures.push(
      '[FAIL] 基线缺失: structure-guard.baseline.json 未记录 chatStoreGetStateCount'
    )
  } else if (occurrences > stateBase) {
    failures.push(
      `[FAIL] ${relative(REPO_ROOT, chatStorePath)} 中 ${STATE_CALL_PATTERN} 调用数 ${occurrences} > 基线 ${stateBase}(跨 store 耦合回潮:优先经事件/state setter 解耦,而非直接读 canvas store)`
    )
  } else {
    console.log(`[OK] ${relative(REPO_ROOT, chatStorePath)} ${STATE_CALL_PATTERN} = ${occurrences}(基线 ${stateBase})`)
  }
}

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
