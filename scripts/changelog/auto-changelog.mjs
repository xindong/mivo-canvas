#!/usr/bin/env node
// auto-changelog.mjs — 更新日志补扫脚本(机械步骤确定性,rewrite 直调 LLM API)
//
// 把 generate-changelog skill「自动模式」里所有机械步骤下沉为确定性脚本,
// 只留"口语化改写"一步直调 OpenAI-compatible LLM 网关。三步编排:
//   1. scan    — fetch + git log 差集 + 归天,产出 /tmp/mivo-changelog-scan.json
//   2. rewrite — 按 REWRITE_PROMPT.md 调 LLM 只产出 PR→文案映射
//   3. publish — 确定性组装 date/by/kind/prs + 建临时 worktree + 合并写回 changelog.json + 开 PR + 轮询 CI + 线程清理 + squash merge
//
// 语义规格见 .claude/skills/generate-changelog/SKILL.md(机械步骤已由本脚本承载,
// skill 仅保留 SOP 作为语义说明)。运行手册见 ./RUNBOOK.md。
//
// 零 npm 依赖,只用 node 内置(fetch) + child_process 调 git/gh。Node ≥18。
// 退出码:0=成功(含空跑);非 0=失败(stderr 打印原因,GitHub Actions run 红灯通知)。

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const CHANGELOG_REL = 'public/changelog.json'
const REWRITE_PROMPT_REL = 'scripts/changelog/REWRITE_PROMPT.md'
const SCAN_OUTPUT_DEFAULT = '/tmp/mivo-changelog-scan.json'
const REWRITE_OUTPUT_DEFAULT = '/tmp/mivo-changelog-rewrite.json'
const LLM_API_BASE_DEFAULT = 'https://llm-proxy.tapsvc.com/v1'
const LLM_MODEL_DEFAULT = 'claude-haiku-4-5'
const REWRITE_MAX_RETRIES = 2
const REWRITE_TIMEOUT_MS_DEFAULT = 120_000
const CHANGELOG_TIME_ZONE = 'Asia/Shanghai'
const REPO_SLUG = process.env.GITHUB_REPOSITORY || 'xindong/mivo-canvas'
const [REPO_OWNER, REPO_NAME] = REPO_SLUG.split('/')

// ---- 归天:与 src/lib/changelogDate.ts 的 toChangelogDay 语义一致 ----
// 8:00 本地时区为界:07:59 归前一天,08:00 起归当天。禁用 toISOString(UTC 日会错移边界)。
const DAY_BOUNDARY_HOUR = 8
const HOUR_MS = 3_600_000

const pad2 = (n) => String(n).padStart(2, '0')

const formatLocalDay = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

// 入参是 git %cI 的 ISO 串(带偏移,如 2026-07-05T07:59:00+08:00)。
const toChangelogDay = (isoTs) => {
  const t = new Date(isoTs).getTime() - DAY_BOUNDARY_HOUR * HOUR_MS
  return formatLocalDay(new Date(t))
}

// 本地时间戳(+08:00 冒号形态),供 updatedAt。等价 `date +%Y-%m-%dT%H:%M:%S%z` 加冒号。
const localNowIso = () => {
  const now = new Date()
  const off = -now.getTimezoneOffset() // 东为正
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const oh = pad2(Math.floor(abs / 60))
  const om = pad2(abs % 60)
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}` +
    `${sign}${oh}:${om}`
  )
}

// ---- PR 识别双模式 ----
// squash 形态(当前主流):subject 以 (#N) 结尾
const SQUASH_PR_RE = /\(#(\d+)\)\s*$/
// merge 形态(历史遗留):subject 匹配 Merge pull request #N
const MERGE_PR_RE = /^Merge pull request #(\d+)/
// 自身 meta-PR(更新日志补扫自身)不收录——既有惯例
const META_PR_SUBJECT_RE = /^chore: 更新日志补扫/

// ---- 改写文本代码术语黑名单(写死,不信任 LLM) ----
// 命中即拒绝。整词匹配(大小写不敏感)。代码词汇 = 函数名/文件名/组件名/工具链名等。
// 列表可调,但要维持"宁可误伤也不放行代码词"的取向。中文口语化文本不应出现这些英文词。
const BLACKLIST = [
  'preflight', 'ci', 'tsc', 'lint', 'eslint', 'hook', 'store', 'ipc',
  'crud', 'bff', 'basic auth', 'api', 'prompt', 'token', 'refactor',
  'commit', 'merge', 'pm2', 'github', 'gitlab', 'npm', 'vite', 'react',
  'zustand', 'leafer', 'tsx', 'oauth', 'secret', 'config', 'deploy',
  'proxy', 'selector', 'e2e', 'playwright', 'vitest', 'typecheck',
  'squash', 'workflow', 'sha', 'hash', 'diff', 'cache', 'async', 'await',
  'promise', 'slice', 'memo', 'component', 'props', 'callback', 'dispatch',
  'reducer', 'plugin', 'schema', 'http', 'url', 'cors', 'auth', 'session',
  'cookie', 'endpoint', 'route', 'handler', 'node', 'env',
]

// UI 文案里的合法用户词。黑名单扫描前先剔除这些短语;裸 api/API 仍会被拦。
const BLACKLIST_ALLOW_PHRASES = [
  /API\s*密钥/g,
]

const BLACKLIST_RES = BLACKLIST.map((term) => ({
  term,
  re: new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`, 'i'),
}))

const scanBlacklist = (text) => {
  const textForScan = BLACKLIST_ALLOW_PHRASES.reduce((out, re) => out.replace(re, ''), text)
  const hits = []
  for (const { term, re } of BLACKLIST_RES) {
    if (re.test(textForScan)) hits.push(term)
  }
  return hits
}

const classifyKind = (subject) => {
  const prefix = String(subject).match(/^([a-z]+)(?:\([^)]+\))?!?:/i)?.[1]?.toLowerCase()
  if (prefix === 'feat') return 'features'
  if (prefix === 'fix') return 'fixes'
  // generate-changelog skill: other prefixes are included and described低调.
  // In unattended mode we keep that deterministic by placing non-feat changes in fixes.
  return 'fixes'
}

// ---- 子进程封装 ----
// opts.allowFail:出错返回 null 而非抛异常(供降级路径)
// opts.cwd:默认 REPO_ROOT;worktree 内操作用 git -C <path> 切换更可靠
// opts.env:额外环境变量(如 PREFLIGHT_SKIP)
const runGit = (args, opts = {}) => {
  try {
    return execFileSync('git', args, {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    }).trimEnd()
  } catch (err) {
    if (opts.allowFail) return null
    const stderr = err.stderr ? err.stderr.toString().trim() : ''
    const msg = `git ${args.join(' ')} 失败(退出码 ${err.status ?? '?'}): ${err.message}${stderr ? ` | stderr: ${stderr}` : ''}`
    throw new Error(msg)
  }
}

const runGh = (args, opts = {}) => {
  try {
    return execFileSync('gh', args, {
      cwd: opts.cwd ?? REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    }).trimEnd()
  } catch (err) {
    if (opts.allowFail) return null
    const stderr = err.stderr ? err.stderr.toString().trim() : ''
    const msg = `gh ${args.join(' ')} 失败(退出码 ${err.status ?? '?'}): ${err.message}${stderr ? ` | stderr: ${stderr}` : ''}`
    throw new Error(msg)
  }
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          viewerCanReply
          viewerCanResolve
          comments(first: 20) {
            nodes {
              author {
                login
              }
              body
              createdAt
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`

const ADD_REVIEW_THREAD_REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment {
      id
    }
  }
}
`

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}
`

const runGhGraphql = (query, variables, opts = {}) => {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables || {})) {
    if (value === undefined || value === null) continue
    args.push('-F', `${key}=${value}`)
  }
  const out = runGh(args, opts)
  try {
    return JSON.parse(out)
  } catch (err) {
    throw new Error(`gh api graphql 响应不是 JSON:${err.message}; body=${trimForError(out)}`)
  }
}

const fetchReviewThreads = (prNumber, opts = {}) => {
  const threads = []
  let after = null
  for (;;) {
    const data = runGhGraphql(
      REVIEW_THREADS_QUERY,
      {
        owner: REPO_OWNER,
        name: REPO_NAME,
        number: prNumber,
        after,
      },
      opts,
    )
    const pullRequest = data?.data?.repository?.pullRequest
    if (!pullRequest) {
      throw new Error(`GraphQL 未返回 PR #${prNumber} 数据`)
    }
    const conn = pullRequest.reviewThreads
    threads.push(...(conn?.nodes || []))
    if (!conn?.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor
    if (!after) break
  }
  return threads
}

const stripReviewCommentForSummary = (body) =>
  String(body || '')
    .replace(/<details[\s\S]*?<\/details>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

const summarizeReviewThread = (thread) => {
  const comment = thread?.comments?.nodes?.[0]
  const body = stripReviewCommentForSummary(comment?.body)
  if (!body) return '未能提取原评论正文'
  const author = comment?.author?.login ? `@${comment.author.login}: ` : ''
  const summary = body.length > 220 ? `${body.slice(0, 220)}...` : body
  return `${author}${summary}`
}

const buildAutoResolveReply = (summary) => (
  `此 PR 为每日更新日志自动补扫产物，仅含 ${CHANGELOG_REL}。` +
  '内容经脚本硬校验（PR 覆盖/日期/作者由 scan 确定性生成，文案过黑名单）。' +
  '意见已记录；如需调整规则，请修改 scripts/changelog/。\n\n' +
  `原评论要点：${summary}`
)

const resolveChangelogReviewThreads = ({ prNumber, headRefName, files, cwd }) => {
  if (!headRefName || !/^chore\/changelog-/.test(headRefName)) {
    throw new Error(`线程清理拒绝执行:headRefName=${headRefName} 不匹配 ^chore/changelog-`)
  }
  const illegal = files.filter((f) => f !== CHANGELOG_REL)
  if (files.length === 0 || illegal.length > 0) {
    throw new Error(`线程清理拒绝执行:PR files 非 changelog-only,files=[${files.join(', ')}]`)
  }

  const unresolved = fetchReviewThreads(prNumber, { cwd }).filter((thread) => !thread.isResolved)
  if (unresolved.length === 0) {
    process.stderr.write(`[auto-changelog] PR #${prNumber} 无 unresolved review thread\n`)
    return
  }

  process.stderr.write(`[auto-changelog] PR #${prNumber} 有 ${unresolved.length} 条 unresolved review thread,自动回复并 resolve...\n`)
  for (const thread of unresolved) {
    if (!thread.viewerCanReply || !thread.viewerCanResolve) {
      throw new Error(
        `线程清理失败:当前 token 无法 reply/resolve thread ${thread.id}` +
          `(viewerCanReply=${thread.viewerCanReply},viewerCanResolve=${thread.viewerCanResolve})`,
      )
    }
    const replyBody = buildAutoResolveReply(summarizeReviewThread(thread))
    runGhGraphql(
      ADD_REVIEW_THREAD_REPLY_MUTATION,
      {
        threadId: thread.id,
        body: replyBody,
      },
      { cwd },
    )
    runGhGraphql(
      RESOLVE_REVIEW_THREAD_MUTATION,
      {
        threadId: thread.id,
      },
      { cwd },
    )
    process.stderr.write(`[auto-changelog] 已回复并 resolve review thread ${thread.id}\n`)
  }
}

const mergePullRequestWithPolicyRetry = async (prNumber, cwd) => {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      runGh(['pr', 'merge', String(prNumber), '--squash'], { cwd })
      return
    } catch (err) {
      const policyBlocked = /base branch policy prohibits the merge/i.test(err.message)
      if (!policyBlocked || attempt === maxAttempts) throw err
      process.stderr.write(
        `[auto-changelog] gh pr merge 仍被 base branch policy 拒绝,等 10s 重试(${attempt}/${maxAttempts - 1})...\n`,
      )
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

// ---- argv 解析(支持 --flag value 与 --flag=value) ----
const parseArgs = (argv) => {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        // 布尔 flag 或下一个值
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
          out[a.slice(2)] = true
        } else {
          out[a.slice(2)] = next
          i += 1
        }
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

const fail = (msg, code = 1) => {
  process.stderr.write(`[auto-changelog] 错误: ${msg}\n`)
  process.exit(code)
}

const assertChangelogTimeZone = () => {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  const envTz = process.env.TZ || ''
  if (resolved === CHANGELOG_TIME_ZONE || envTz === CHANGELOG_TIME_ZONE) return
  fail(
    `更新日志归天必须在 ${CHANGELOG_TIME_ZONE} 时区运行;当前 Intl timeZone=${resolved || '(unknown)'},TZ=${envTz || '(unset)'}。` +
      `请设置 TZ=${CHANGELOG_TIME_ZONE} 后再运行。`,
  )
}

const readJsonFile = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${label} JSON 解析失败: ${err.message}`)
  }
}

const buildScanBaseline = (scan) => {
  if (!scan || typeof scan !== 'object') {
    throw new Error('scan 产物不是对象')
  }
  if (!Array.isArray(scan.items) || scan.items.length === 0) {
    throw new Error('scan 产物无 items(scan 时为空跑?改写无意义)')
  }
  const scanAnchor = scan.anchor
  if (!scanAnchor) {
    throw new Error('scan 产物缺 anchor(无法回填 lastGithash)')
  }
  const scanPrSet = new Set()
  const scanPrToDay = new Map()
  const scanPrToAuthor = new Map()
  const scanPrToKind = new Map()
  const skeleton = []
  for (const [index, it] of scan.items.entries()) {
    const where = `scan.items[${index}]`
    if (!it || typeof it !== 'object') throw new Error(`${where}: 不是对象`)
    if (typeof it.pr !== 'number' || !Number.isInteger(it.pr) || it.pr <= 0) {
      throw new Error(`${where}: pr 非正整数 ${JSON.stringify(it.pr)}`)
    }
    if (typeof it.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(it.day)) {
      throw new Error(`${where}: day 非法(需 YYYY-MM-DD),实际 ${JSON.stringify(it.day)}`)
    }
    if (typeof it.author !== 'string' || it.author.trim() === '') {
      throw new Error(`${where}: author 为空`)
    }
    scanPrSet.add(it.pr)
    scanPrToDay.set(it.pr, it.day)
    scanPrToAuthor.set(it.pr, it.author)
    const kind = classifyKind(it.subject)
    scanPrToKind.set(it.pr, kind)
    skeleton.push({
      pr: it.pr,
      date: it.day,
      by: it.author,
      kind,
      subject: it.subject || '',
      body: it.body || '',
    })
  }
  skeleton.sort((a, b) => a.pr - b.pr)
  return { scanAnchor, scanPrSet, scanPrToDay, scanPrToAuthor, scanPrToKind, skeleton }
}

const buildRewritePromptPayload = (scan) => {
  const baseline = buildScanBaseline(scan)
  return {
    status: scan.status,
    anchor: scan.anchor,
    items: baseline.skeleton,
  }
}

const extractRewriteTextItems = (rewrite) => {
  if (!rewrite || typeof rewrite !== 'object') {
    throw new Error('改写产物不是对象')
  }
  if (!Array.isArray(rewrite.items)) {
    throw new Error('改写产物缺少 items 数组(新契约只允许 {items:[{pr,text}|{prs,text}]})')
  }
  return rewrite.items
}

const normalizeRewriteTextItems = (scan, rewrite) => {
  const baseline = buildScanBaseline(scan)
  const { scanPrSet, scanPrToDay, scanPrToKind } = baseline
  const rawItems = extractRewriteTextItems(rewrite)
  const covered = new Set()
  const normalized = []

  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index]
    const where = `items[${index}]`
    if (!item || typeof item !== 'object') throw new Error(`${where}: 不是对象`)
    const hasPr = Object.prototype.hasOwnProperty.call(item, 'pr')
    const hasPrs = Object.prototype.hasOwnProperty.call(item, 'prs')
    if (hasPr === hasPrs) {
      throw new Error(`${where}: 必须且只能提供 pr 或 prs`)
    }
    const prs = hasPr ? [item.pr] : item.prs
    if (!Array.isArray(prs) || prs.length === 0) {
      throw new Error(`${where}: prs 为空数组`)
    }
    const seenInItem = new Set()
    for (const p of prs) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p <= 0) {
        throw new Error(`${where}: prs 含非正整数 ${JSON.stringify(p)}`)
      }
      if (!scanPrSet.has(p)) {
        throw new Error(`${where}: prs 含 scan 里没有的 PR ${p}`)
      }
      if (seenInItem.has(p)) {
        throw new Error(`${where}: prs 内重复 PR ${p}`)
      }
      if (covered.has(p)) {
        throw new Error(`${where}: PR ${p} 被多个改写条目覆盖`)
      }
      seenInItem.add(p)
    }
    const dates = new Set(prs.map((p) => scanPrToDay.get(p)))
    const kinds = new Set(prs.map((p) => scanPrToKind.get(p)))
    if (dates.size > 1 || kinds.size > 1) {
      throw new Error(`${where}: 合并条目只能合并同日同类 PR,实际 dates=[${[...dates].join(',')}], kinds=[${[...kinds].join(',')}]`)
    }
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      throw new Error(`${where}: text 为空`)
    }
    const text = item.text.trim()
    const hits = scanBlacklist(text)
    if (hits.length > 0) {
      throw new Error(`${where}: text 命中代码术语黑名单 [${hits.join(', ')}] — 改写必须用使用者视角,禁出现代码词汇。text: "${text}"`)
    }
    for (const p of prs) covered.add(p)
    normalized.push({ prs: prs.slice().sort((a, b) => a - b), text })
  }

  const missing = [...scanPrSet].filter((p) => !covered.has(p))
  if (missing.length > 0) {
    const parts = []
    if (missing.length) parts.push(`漏 ${missing.length} 个: [${missing.join(',')}]`)
    throw new Error(`改写产物的 PR 覆盖与 scan 不一致(${parts.join('; ')});scan PRs=[${[...scanPrSet].sort((a, b) => a - b).join(',')}], rewrite PRs=[${[...covered].sort((a, b) => a - b).join(',')}]`)
  }
  return { baseline, items: normalized }
}

const assembleRewriteEntries = (scan, rewrite) => {
  const { baseline, items } = normalizeRewriteTextItems(scan, rewrite)
  const { scanPrToDay, scanPrToAuthor, scanPrToKind } = baseline
  const byDate = new Map()

  for (const item of items) {
    const primaryPr = item.prs[0]
    const date = scanPrToDay.get(primaryPr)
    const kind = scanPrToKind.get(primaryPr)
    const by = scanPrToAuthor.get(primaryPr)
    let entry = byDate.get(date)
    if (!entry) {
      entry = { date, prs: new Set(), features: [], fixes: [] }
      byDate.set(date, entry)
    }
    entry[kind].push({ text: item.text, by, prs: item.prs })
    for (const p of item.prs) entry.prs.add(p)
  }

  const entries = [...byDate.values()]
    .map((entry) => ({
      date: entry.date,
      prs: [...entry.prs].sort((a, b) => a - b),
      features: entry.features,
      fixes: entry.fixes,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
  return { entries }
}

const getStringContent = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
}

const parseJsonFromLlmText = (text) => {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Some gateways/models still wrap JSON in a code fence. Accept it, but keep
    // validation strict after parsing.
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('LLM 输出不是合法 JSON')
}

const trimForError = (text, max = 1200) => {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine
}

const chatCompletions = async ({ apiBase, key, model, messages, timeoutMs }) => {
  const endpoint = `${apiBase.replace(/\/$/, '')}/chat/completions`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
      signal: controller.signal,
    })
    const bodyText = await res.text()
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}: ${trimForError(bodyText)}`)
    }
    let body
    try {
      body = JSON.parse(bodyText)
    } catch (err) {
      throw new Error(`LLM 响应不是 JSON: ${err.message}; body=${trimForError(bodyText)}`)
    }
    const content = getStringContent(body?.choices?.[0]?.message?.content)
    if (!content.trim()) {
      throw new Error(`LLM 响应缺少 choices[0].message.content: ${trimForError(bodyText)}`)
    }
    return content
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`LLM 请求超时(${timeoutMs}ms)`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

// ====================== scan ======================
const cmdScan = (args) => {
  const anchorOverride = args.anchor
  const output = args.output || SCAN_OUTPUT_DEFAULT
  const doFetch = args.fetch !== false && args['no-fetch'] !== true

  if (doFetch) {
    process.stderr.write('[auto-changelog] git fetch origin main...\n')
    runGit(['fetch', 'origin', 'main'])
  }

  const changelogPath = join(REPO_ROOT, CHANGELOG_REL)
  if (!existsSync(changelogPath)) {
    fail(`找不到 ${changelogPath}(请在仓库内运行)`)
  }
  const changelog = JSON.parse(readFileSync(changelogPath, 'utf8'))

  // 锚点:默认读 lastGithash;--anchor 覆盖(历史重扫模式,跳过去重)
  const historical = Boolean(anchorOverride)
  const anchor = anchorOverride || changelog.lastGithash
  if (!anchor) {
    fail('changelog.json 缺少 lastGithash,且未传 --anchor')
  }

  const originMain = runGit(['rev-parse', 'origin/main'])

  // 必须用 NUL 切分防 subject 含竖线/换行被截断。
  // 格式:%H%x00%cI%x00%an%x00%s%x00%x00 (每条记录以双 NUL 结尾)
  const raw = runGit([
    'log', '--first-parent',
    '--format=%H%x00%cI%x00%an%x00%s%x00%x00',
    `${anchor}..origin/main`,
  ])

  // git log 每条 entry 后会追加一个 \n,按 \x00\x00 切分时,第二条及之后的 record
  // 会带一个前导 \n(\x00\x00\n<H1>...),污染 hash(parts[0])。trimStart 去掉它,
  // 否则 hash='\n56a8be8...' 会让后续 `<hash>^2` 解析失败(实测踩过)。
  const records = raw
    ? raw
        .split('\x00\x00')
        .filter(Boolean)
        .map((r) => r.replace(/^[\r\n]+/, ''))
    : []

  // 现有全部 entries 的 prs 并集(去重依据)
  const recordedPrs = new Set()
  for (const e of changelog.entries || []) {
    for (const p of e.prs || []) recordedPrs.add(p)
  }

  const items = []
  const seenPrs = new Set() // 范围内同号去重(双模式按号归并)

  for (const rec of records) {
    const parts = rec.split('\x00')
    if (parts.length < 4) continue
    const hash = parts[0]
    const cI = parts[1]
    let author = parts[2]
    const subject = parts.slice(3).join('\x00') // subject 自身理论不含 NUL,兜底拼回

    // meta-PR 自身不收录
    if (META_PR_SUBJECT_RE.test(subject)) continue

    // PR 识别双模式
    let pr = null
    const squash = subject.match(SQUASH_PR_RE)
    const merge = subject.match(MERGE_PR_RE)
    if (squash) {
      pr = Number(squash[1])
    } else if (merge) {
      pr = Number(merge[1])
      // merge 形态:git 侧回退作者取被合并分支 tip 作者(<merge>^2),作为
      // PR opener(gh)取不到时的降级值(squash 形态无 ^2,直接用 %an)
      const branchAuthor = runGit(['log', '-1', '--format=%an', `${hash}^2`], { allowFail: true })
      if (branchAuthor) author = branchAuthor
    } else {
      // 非 PR 落地(直推/其他),跳过
      continue
    }

    if (seenPrs.has(pr)) continue
    seenPrs.add(pr)

    // 去重:与现有 entries 的 prs 求差集(历史重扫模式跳过)
    if (!historical && recordedPrs.has(pr)) continue

    const day = toChangelogDay(cI)

    // by 字段降级链:PR opener(gh author.login,最贴合"这个功能谁做的") →
    //   ^2 作者(merge 形态分支 tip) / %an(squash)。gh 一次取 body+author,
    //   零额外网络开销;gh 失败则沿用上面算好的 git 作者。
    let body = ''
    const prJson = runGh(['pr', 'view', String(pr), '--json', 'body,author'], { allowFail: true })
    if (prJson) {
      try {
        const pv = JSON.parse(prJson)
        body = pv.body || ''
        const opener = pv.author && pv.author.login
        if (opener) author = opener
      } catch {
        body = ''
      }
    }

    items.push({ pr, day, author, subject, body })
  }

  if (items.length === 0) {
    // 空跑:不开 PR、不写 scan 产物。打印 empty,退出 0。
    process.stdout.write(`${JSON.stringify({ status: 'empty' })}\n`)
    return
  }

  const payload = {
    status: 'pending',
    anchor: originMain,
    historical,
    items: items
      .slice()
      .sort((a, b) => a.pr - b.pr)
      .map((it) => ({ pr: it.pr, day: it.day, author: it.author, subject: it.subject, body: it.body })),
  }
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.stderr.write(`[auto-changelog] 扫出 ${items.length} 个新 PR,产物写入 ${output}\n`)
}

// ====================== rewrite ======================
const cmdRewrite = async (args) => {
  const scanPath = args.scan || SCAN_OUTPUT_DEFAULT
  const output = args.output || REWRITE_OUTPUT_DEFAULT
  const model = args.model || process.env.MIVO_CHANGELOG_LLM_MODEL || process.env.MIVO_LLM_MODEL || LLM_MODEL_DEFAULT
  const apiBase = args.base || process.env.MIVO_CHANGELOG_LLM_BASE || process.env.MIVO_LLM_API_BASE || LLM_API_BASE_DEFAULT
  const key = (
    process.env.MIVO_CHANGELOG_LLM_KEY ||
    process.env.MIVO_LLM_API_KEY ||
    process.env.MIVO_IMAGE_API_KEY ||
    ''
  ).trim()
  const timeoutMs = Number(process.env.MIVO_CHANGELOG_LLM_TIMEOUT_MS) > 0
    ? Number(process.env.MIVO_CHANGELOG_LLM_TIMEOUT_MS)
    : REWRITE_TIMEOUT_MS_DEFAULT

  if (!existsSync(scanPath)) {
    fail(`scan 产物不存在: ${scanPath}(请先跑 scan)`)
  }
  if (!key) {
    fail('缺少 LLM key:请设置 MIVO_CHANGELOG_LLM_KEY(或本地调试用 MIVO_LLM_API_KEY)')
  }
  if (!/^sk-[\x21-\x7e]+$/.test(key)) {
    fail('LLM key 格式无效:需以 sk- 开头且不含空格/中文')
  }

  const scan = readJsonFile(scanPath, 'scan 产物')
  try {
    buildScanBaseline(scan)
  } catch (err) {
    fail(err.message)
  }

  const promptTemplatePath = join(REPO_ROOT, REWRITE_PROMPT_REL)
  if (!existsSync(promptTemplatePath)) {
    fail(`找不到改写 prompt:${promptTemplatePath}`)
  }
  const promptTemplate = readFileSync(promptTemplatePath, 'utf8')
  const rewritePayload = buildRewritePromptPayload(scan)
  const prompt = promptTemplate.replace('{{REWRITE_INPUT_JSON}}', JSON.stringify(rewritePayload, null, 2))

  let lastValidationError = ''
  const totalAttempts = REWRITE_MAX_RETRIES + 1
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    process.stderr.write(`[auto-changelog] rewrite 调用 LLM(${attempt}/${totalAttempts}) model=${model}\n`)
    const messages = [
      {
        role: 'system',
        content: '你负责把 MivoCanvas 的 PR 扫描结果改写成给用户看的更新日志。只输出合法 JSON,不要输出 markdown 代码围栏或解释。',
      },
      {
        role: 'user',
        content: lastValidationError
          ? `${prompt}\n\n上一轮输出未通过脚本校验,错误如下:\n${lastValidationError}\n\n请修正并只输出完整 JSON。`
          : prompt,
      },
    ]

    let rewrite
    try {
      const content = await chatCompletions({ apiBase, key, model, messages, timeoutMs })
      rewrite = parseJsonFromLlmText(content)
    } catch (err) {
      lastValidationError = err.message
      process.stderr.write(`[auto-changelog] rewrite 第 ${attempt} 次调用/解析失败:${err.message}\n`)
      if (attempt === totalAttempts) {
        fail(`rewrite 失败,已重试 ${REWRITE_MAX_RETRIES} 次:${err.message}`)
      }
      continue
    }

    try {
      const normalized = { items: normalizeRewriteTextItems(scan, rewrite).items }
      const rewriteOutput = {
        items: normalized.items.map((item) =>
          item.prs.length === 1 ? { pr: item.prs[0], text: item.text } : { prs: item.prs, text: item.text },
        ),
      }
      writeFileSync(output, `${JSON.stringify(rewriteOutput, null, 2)}\n`)
      process.stdout.write(`${JSON.stringify({ status: 'rewritten', output, model, attempts: attempt })}\n`)
      process.stderr.write(`[auto-changelog] rewrite 产物已通过校验并写入 ${output}\n`)
      return
    } catch (err) {
      lastValidationError = err.message
      process.stderr.write(`[auto-changelog] rewrite 第 ${attempt} 次校验失败:${err.message}\n`)
      if (attempt === totalAttempts) {
        fail(`rewrite 产物仍未通过校验,已重试 ${REWRITE_MAX_RETRIES} 次:${err.message}`)
      }
    }
  }
}

// ====================== publish ======================
const cmdPublish = async (args) => {
  const dryRun = args['dry-run'] === true
  const rewritePath = args.rewrite
  const scanPath = args.scan || SCAN_OUTPUT_DEFAULT

  if (!rewritePath) {
    fail('publish 需要 --rewrite <path>(LLM 改写产物 JSON)')
  }
  if (!existsSync(rewritePath)) {
    fail(`改写产物不存在: ${rewritePath}`)
  }
  if (!existsSync(scanPath)) {
    fail(`scan 产物不存在: ${scanPath}(请先跑 scan)`)
  }

  // ---- 1. 读 scan 产物(提供 PR 集合基准)----
  let scan
  let baseline
  try {
    scan = readJsonFile(scanPath, 'scan 产物')
    baseline = buildScanBaseline(scan)
  } catch (err) {
    fail(err.message)
  }
  const { scanAnchor } = baseline

  // ---- 2. 读 text-only 改写产物 + 确定性组装 entries ----
  let rewrite
  let assembled
  try {
    rewrite = readJsonFile(rewritePath, '改写产物')
    assembled = assembleRewriteEntries(scan, rewrite)
  } catch (err) {
    fail(err.message)
  }

  // ---- 3. 计算合并后的 changelog(纯逻辑,安全)----
  // 从最新 origin/main 建临时 worktree,在其上读 changelog.json 再合并写回。
  // dry-run 时只算合并结果 + 打印计划命令,不执行 git/gh 写操作。
  const maxDay = assembled.entries
    .map((e) => e.date)
    .sort()
    .at(-1)
  const branch = `chore/changelog-${maxDay}`
  const wtPath = `/tmp/mivo-changelog-wt-${process.pid}`

  // 合并逻辑(与现有 changelog.json 合并;dry-run 时用本工作树的 changelog.json 作样本)
  const mergeEntries = (existingChangelog) => {
    const byDate = new Map()
    for (const e of existingChangelog.entries || []) {
      byDate.set(e.date, {
        date: e.date,
        prs: new Set(e.prs || []),
        features: [...(e.features || [])],
        fixes: [...(e.fixes || [])],
      })
    }
    for (const re of assembled.entries) {
      let entry = byDate.get(re.date)
      if (!entry) {
        entry = { date: re.date, prs: new Set(), features: [], fixes: [] }
        byDate.set(re.date, entry)
      }
      for (const key of ['features', 'fixes']) {
        for (const item of re[key] || []) {
          // 存储形态只保留 {text, by}(prs 仅用于回填 entry.prs)
          entry[key].push({ text: item.text, by: item.by })
          for (const p of item.prs) entry.prs.add(p)
        }
      }
    }
    const entries = [...byDate.values()]
      .map((e) => ({
        date: e.date,
        prs: [...e.prs].sort((a, b) => a - b),
        features: e.features,
        fixes: e.fixes,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
    return {
      lastGithash: scanAnchor,
      updatedAt: localNowIso(),
      entries,
    }
  }

  // 用于 dry-run 的合并样本:读本工作树(脚本所在 repo)的 changelog.json
  const sampleChangelogPath = join(REPO_ROOT, CHANGELOG_REL)
  const sampleChangelog = JSON.parse(readFileSync(sampleChangelogPath, 'utf8'))
  const merged = mergeEntries(sampleChangelog)

  // 新增条目清单(PR body 用)
  const newItemsSummary = scan.items
    .slice()
    .sort((a, b) => a.pr - b.pr)
    .map((it) => `- #${it.pr} @${it.author} [${it.day}] ${it.subject}`)
    .join('\n')
  const prTitle = `chore: 更新日志补扫 ${maxDay}`
  const prBody = `每日 8:00 自动补扫已合入 main 的 PR(scan/publish 确定性脚本,rewrite 经 LLM 改写)。

新增 PR 清单:
${newItemsSummary}

归天(8:00 结算边界)与去重均由 scripts/changelog/auto-changelog.mjs 确定。`

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          scanPath,
          rewritePath,
          scanAnchor,
          maxDay,
          branch,
          worktree: wtPath,
          prTitle,
          mergedChangelogBytes: JSON.stringify(merged, null, 2).length,
        },
        null,
        2,
      )}\n`,
    )
    process.stdout.write('\n---- 将执行的命令(dry-run,不实际执行)----\n')
    const planned = [
      `git fetch origin main`,
      `git worktree add -b ${branch} ${wtPath} origin/main`,
      `# 在 ${wtPath}/public/changelog.json 写入合并后的内容(lastGithash=${scanAnchor}, updatedAt=${merged.updatedAt})`,
      `git -C ${wtPath} add public/changelog.json`,
      `git -C ${wtPath} commit -m "${prTitle}"`,
      `# PREFLIGHT_SKIP=1:changelog-only 非代码改动,无 deps 的临时 worktree 跑不了 pre-push 五道校验;CI 会跑真校验`,
      `PREFLIGHT_SKIP=1 git -C ${wtPath} push -u origin ${branch}`,
      `gh pr create --title "${prTitle}" --body "<新增条目清单>"`,
      `# 轮询 CI:gh pr checks <N> --json name,state,每 30s,上限 30 分钟;fail 中止,head 落后先 gh pr update-branch <N>`,
      `# merge 前铁律:分支名 ^chore/changelog-;files 仅 public/changelog.json;checks 全 pass;mergeable=MERGEABLE(UNKNOWN 重试 6×10s)`,
      `# changelog-only PR 若有 unresolved review threads:先可见回复说明自动补扫产物,再 GraphQL resolveReviewThread`,
      `gh pr merge <N> --squash`,
      `git push origin --delete ${branch}`,
      `git worktree remove --force ${wtPath}`,
    ]
    for (const c of planned) process.stdout.write(`${c}\n`)
    process.stdout.write('\n---- PR body 预览 ----\n')
    process.stdout.write(`${prBody}\n`)
    process.stdout.write('\n---- 合并后 changelog.json(前 60 行)----\n')
    const mergedStr = JSON.stringify(merged, null, 2)
    process.stdout.write(`${mergedStr.split('\n').slice(0, 60).join('\n')}\n`)
    process.stderr.write('[auto-changelog] dry-run 完成(未执行任何写操作)\n')
    return
  }

  // ---- 5. 真实执行:建临时 worktree → 合并写回 → commit → push → PR → 轮询 → merge → 清理 ----
  process.stderr.write(`[auto-changelog] 真实 publish:branch=${branch} worktree=${wtPath}\n`)
  let worktreeCreated = false
  let prNumber = null

  // 失败路径也要清 worktree + 本地分支(trap 语义)。allowFail 兜底"没建成/已删"。
  // 注意:fail() 是 process.exit,在 try 里调用不会触发 catch → 漏清。故 try 内
  // 一律用 abort()(throw),落进 catch → cleanup;catch 再 fail 退出。
  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (worktreeCreated) {
      runGit(['worktree', 'remove', '--force', wtPath], { allowFail: true })
    }
    // 本地分支可能没建成(allowFail 兜底),同日重试不被残留分支卡死
    runGit(['branch', '-D', branch], { allowFail: true })
  }
  const abort = (msg, code = 1) => {
    const err = new Error(msg)
    err.exitCode = code
    throw err
  }

  try {
    runGit(['fetch', 'origin', 'main'])
    if (existsSync(wtPath)) {
      // 上次失败残留:先自愈(worktree remove + branch -D + rmSync 兜底)再重建,
      // 不让人手动清。worktree remove 拒不掉(被占用/非注册)时 rmSync 删目录。
      process.stderr.write(`[auto-changelog] worktree 路径已存在(${wtPath}),自愈清理...\n`)
      runGit(['worktree', 'remove', '--force', wtPath], { allowFail: true })
      runGit(['branch', '-D', branch], { allowFail: true })
      if (existsSync(wtPath)) {
        try {
          rmSync(wtPath, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
    runGit(['worktree', 'add', '-b', branch, wtPath, 'origin/main'])
    worktreeCreated = true

    // 读 worktree 里的 changelog.json,合并写回
    const wtChangelogPath = join(wtPath, CHANGELOG_REL)
    if (!existsSync(wtChangelogPath)) {
      abort(`worktree 里找不到 ${CHANGELOG_REL}`)
    }
    const wtChangelog = JSON.parse(readFileSync(wtChangelogPath, 'utf8'))
    const finalMerged = mergeEntries(wtChangelog)
    writeFileSync(wtChangelogPath, `${JSON.stringify(finalMerged, null, 2)}\n`)

    runGit(['-C', wtPath, 'add', CHANGELOG_REL])
    runGit(['-C', wtPath, 'commit', '-m', prTitle])

    // PREFLIGHT_SKIP=1:changelog-only 非代码改动,无 deps 的临时 worktree 跑不了 pre-push
    // 五道校验(typecheck/lint/build/...);CI 会跑真校验。既定决策,见 RUNBOOK.md。
    runGit(['-C', wtPath, 'push', '-u', 'origin', branch], {
      env: { PREFLIGHT_SKIP: '1' },
    })

    // 开 PR
    const prCreateOut = runGh([
      'pr', 'create',
      '--title', prTitle,
      '--body', prBody,
      '--base', 'main',
      '--head', branch,
    ], { cwd: wtPath })
    const prMatch = prCreateOut.match(/pull\/(\d+)/)
    if (!prMatch) {
      abort(`gh pr create 未返回 PR 编号: ${prCreateOut}`)
    }
    prNumber = Number(prMatch[1])
    process.stderr.write(`[auto-changelog] PR #${prNumber} 已创建,轮询 CI...\n`)

    // 轮询 CI:每 30s,上限 30 分钟
    const POLL_INTERVAL_MS = 30_000
    const POLL_MAX_MS = 30 * 60_000
    const pollStart = Date.now()
    let lastStates = ''
    // 注:Date.now() 在本脚本(非 workflow)里可用
    for (;;) {
      const checksJson = runGh(['pr', 'checks', String(prNumber), '--json', 'name,state'], { cwd: wtPath, allowFail: true })
      if (checksJson) {
        let checks
        try {
          checks = JSON.parse(checksJson)
        } catch {
          checks = null
        }
        if (Array.isArray(checks) && checks.length > 0) {
          const states = checks.map((c) => `${c.name}=${c.state}`).join(',')
          // gh pr checks --json 的 state 取值(GitHub Actions):
          //   终态-过:SUCCESS / NEUTRAL / SKIPPED
          //   终态-挂:FAILURE / ERROR / CANCELLED / TIMED_OUT / ACTION_REQUIRED
          //   进行中(继续等):PENDING / QUEUED / IN_PROGRESS / WAITING / STALE / 空
          const allPass = checks.every((c) =>
            c.state === 'SUCCESS' || c.state === 'NEUTRAL' || c.state === 'SKIPPED',
          )
          const anyFail = checks.some((c) =>
            c.state === 'FAILURE' ||
            c.state === 'ERROR' ||
            c.state === 'CANCELLED' ||
            c.state === 'TIMED_OUT' ||
            c.state === 'ACTION_REQUIRED',
          )
          if (allPass) {
            process.stderr.write(`[auto-changelog] CI 全绿(${states})\n`)
            break
          }
          if (anyFail) {
            abort(`CI 有失败项(${states}),中止不 merge。PR: https://github.com/xindong/mivo-canvas/pull/${prNumber}`, 2)
          }
          if (states !== lastStates) {
            process.stderr.write(`[auto-changelog] CI 进行中(${states})\n`)
            lastStates = states
          }
        }
      }
      // head 落后基线 → update-branch 后继续等(只取 mergeable 一个字段)
      const prView = runGh(['pr', 'view', String(prNumber), '--json', 'mergeable'], { cwd: wtPath, allowFail: true })
      if (prView) {
        try {
          const pv = JSON.parse(prView)
          if (pv.mergeable === 'BEHIND') {
            process.stderr.write('[auto-changelog] head 落后基线,gh pr update-branch...\n')
            runGh(['pr', 'update-branch', String(prNumber)], { cwd: wtPath, allowFail: true })
          }
        } catch { /* ignore parse error,继续轮询 */ }
      }
      if (Date.now() - pollStart > POLL_MAX_MS) {
        abort(`CI 轮询超过 ${POLL_MAX_MS / 60_000} 分钟上限,中止不 merge。PR: https://github.com/xindong/mivo-canvas/pull/${prNumber}`, 3)
      }
      // sleep 30s(异步,不阻塞事件循环;真实 publish 才会走到这里)
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }

    // ---- merge 前铁律校验(全部写死为 if)----
    // gh --json 只接受一个逗号连接的参数(多 arg 会报 "accepts at most 1 arg")
    const mergeView = runGh(['pr', 'view', String(prNumber), '--json', 'files,mergeable,headRefName'], { cwd: wtPath })
    let mv
    try {
      mv = JSON.parse(mergeView)
    } catch (err) {
      abort(`merge 前校验:gh pr view --json 解析失败: ${err.message}`)
    }
    // ① 分支名匹配 ^chore/changelog-
    if (!mv.headRefName || !/^chore\/changelog-/.test(mv.headRefName)) {
      abort(`铁律违反:headRefName=${mv.headRefName} 不匹配 ^chore/changelog-`)
    }
    // ② files 仅含 public/changelog.json
    const files = (mv.files || []).map((f) => f.path)
    const illegal = files.filter((f) => f !== CHANGELOG_REL)
    if (illegal.length > 0) {
      abort(`铁律违反:PR 改动了非 ${CHANGELOG_REL} 的文件: [${illegal.join(', ')}]`)
    }
    if (files.length === 0) {
      abort('铁律违反:PR 无文件改动(预期含 public/changelog.json)')
    }
    // ③ mergeable=MERGEABLE;刚算完 CI 时该字段常短暂为 UNKNOWN(GitHub 异步),
    //   重试最多 6 次/间隔 10s;CONFLICTING 等其他非 MERGEABLE 值立即 fail 不重试
    let mergeable = mv.mergeable
    for (let attempt = 0; attempt < 6 && mergeable === 'UNKNOWN'; attempt += 1) {
      process.stderr.write(`[auto-changelog] mergeable=UNKNOWN,等 10s 重试(${attempt + 1}/6)...\n`)
      await new Promise((r) => setTimeout(r, 10_000))
      const retryJson = runGh(['pr', 'view', String(prNumber), '--json', 'mergeable'], { cwd: wtPath, allowFail: true })
      if (retryJson) {
        try {
          mergeable = JSON.parse(retryJson).mergeable
        } catch {
          /* 保持 UNKNOWN,继续重试 */
        }
      }
    }
    if (mergeable !== 'MERGEABLE') {
      abort(`铁律违反:mergeable=${mergeable}(需 MERGEABLE;${mergeable === 'UNKNOWN' ? '已重试 6 次仍 UNKNOWN' : '非 MERGEABLE 立即拒绝'})`)
    }
    // ④ checks 全 pass(再确认一次)
    const finalChecksJson = runGh(['pr', 'checks', String(prNumber), '--json', 'name,state'], { cwd: wtPath })
    let finalChecks
    try {
      finalChecks = JSON.parse(finalChecksJson)
    } catch (err) {
      abort(`merge 前校验:checks 解析失败: ${err.message}`)
    }
    const notPass = (finalChecks || []).filter(
      (c) => !(c.state === 'SUCCESS' || c.state === 'NEUTRAL' || c.state === 'SKIPPED'),
    )
    if (notPass.length > 0) {
      abort(`铁律违反:checks 未全绿: [${notPass.map((c) => `${c.name}=${c.state}`).join(', ')}]`)
    }

    // ⑤ changelog-only PR 允许自清 review thread。严格复用上面的分支名/files 铁律;
    // 其他 PR 绝不自动回复或 resolve。
    resolveChangelogReviewThreads({
      prNumber,
      headRefName: mv.headRefName,
      files,
      cwd: wtPath,
    })

    // 全过 → squash merge
    process.stderr.write(`[auto-changelog] 铁律校验全过,squash merge PR #${prNumber}\n`)
    await mergePullRequestWithPolicyRetry(prNumber, wtPath)

    // ---- 收尾:删远程分支(分开删,gh --delete-branch 会被 worktree 占用卡住)----
    try {
      runGit(['push', 'origin', '--delete', branch])
    } catch (err) {
      // 删分支失败不阻断主流程(merge 已成功),仅告警
      process.stderr.write(`[auto-changelog] 警告:删远程分支 ${branch} 失败: ${err.message}(merge 已成功,请手动删分支)\n`)
    }
    cleanup()
    process.stdout.write(`${JSON.stringify({ status: 'merged', pr: prNumber, branch, day: maxDay })}\n`)
    process.stderr.write(`[auto-changelog] PR #${prNumber} 已 squash merge 进 main\n`)
  } catch (err) {
    // 任何失败(operational throw 或 abort)都走这里 → 清 worktree + 本地分支后退出
    cleanup()
    fail(err.message, err.exitCode ?? 1)
  }
}

// ====================== 入口 ======================
const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    process.stderr.write('用法:\n')
    process.stderr.write('  node scripts/changelog/auto-changelog.mjs scan [--anchor <hash>] [--output <path>] [--no-fetch]\n')
    process.stderr.write('  node scripts/changelog/auto-changelog.mjs rewrite [--scan <path>] [--output <path>] [--model <name>] [--base <url>]\n')
    process.stderr.write('  node scripts/changelog/auto-changelog.mjs publish --rewrite <path> [--scan <path>] [--dry-run]\n')
    process.exit(2)
  }
  const sub = argv[0]
  const rest = parseArgs(argv.slice(1))

  assertChangelogTimeZone()

  if (sub === 'scan') {
    try {
      cmdScan(rest)
    } catch (err) {
      fail(err.message)
    }
  } else if (sub === 'rewrite') {
    try {
      await cmdRewrite(rest)
    } catch (err) {
      fail(err.message)
    }
  } else if (sub === 'publish') {
    try {
      await cmdPublish(rest)
    } catch (err) {
      fail(err.message)
    }
  } else {
    fail(`未知子命令: ${sub}(可用: scan | rewrite | publish)`)
  }
}

main()
