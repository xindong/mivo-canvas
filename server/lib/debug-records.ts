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

export const sanitizeRemoteDebugText = (value: unknown, maxLength = maxRemoteDebugTextLength) => {
  const compact = compactRemoteDebugText(value)
    .replace(/data:[^,\s]+,[^\s]+/gi, 'data:[redacted]')
    .replace(/\b(token|api[_-]?key|authorization|password|secret)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[redacted-base64]')

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}... [truncated]` : compact
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
    const candidate = entry as { level?: unknown; source?: unknown; message?: unknown; timestamp?: unknown }
    if (!isRemoteDebugLevel(candidate.level)) return []

    const timestamp = Number(candidate.timestamp)

    return {
      id: `${serverMeta.receivedAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      level: candidate.level,
      source: sanitizeRemoteDebugText(candidate.source || 'Unknown', 160),
      message: sanitizeRemoteDebugText(candidate.message || ''),
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
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7
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
