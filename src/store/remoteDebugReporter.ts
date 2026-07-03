import type { DebugLogLevel } from './debugLogStore'

type ReportableDebugLogLevel = Extract<DebugLogLevel, 'warning' | 'error'>

export type RemoteDebugQueuedEntry = {
  level: DebugLogLevel
  source: string
  message: string
  timestamp: number
}

export type RemoteDebugClientInfo = {
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
}

export type RemoteDebugPayload = RemoteDebugClientInfo & {
  entries: Array<RemoteDebugQueuedEntry & { level: ReportableDebugLogLevel }>
}

type ClientInfoOptions = {
  storage: Storage
  createId: () => string
  sessionId: string
  locationPath: string
  userAgent: string
  language: string
  timezone: string
  screen: RemoteDebugClientInfo['screen']
  appVersion?: string
}

const clientIdStorageKey = 'mivo.remoteDebug.clientId'
const batchDelayMs = 2000
const maxBatchSize = 10
const defaultEndpoint = '/api/mivo/debug-logs'
let sessionId = ''
let flushTimer: number | undefined
let queue: RemoteDebugQueuedEntry[] = []
let installed = false

const createId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `debug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const readTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  } catch {
    return 'unknown'
  }
}

const readSessionId = () => {
  if (!sessionId) sessionId = createId()
  return sessionId
}

export const shouldReportRemoteDebugLevel = (level: DebugLogLevel): level is ReportableDebugLogLevel =>
  level === 'warning' || level === 'error'

export const resolveRemoteDebugEndpoint = (configuredEndpoint = import.meta.env.VITE_MIVO_DEBUG_ENDPOINT || '') =>
  configuredEndpoint.trim() || defaultEndpoint

export const createRemoteDebugClientInfo = ({
  storage,
  createId: createClientId,
  sessionId: nextSessionId,
  locationPath,
  userAgent,
  language,
  timezone,
  screen,
  appVersion = import.meta.env.VITE_MIVO_VERSION || '0.0.0',
}: ClientInfoOptions): RemoteDebugClientInfo => {
  const existingClientId = storage.getItem(clientIdStorageKey)
  const clientId = existingClientId || createClientId()

  if (!existingClientId) storage.setItem(clientIdStorageKey, clientId)

  return {
    clientId,
    sessionId: nextSessionId,
    appVersion,
    pagePath: locationPath,
    userAgent,
    language,
    timezone,
    screen,
  }
}

const createBrowserClientInfo = () =>
  createRemoteDebugClientInfo({
    storage: window.localStorage,
    createId,
    sessionId: readSessionId(),
    locationPath: `${window.location.pathname}${window.location.search}`,
    userAgent: navigator.userAgent,
    language: navigator.language || 'unknown',
    timezone: readTimezone(),
    screen: {
      width: window.screen?.width || window.innerWidth || 0,
      height: window.screen?.height || window.innerHeight || 0,
      pixelRatio: window.devicePixelRatio || 1,
    },
  })

export const buildRemoteDebugPayload = (
  entries: RemoteDebugQueuedEntry[],
  clientInfo: RemoteDebugClientInfo,
): RemoteDebugPayload => ({
  ...clientInfo,
  entries: entries.filter((entry): entry is RemoteDebugQueuedEntry & { level: ReportableDebugLogLevel } =>
    shouldReportRemoteDebugLevel(entry.level),
  ),
})

const remoteDebugEnabled = () =>
  typeof window !== 'undefined' && import.meta.env.VITE_MIVO_REMOTE_DEBUG !== '0'

const sendPayload = async (payload: RemoteDebugPayload) => {
  if (!payload.entries.length) return

  await fetch(resolveRemoteDebugEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: JSON.stringify(payload).length < 60_000,
  })
}

export const flushRemoteDebugEntries = async () => {
  if (!remoteDebugEnabled() || !queue.length) return

  const batch = queue
  queue = []
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
  }

  try {
    await sendPayload(buildRemoteDebugPayload(batch, createBrowserClientInfo()))
  } catch {
    // Remote diagnostics must never interrupt the user's canvas workflow.
  }
}

export const reportRemoteDebugEntry = (entry: RemoteDebugQueuedEntry) => {
  if (!remoteDebugEnabled() || !shouldReportRemoteDebugLevel(entry.level)) return

  queue.push(entry)
  if (queue.length >= maxBatchSize) {
    void flushRemoteDebugEntries()
    return
  }

  if (!flushTimer) {
    flushTimer = window.setTimeout(() => {
      void flushRemoteDebugEntries()
    }, batchDelayMs)
  }
}

export const installRemoteDebugReporter = () => {
  if (!remoteDebugEnabled() || installed) return
  installed = true

  window.addEventListener('pagehide', () => {
    void flushRemoteDebugEntries()
  })
}
