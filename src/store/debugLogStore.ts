import { create } from 'zustand'
import { reportRemoteDebugEntry } from './remoteDebugReporter'

export type DebugLogLevel = 'log' | 'warning' | 'error'

export type DebugLogEntry = {
  id: string
  level: DebugLogLevel
  message: string
  source: string
  timestamp: number
}

type DebugLogState = {
  entries: DebugLogEntry[]
  addEntry: (entry: Omit<DebugLogEntry, 'id' | 'timestamp'> & { timestamp?: number }) => void
  clear: () => void
}

const maxEntries = 240
let nextEntryId = 0
let consoleCaptureInstalled = false

const normalizeMessage = (value: unknown): string => {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const formatConsoleArgs = (args: unknown[]) => args.map(normalizeMessage).join(' ')

export const useDebugLogStore = create<DebugLogState>()((set) => ({
  entries: [],
  addEntry: (entry) =>
    set((state) => ({
      entries: [
        {
          id: `debug-${Date.now()}-${nextEntryId++}`,
          timestamp: entry.timestamp || Date.now(),
          level: entry.level,
          source: entry.source,
          message: entry.message,
        },
        ...state.entries,
      ].slice(0, maxEntries),
    })),
  clear: () => set({ entries: [] }),
}))

export const debugLogger = {
  log: (source: string, message: string) => {
    useDebugLogStore.getState().addEntry({ level: 'log', source, message })
  },
  warn: (source: string, message: string) => {
    const timestamp = Date.now()
    useDebugLogStore.getState().addEntry({ level: 'warning', source, message, timestamp })
    reportRemoteDebugEntry({ level: 'warning', source, message, timestamp })
  },
  // T2-4:可选第三参传原始 Error(或已有的 stack 字符串),error.stack 随远程上报
  // 附带(reporter 组包时截断 ≤2KB,服务端落库前脱敏)。本地面板 message 行为不变;
  // 既有二参调用零改动(可选参,向后兼容)。
  error: (source: string, message: string, cause?: unknown) => {
    const timestamp = Date.now()
    const stack =
      cause instanceof Error ? cause.stack : typeof cause === 'string' ? cause : undefined
    useDebugLogStore.getState().addEntry({ level: 'error', source, message, timestamp })
    reportRemoteDebugEntry({ level: 'error', source, message, timestamp, stack })
  },
}

export const installConsoleCapture = () => {
  if (consoleCaptureInstalled || typeof window === 'undefined') return
  consoleCaptureInstalled = true

  const originalLog = console.log.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalError = console.error.bind(console)

  console.log = (...args: unknown[]) => {
    originalLog(...args)
    debugLogger.log('Console', formatConsoleArgs(args))
  }
  console.warn = (...args: unknown[]) => {
    originalWarn(...args)
    debugLogger.warn('Console', formatConsoleArgs(args))
  }
  console.error = (...args: unknown[]) => {
    originalError(...args)
    // T2-4:console.error(err) 是生产真实异常的主要入口——把首个 Error 参数透传,
    // 让远程记录带上结构化 stack(message 内嵌的 stack 文本行为保持不变)。
    debugLogger.error(
      'Console',
      formatConsoleArgs(args),
      args.find((arg) => arg instanceof Error),
    )
  }
}
