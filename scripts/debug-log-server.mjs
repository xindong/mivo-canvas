import { createServer } from 'node:http'
import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises'
import path from 'node:path'

const port = Number(process.env.MIVO_DEBUG_PORT || 4174)
const logDir = path.resolve(process.env.MIVO_DEBUG_LOG_DIR || path.join(process.cwd(), 'data/debug-logs'))
const viewToken = process.env.MIVO_DEBUG_VIEW_TOKEN?.trim() || ''
const allowedOrigin = process.env.MIVO_DEBUG_ALLOWED_ORIGIN?.trim() || '*'
const maxBodyBytes = 1024 * 1024
const maxEntries = 40
const maxTextLength = 4000

const sendJson = (response, status, payload) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

const setCors = (response) => {
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Mivo-Debug-Token')
  response.setHeader('Vary', 'Origin')
}

const readBody = async (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0

    request.on('data', (chunk) => {
      totalBytes += chunk.length
      if (totalBytes > maxBodyBytes) {
        reject(new Error('Request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

const sanitizeText = (value, maxLength = maxTextLength) => {
  if (typeof value !== 'string') return ''
  const compact = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/data:[^,\s]+,[^\s]+/gi, 'data:[redacted]')
    .replace(/\b(token|api[_-]?key|authorization|password|secret)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[redacted-base64]')

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}... [truncated]` : compact
}

const normalizeScreen = (screen) => ({
  width: Number.isFinite(screen?.width) ? Number(screen.width) : 0,
  height: Number.isFinite(screen?.height) ? Number(screen.height) : 0,
  pixelRatio: Number.isFinite(screen?.pixelRatio) ? Number(screen.pixelRatio) : 1,
})

const isReportableLevel = (level) => level === 'warning' || level === 'error'

const requestMeta = (request) => ({
  ip: String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim(),
  referer: String(request.headers.referer || ''),
  receivedAt: new Date().toISOString(),
})

const normalizePayload = (payload, meta) => {
  const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, maxEntries) : []
  const clientId = sanitizeText(payload.clientId || 'unknown-client')
  const sessionId = sanitizeText(payload.sessionId || 'unknown-session')

  return entries.flatMap((entry, index) => {
    if (!isReportableLevel(entry?.level)) return []
    const timestamp = Number(entry.timestamp)

    return {
      id: `${meta.receivedAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      level: entry.level,
      source: sanitizeText(entry.source || 'Unknown', 160),
      message: sanitizeText(entry.message || ''),
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      clientId,
      sessionId,
      appVersion: sanitizeText(payload.appVersion || 'unknown'),
      pagePath: sanitizeText(payload.pagePath || '/'),
      userAgent: sanitizeText(payload.userAgent || 'unknown'),
      language: sanitizeText(payload.language || 'unknown'),
      timezone: sanitizeText(payload.timezone || 'unknown'),
      screen: normalizeScreen(payload.screen),
      ip: meta.ip,
      referer: meta.referer,
      receivedAt: meta.receivedAt,
    }
  })
}

const today = () => new Date().toISOString().slice(0, 10)

const logPath = (date = today()) => path.join(logDir, `${date}.jsonl`)

const appendRecords = async (records) => {
  if (!records.length) return
  await mkdir(logDir, { recursive: true })
  await appendFile(logPath(), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

const readDates = async () => {
  try {
    const entries = await readdir(logDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
      .map((entry) => entry.name.replace(/\.jsonl$/, ''))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

const readRecords = async (dates) => {
  const chunks = await Promise.all(
    dates.map(async (date) => {
      try {
        return await readFile(logPath(date), 'utf8')
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
        return JSON.parse(line)
      } catch {
        return []
      }
    })
}

const filterRecords = (records, url) => {
  const level = url.searchParams.get('level') || ''
  const clientId = url.searchParams.get('clientId') || ''
  const sessionId = url.searchParams.get('sessionId') || ''
  const query = (url.searchParams.get('q') || '').trim().toLowerCase()

  return records.filter((record) => {
    if (level && record.level !== level) return false
    if (clientId && record.clientId !== clientId) return false
    if (sessionId && record.sessionId !== sessionId) return false
    if (!query) return true
    return [record.source, record.message, record.clientId, record.sessionId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query))
  })
}

const hasViewAccess = (request, url) => {
  if (!viewToken) return true
  return request.headers['x-mivo-debug-token'] === viewToken || url.searchParams.get('token') === viewToken
}

const server = createServer(async (request, response) => {
  setCors(response)
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)

  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }

  if (url.pathname !== '/api/mivo/debug-logs') {
    sendJson(response, 404, { ok: false, error: 'Not found' })
    return
  }

  if (request.method === 'POST') {
    try {
      const payload = JSON.parse((await readBody(request)) || '{}')
      const records = normalizePayload(payload, requestMeta(request))
      await appendRecords(records)
      sendJson(response, 200, { ok: true, accepted: records.length })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : 'Unable to store debug logs' })
    }
    return
  }

  if (request.method === 'GET') {
    if (!hasViewAccess(request, url)) {
      sendJson(response, 403, { ok: false, error: 'Debug report token required' })
      return
    }

    const availableDates = await readDates()
    const requestedDate = url.searchParams.get('date') || ''
    const dates = requestedDate ? [requestedDate] : availableDates.slice(0, 7)
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000)
    const records = filterRecords(await readRecords(dates), url)
      .sort((left, right) => Date.parse(right.receivedAt || '') - Date.parse(left.receivedAt || ''))
      .slice(0, limit)

    sendJson(response, 200, { ok: true, dates: availableDates, records })
    return
  }

  sendJson(response, 405, { ok: false, error: 'Method not allowed' })
})

server.listen(port, () => {
  console.log(`Mivo debug log server listening on http://127.0.0.1:${port}`)
  console.log(`Writing JSONL logs to ${logDir}`)
})
