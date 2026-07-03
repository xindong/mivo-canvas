import '../App.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, RefreshCw, Search } from 'lucide-react'
import { resolveRemoteDebugEndpoint } from '../store/remoteDebugReporter'

type RemoteDebugLevel = 'warning' | 'error'

type RemoteDebugRecord = {
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
  ip: string
  referer: string
  receivedAt: string
}

type DebugReportResponse = {
  ok: boolean
  dates?: string[]
  records?: RemoteDebugRecord[]
  error?: string
}

const tokenStorageKey = 'mivo.debugReports.token'
const debugReportsEndpoint = resolveRemoteDebugEndpoint()

const debugReportsUrl = (params: URLSearchParams) => {
  if (debugReportsEndpoint.startsWith('http://') || debugReportsEndpoint.startsWith('https://')) {
    const url = new URL(debugReportsEndpoint)
    params.forEach((value, key) => url.searchParams.set(key, value))
    return url.toString()
  }

  return `${debugReportsEndpoint}?${params.toString()}`
}

const formatDebugReportTime = (value: string | number) =>
  new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))

const copyRecordText = (record: RemoteDebugRecord) => {
  const text = [
    `[${record.level.toUpperCase()}] ${formatDebugReportTime(record.receivedAt)}`,
    `client=${record.clientId}`,
    `session=${record.sessionId}`,
    `source=${record.source}`,
    record.message,
  ].join('\n')

  void navigator.clipboard?.writeText(text)
}

export function DebugReportsPage() {
  const [records, setRecords] = useState<RemoteDebugRecord[]>([])
  const [dates, setDates] = useState<string[]>([])
  const [date, setDate] = useState('')
  const [level, setLevel] = useState<RemoteDebugLevel | 'all'>('all')
  const [query, setQuery] = useState('')
  const [clientId, setClientId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [token, setToken] = useState(() => window.sessionStorage.getItem(tokenStorageKey) || '')
  const [tokenDraft, setTokenDraft] = useState(token)
  const [authRequired, setAuthRequired] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const recordCounts = useMemo(
    () => ({
      warning: records.filter((record) => record.level === 'warning').length,
      error: records.filter((record) => record.level === 'error').length,
    }),
    [records],
  )

  const loadReports = useCallback(async () => {
    setLoading(true)
    setError('')

    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (level !== 'all') params.set('level', level)
    if (query.trim()) params.set('q', query.trim())
    if (clientId.trim()) params.set('clientId', clientId.trim())
    if (sessionId.trim()) params.set('sessionId', sessionId.trim())

    try {
      const response = await fetch(debugReportsUrl(params), {
        headers: token ? { 'x-mivo-debug-token': token } : undefined,
      })
      const payload = (await response.json()) as DebugReportResponse

      if (response.status === 403) {
        setAuthRequired(true)
        setError(payload.error || 'Debug report token required')
        return
      }
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to load debug reports')

      setAuthRequired(false)
      setDates(payload.dates || [])
      setRecords(payload.records || [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load debug reports')
    } finally {
      setLoading(false)
    }
  }, [clientId, date, level, query, sessionId, token])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadReports()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadReports])

  const submitToken = () => {
    window.sessionStorage.setItem(tokenStorageKey, tokenDraft)
    setToken(tokenDraft)
  }

  return (
    <main className="debug-reports-page">
      <header className="debug-reports-header">
        <div>
          <span>Remote diagnostics</span>
          <h1>Remote Debug Reports</h1>
        </div>
        <button type="button" onClick={() => void loadReports()} disabled={loading}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </header>

      {authRequired ? (
        <form
          className="debug-reports-token"
          onSubmit={(event) => {
            event.preventDefault()
            submitToken()
          }}
        >
          <label>
            View token
            <input value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} type="password" />
          </label>
          <button type="submit">Unlock</button>
        </form>
      ) : null}

      <section className="debug-reports-toolbar" aria-label="Debug report filters">
        <label>
          Date
          <select value={date} onChange={(event) => setDate(event.target.value)}>
            <option value="">Latest</option>
            {dates.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Level
          <select value={level} onChange={(event) => setLevel(event.target.value as RemoteDebugLevel | 'all')}>
            <option value="all">All</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          Client
          <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="clientId" />
        </label>
        <label>
          Session
          <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="sessionId" />
        </label>
        <label className="debug-reports-search">
          Search
          <span>
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="source or message" />
          </span>
        </label>
      </section>

      <section className="debug-reports-summary" aria-label="Debug report summary">
        <strong>{records.length}</strong>
        <span>records</span>
        <strong>{recordCounts.warning}</strong>
        <span>warnings</span>
        <strong>{recordCounts.error}</strong>
        <span>errors</span>
      </section>

      {error ? <p className="debug-reports-error">{error}</p> : null}

      <ol className="debug-reports-list" aria-label="Remote debug records">
        <li className="debug-reports-table-heading" aria-hidden="true">
          <span>Level</span>
          <span>Time</span>
          <span>Source</span>
          <span>Message</span>
          <span>Client</span>
          <span>Session</span>
          <span>Path</span>
          <span>IP</span>
          <span></span>
        </li>
        {records.map((record) => (
          <li key={record.id} className={`debug-reports-record ${record.level}`}>
            <div className="debug-reports-record-grid">
              <strong>{record.level}</strong>
              <time>{formatDebugReportTime(record.receivedAt)}</time>
              <span title={record.source}>{record.source}</span>
              <p>{record.message}</p>
              <div className="debug-reports-record-details">
                <span title={record.clientId}>
                  <b>Client</b>
                  <em>{record.clientId}</em>
                </span>
                <span title={record.sessionId}>
                  <b>Session</b>
                  <em>{record.sessionId}</em>
                </span>
                <span title={record.pagePath}>
                  <b>Path</b>
                  <em>{record.pagePath}</em>
                </span>
                <span title={record.ip}>
                  <b>IP</b>
                  <em>{record.ip}</em>
                </span>
              </div>
              <button type="button" aria-label="Copy debug report" onClick={() => copyRecordText(record)}>
                <Copy size={14} />
              </button>
            </div>
          </li>
        ))}
        {!records.length && !loading ? <li className="debug-reports-empty">No remote debug records</li> : null}
      </ol>
    </main>
  )
}
