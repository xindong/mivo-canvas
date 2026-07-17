import { mkdir, appendFile, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

// Debug-log normalize / sanitize / filter / storage helpers.
//
// Source of truth for the BFF (`server/routes/debug-logs.ts`). Logic is aligned
// 1:1 with the dev-middleware implementation in `vite.config.ts` (L204-L394) so
// that `contract:diff` against the dev baseline is field-equivalent. The
// vite.config.ts copy stays in place until the P1-d cleanup PR removes the dev
// middleware; do not let the two drift.
//
// Test cases live in `debug-records.test.ts` (migrated from `vite.config.test.ts`,
// same assertion semantics).

export type RemoteDebugLevel = 'warning' | 'error'

export type RemoteDebugRecord = {
  id: string
  level: RemoteDebugLevel
  source: string
  message: string
  timestamp: number
  clientId: string
  sessionId: string
  appVersion: string
  pagePath: string
  userAgent: string
  language: string
  timezone: string
  screen: {
    width: number
    height: number
    pixelRatio: number
  }
  // T2-4:error 级记录可携带脱敏后的 stack trace(可选,老客户端无此字段照常入库)。
  // 指纹/gate 只读 source+message,stack 仅进记录详情供分诊阅读。
  stack?: string
  ip: string
  referer: string
  receivedAt: string
}

export type RemoteDebugPayload = {
  clientId?: unknown
  sessionId?: unknown
  appVersion?: unknown
  pagePath?: unknown
  userAgent?: unknown
  language?: unknown
  timezone?: unknown
  screen?: unknown
  entries?: unknown
}

export type RemoteDebugServerMeta = {
  ip: string
  referer: string
  receivedAt: string
}

export type RemoteDebugRecordFilter = {
  level?: string
  clientId?: string
  sessionId?: string
  query?: string
}

// Framework-agnostic request view used to derive server meta. The Hono route
// builds this from `c.req.header`; the dev middleware built it from `IncomingMessage`.
export type RemoteDebugRequestView = {
  header: (name: string) => string | undefined
  remoteAddress?: string | null
}

const maxRemoteDebugEntries = 40
const maxRemoteDebugTextLength = 4000

export const isRemoteDebugLevel = (value: unknown): value is RemoteDebugLevel =>
  value === 'warning' || value === 'error'

const compactRemoteDebugText = (value: unknown, fallback = '') => {
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/\s+/g, ' ')
}

// 秘密打码(token/key、data URL、长 base64)。message 与 stack 共用同一套模式,
// 保证两个字段的脱敏语义不漂移。
const redactRemoteDebugSecrets = (value: string): string =>
  value
    .replace(/data:[^,\s]+,[^\s]+/gi, 'data:[redacted]')
    .replace(/\b(token|api[_-]?key|authorization|password|secret)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[redacted-base64]')

export const sanitizeRemoteDebugText = (value: unknown, maxLength = maxRemoteDebugTextLength) => {
  const compact = redactRemoteDebugSecrets(compactRemoteDebugText(value))

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}... [truncated]` : compact
}

// ── T2-4:stack 专用清洗 ─────────────────────────────────────────────────────
//
// 与 sanitizeRemoteDebugText 的两点差异:
//  1. 保留换行(stack 天然多行,压成单行会毁掉可读性);
//  2. 帧内路径改写:保留「文件名:行号:列号」定位能力,剥掉绝对路径前缀
//     (用户目录 /Users|/home|/root、构建/部署目录如 /AIGC_Group/...)与
//     URL 的 origin + query(vite dev 的 ?t=... 时间戳、生产资产域名)。
// 秘密打码复用 redactRemoteDebugSecrets(与 message 同一套规则)。

const maxRemoteDebugStackLength = 2048

// URL 帧:http(s)://host[:port]/path?query:line:col → path:line:col(去掉前导 /,
// 变成相对路径形态,避免被下面的绝对路径规则误剥)。
const STACK_URL_RE = /(?:https?|wss?):\/\/[^\s/)]+\/([^\s)?]*)(?:\?[^\s):]*)?/gi
// 用户目录前缀(unix /Users|/home|/root + windows 盘符变体):目录段可含空格
// (如 "Project MivoCanvas"),贪婪吃到最后一个 / 为止,只留文件名。
const STACK_USER_DIR_RE = /(?:[A-Za-z]:)?[\\/](?:Users|home|root)[\\/][^:)]*[\\/]/g
// 其余绝对路径(部署/构建根,如 /AIGC_Group/mivo-canvas/dist/...):要求出现在
// 行首/空白/括号/@ 之后(即帧内路径 token 的起点),不误伤 URL 剥离后留下的
// 相对路径(src/store/x.ts 无前导 /)。
const STACK_ABS_PATH_RE = /(?<=^|[\s(@])[\\/](?:[^\s():\\/]+[\\/])+/g

const sanitizeStackLine = (line: string): string =>
  line
    .replace(STACK_URL_RE, '$1')
    .replace(STACK_USER_DIR_RE, '')
    .replace(STACK_ABS_PATH_RE, '')

/**
 * T2-4:清洗客户端上报的 stack trace。非字符串/空白 → undefined(可选字段,
 * 老客户端无 stack 照常入库)。输出保证:无绝对路径前缀、无 URL origin/query、
 * 无 token/base64 明文,总长 ≤2KB(超长截断加标记)。
 */
export const sanitizeRemoteDebugStack = (
  value: unknown,
  maxLength = maxRemoteDebugStackLength,
): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined

  const cleaned = redactRemoteDebugSecrets(
    value
      .split('\n')
      .map((line) => sanitizeStackLine(line).replace(/[ \t]{2,}/g, ' ').trimEnd())
      .join('\n')
      .trim(),
  )
  if (!cleaned) return undefined

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}... [truncated]` : cleaned
}

const normalizeRemoteDebugScreen = (screen: unknown): RemoteDebugRecord['screen'] => {
  if (!screen || typeof screen !== 'object') return { width: 0, height: 0, pixelRatio: 1 }
  const candidate = screen as Partial<RemoteDebugRecord['screen']>

  return {
    width: Number.isFinite(candidate.width) ? Number(candidate.width) : 0,
    height: Number.isFinite(candidate.height) ? Number(candidate.height) : 0,
    pixelRatio: Number.isFinite(candidate.pixelRatio) ? Number(candidate.pixelRatio) : 1,
  }
}

export const normalizeRemoteDebugPayload = (
  payload: RemoteDebugPayload,
  serverMeta: RemoteDebugServerMeta,
): RemoteDebugRecord[] => {
  const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, maxRemoteDebugEntries) : []
  const clientId = sanitizeRemoteDebugText(payload.clientId || 'unknown-client')
  const sessionId = sanitizeRemoteDebugText(payload.sessionId || 'unknown-session')
  const appVersion = sanitizeRemoteDebugText(payload.appVersion || 'unknown')
  const pagePath = sanitizeRemoteDebugText(payload.pagePath || '/')
  const userAgent = sanitizeRemoteDebugText(payload.userAgent || 'unknown')
  const language = sanitizeRemoteDebugText(payload.language || 'unknown')
  const timezone = sanitizeRemoteDebugText(payload.timezone || 'unknown')
  const screen = normalizeRemoteDebugScreen(payload.screen)

  return entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return []
    const candidate = entry as {
      level?: unknown
      source?: unknown
      message?: unknown
      timestamp?: unknown
      stack?: unknown
    }
    if (!isRemoteDebugLevel(candidate.level)) return []

    const timestamp = Number(candidate.timestamp)
    // T2-4:stack 只在 error 级入库(与客户端「warn 不带」约定端到端一致,
    // 服务端兜底防旧/异常客户端在 warning 上塞 stack);缺省 → 不落 stack 键。
    const stack = candidate.level === 'error' ? sanitizeRemoteDebugStack(candidate.stack) : undefined

    return {
      id: `${serverMeta.receivedAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      level: candidate.level,
      source: sanitizeRemoteDebugText(candidate.source || 'Unknown', 160),
      message: sanitizeRemoteDebugText(candidate.message || ''),
      ...(stack !== undefined ? { stack } : {}),
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      clientId,
      sessionId,
      appVersion,
      pagePath,
      userAgent,
      language,
      timezone,
      screen,
      ip: serverMeta.ip,
      referer: serverMeta.referer,
      receivedAt: serverMeta.receivedAt,
    }
  })
}

export const filterRemoteDebugRecords = <T extends Partial<RemoteDebugRecord>>(
  records: T[],
  filter: RemoteDebugRecordFilter,
) => {
  const query = filter.query?.trim().toLowerCase() || ''

  return records.filter((record) => {
    if (filter.level && record.level !== filter.level) return false
    if (filter.clientId && record.clientId !== filter.clientId) return false
    if (filter.sessionId && record.sessionId !== filter.sessionId) return false
    if (!query) return true

    return [record.source, record.message, record.clientId, record.sessionId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query))
  })
}

// Derive server meta from a framework-agnostic request view. IP prefers
// X-Forwarded-For (the BFF runs behind a reverse proxy in prod) then falls back
// to the socket remote address, then 'unknown'. This is the only deliberate
// adaptation from the dev middleware (which read `request.socket.remoteAddress`
// directly); it does not affect any locked response field.
export const remoteDebugRequestMeta = (request: RemoteDebugRequestView): RemoteDebugServerMeta => {
  const forwardedFor = request.header('x-forwarded-for') ?? ''
  const referer = request.header('referer') ?? ''

  return {
    ip: (forwardedFor.split(',')[0] || request.remoteAddress || 'unknown').trim(),
    referer,
    receivedAt: new Date().toISOString(),
  }
}

// ─── JSONL storage ────────────────────────────────────────────────────────────

export const remoteDebugLogDir = () =>
  resolve(process.env.MIVO_DEBUG_LOG_DIR || resolve(process.cwd(), 'data/debug-logs'))

export const remoteDebugDate = (date = new Date()) => date.toISOString().slice(0, 10)

export const remoteDebugFilePath = (date = remoteDebugDate()) =>
  resolve(remoteDebugLogDir(), `${date}.jsonl`)

// G2.1 R2-4:磁盘 quota/retention(防 JSONL 无限增长)。返修前 appendRemoteDebugRecords
// 只 mkdir + append,无淘汰无 quota → 长期运行磁盘耗尽。现:append 前 sweep 过期 .jsonl
// (MIVO_DEBUG_RETENTION_DAYS,默认 7 天)+ 超 quota(MIVO_DEBUG_DISK_QUOTA_MB,默认 512MB)拒写。
const getRetentionDays = (): number => {
  const raw = process.env.MIVO_DEBUG_RETENTION_DAYS
  if (raw === undefined || raw === '') return 7
  const n = Number(raw)
  // 0 = 禁用 sweep(无限保留),与 MIVO_DEBUG_DISK_QUOTA_MB 的「0=禁用」语义一致。
  // 返修前:0 走 Math.floor(0)=0 → cutoffMs=now → sweep 删全部 .jsonl —— 误设 0 想关 retention
  // 反而清空全部历史日志,破坏性 footgun。现 0 显式返 Infinity → sweep 短路不删任何文件。
  if (n === 0) return Number.POSITIVE_INFINITY
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7
}
const getDiskQuotaBytes = (): number => {
  // 0 = 禁用(无 quota);默认 512MB;>0 = N MB。
  const raw = process.env.MIVO_DEBUG_DISK_QUOTA_MB
  if (raw === undefined || raw === '') return 512 * 1024 * 1024
  const n = Number(raw)
  if (n === 0) return Number.POSITIVE_INFINITY
  return Number.isFinite(n) && n > 0 ? Math.floor(n) * 1024 * 1024 : 512 * 1024 * 1024
}

/** R2-4:append 前 sweep 过期 .jsonl(日期早于 today - retentionDays);返回删除数。惰性 retention。 */
export const sweepExpiredDebugLogs = async (now: Date = new Date()): Promise<number> => {
  const retentionDays = getRetentionDays()
  // 0=禁用 sweep(无限保留):短路返 0,不删任何文件(与 quota 0=禁用 同义;见 getRetentionDays 注释)。
  if (retentionDays === Number.POSITIVE_INFINITY) return 0
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
  try {
    const entries = await readdir(remoteDebugLogDir(), { withFileTypes: true })
    let deleted = 0
    for (const e of entries) {
      if (!e.isFile() || !DATE_FILE_PATTERN.test(e.name)) continue
      const dateStr = e.name.replace(/[.]jsonl$/, '')
      const fileMs = Date.parse(`${dateStr}T00:00:00Z`)
      if (Number.isNaN(fileMs)) continue
      if (fileMs < cutoffMs) {
        try {
          await unlink(resolve(remoteDebugLogDir(), e.name))
          deleted += 1
        } catch {
          // 并发删除/竞争 → 忽略(best-effort sweep)
        }
      }
    }
    return deleted
  } catch {
    return 0 // 目录不存在等 → 不阻断 append(mkdir 后重试)
  }
}

/** R2-4:log 目录下所有 .jsonl 总字节数(quota 校验用)。 */
const debugLogDirSizeBytes = async (): Promise<number> => {
  try {
    const entries = await readdir(remoteDebugLogDir(), { withFileTypes: true })
    let total = 0
    for (const e of entries) {
      if (e.isFile() && DATE_FILE_PATTERN.test(e.name)) {
        try {
          const st = await stat(resolve(remoteDebugLogDir(), e.name))
          total += st.size
        } catch {
          // 并发删除 → 忽略
        }
      }
    }
    return total
  } catch {
    return 0
  }
}

/** R2-4:磁盘 quota 超限(append 前 size >= quota)→ 抛此错;route → 413(对齐 body cap 语义)。 */
export class DebugLogQuotaExceededError extends Error {
  constructor() {
    super('debug log disk quota exceeded')
    this.name = 'DebugLogQuotaExceededError'
  }
}

// R3-F3:per-process append mutex(串行)——防 TOCTOU:两并发 append 各读 used(均 < quota)→ 各 append → 越界。
// 串行后 B 等 A 落盘完成再读 used,quota 判定纳入本次 append byteLength。chained-promise 模式
// (同 assetStore withOwnerLock/withHashLock);single BFF process —— PG/多进程需 DB 行锁,非本层。
let appendTail: Promise<void> = Promise.resolve()
const withAppendLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = appendTail.then(() => fn(), () => fn())
  const swallowed = next.then(
    () => undefined,
    () => undefined,
  )
  appendTail = swallowed
  return next
}

export const appendRemoteDebugRecords = async (records: RemoteDebugRecord[]) => {
  if (!records.length) return
  await mkdir(remoteDebugLogDir(), { recursive: true })
  // R2-4:惰性 retention(过期 .jsonl 删除)+ quota(超 disk quota 拒写,防磁盘耗尽)。
  await sweepExpiredDebugLogs()
  // R3-F3:line 一次计算(byteLength 与实际 append 一致,避免重复序列化);quota 判定纳入本次 append bytes。
  const line = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  const incomingBytes = Buffer.byteLength(line, 'utf8')
  return withAppendLock(async () => {
    const usedBytes = await debugLogDirSizeBytes()
    // R3-F3:返修前只判 used>=quota(used=quota-1 加近 1MB payload 越界);现 used+incoming>quota 才拒。
    if (usedBytes + incomingBytes > getDiskQuotaBytes()) {
      throw new DebugLogQuotaExceededError()
    }
    await appendFile(remoteDebugFilePath(), line)
  })
}

const DATE_FILE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[.]jsonl$/

export const readRemoteDebugDates = async (): Promise<string[]> => {
  try {
    const entries = await readdir(remoteDebugLogDir(), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && DATE_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name.replace(/[.]jsonl$/, ''))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export const readRemoteDebugRecords = async (dates: string[]): Promise<RemoteDebugRecord[]> => {
  const chunks = await Promise.all(
    dates.map(async (date) => {
      try {
        return await readFile(remoteDebugFilePath(date), 'utf8')
      } catch {
        return ''
      }
    }),
  )

  return chunks
    .join('\n')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return JSON.parse(line) as RemoteDebugRecord
      } catch {
        return []
      }
    })
}
