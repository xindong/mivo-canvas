// 更新日志独立小 store(仿 cameraFocusStore 模式,不并入 canvasStore)。
// 数据源是 public/changelog.json 静态直出;未读红点比对顶层 updatedAt 与
// localStorage 里的 lastRead(同一天下午追加新 PR 也会重新点亮)。
import { create } from 'zustand'
import { recentDays } from '../lib/changelogDate'
import { debugLogger } from './debugLogStore'
import { toastFeedback } from './toastStore'

export type ChangelogItem = {
  text: string
  by: string
}

export type ChangelogEntry = {
  date: string
  prs: number[]
  features: ChangelogItem[]
  fixes: ChangelogItem[]
}

type ChangelogDocument = {
  lastGithash?: string
  updatedAt?: string
  entries?: unknown[]
}

// 向后兼容防御:旧版 changelog.json 的条目是 string,新版是 {text, by}。
// 读到 string 时当作 {text: 该串, by: ''}(by 为空面板不显示作者名)。
const normalizeItems = (raw: unknown): ChangelogItem[] => {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item): ChangelogItem => {
      if (typeof item === 'string') return { text: item, by: '' }
      if (item && typeof item === 'object') {
        const record = item as { text?: unknown; by?: unknown }
        return {
          text: typeof record.text === 'string' ? record.text : '',
          by: typeof record.by === 'string' ? record.by : '',
        }
      }
      return { text: '', by: '' }
    })
    .filter((item) => item.text.length > 0)
}

const normalizeEntry = (raw: unknown): ChangelogEntry | null => {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as { date?: unknown; prs?: unknown; features?: unknown; fixes?: unknown }
  if (typeof record.date !== 'string' || !record.date) return null
  return {
    date: record.date,
    prs: Array.isArray(record.prs) ? record.prs.filter((pr): pr is number => typeof pr === 'number') : [],
    features: normalizeItems(record.features),
    fixes: normalizeItems(record.fixes),
  }
}

const lastReadStorageKey = 'mivo.changelog.lastRead'

const readStoredLastRead = (): string => {
  try {
    return window.localStorage.getItem(lastReadStorageKey) ?? ''
  } catch {
    return ''
  }
}

type ChangelogState = {
  entries: ChangelogEntry[]
  updatedAt: string
  loaded: boolean
  lastRead: string
  loadChangelog: () => Promise<void>
  markRead: () => void
}

export const useChangelogStore = create<ChangelogState>()((set, get) => ({
  entries: [],
  updatedAt: '',
  loaded: false,
  lastRead: readStoredLastRead(),
  loadChangelog: async () => {
    try {
      const response = await fetch(`/changelog.json?t=${Date.now()}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const doc = (await response.json()) as ChangelogDocument
      const entries = (Array.isArray(doc.entries) ? doc.entries : [])
        .map(normalizeEntry)
        .filter((entry): entry is ChangelogEntry => entry !== null)
      set({ entries, updatedAt: doc.updatedAt ?? '', loaded: true })
      if (!entries.length) {
        debugLogger.warn('Changelog', 'Changelog loaded but no entries recorded yet')
        return
      }
      const window7 = new Set(recentDays(Date.now()))
      const recentCount = entries.filter((entry) => window7.has(entry.date)).length
      if (!recentCount) {
        debugLogger.warn('Changelog', `Changelog loaded: ${entries.length} entries, none within the last 7 days`)
        return
      }
      debugLogger.log('Changelog', `Changelog loaded: ${entries.length} entries, ${recentCount} within the last 7 days`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLogger.error('Changelog', `Changelog load failed: ${message}`)
      toastFeedback.error('更新日志加载失败，请稍后重试')
    }
  },
  markRead: () => {
    const { updatedAt, lastRead } = get()
    if (!updatedAt || updatedAt === lastRead) return
    try {
      window.localStorage.setItem(lastReadStorageKey, updatedAt)
    } catch {
      // localStorage 不可用(隐私模式等)时红点仅本次会话内消失,可接受降级。
    }
    set({ lastRead: updatedAt })
  },
}))

export const selectHasUnreadChangelog = (state: Pick<ChangelogState, 'loaded' | 'updatedAt' | 'lastRead'>): boolean =>
  state.loaded && Boolean(state.updatedAt) && state.updatedAt !== state.lastRead
