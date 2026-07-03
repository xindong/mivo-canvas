import { mkdir, appendFile, readdir, readFile } from 'node:fs/promises'
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

export const appendRemoteDebugRecords = async (records: RemoteDebugRecord[]) => {
  if (!records.length) return
  await mkdir(remoteDebugLogDir(), { recursive: true })
  await appendFile(remoteDebugFilePath(), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
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
