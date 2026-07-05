// 更新日志面板:复用 Debug Log 的 createPortal + backdrop 模式(ProjectSidebar 内联版)。
// 最近 7 个结算日内有数据的日期按天轮播,单日卡片内部保留滚动区。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { recentDays } from '../lib/changelogDate'
import { useChangelogStore, type ChangelogItem } from '../store/changelogStore'

type ChangelogPanelProps = {
  // 打开面板那一刻的时间戳(事件处理器里取,规避 render 期调用 Date.now 的纯度限制)。
  openedAt: number
  onClose: () => void
}

type ChangelogAuthorGroup = {
  author: string
  items: ChangelogItem[]
}

const groupItemsByAuthor = (items: ChangelogItem[]): ChangelogAuthorGroup[] => {
  const order: string[] = []
  const buckets = new Map<string, ChangelogItem[]>()
  const anonymous: ChangelogItem[] = []

  for (const item of items) {
    const author = item.by.trim()
    if (!author) {
      anonymous.push(item)
      continue
    }

    if (!buckets.has(author)) {
      buckets.set(author, [])
      order.push(author)
    }
    buckets.get(author)?.push(item)
  }

  const groups = order.map((author) => ({ author, items: buckets.get(author) ?? [] }))
  if (anonymous.length) {
    groups.push({ author: '', items: anonymous })
  }
  return groups
}

const formatCarouselDate = (date: string) => {
  const [, month = '', day = ''] = date.split('-')
  return `${Number(month)}-${day}`
}

type ChangelogColumnProps = {
  title: string
  items: ChangelogItem[]
}

const ChangelogColumn = ({ title, items }: ChangelogColumnProps) => {
  const groups = groupItemsByAuthor(items)

  return (
    <div className="changelog-column">
      <h4>{title}</h4>
      {groups.length ? (
        <div className="changelog-author-groups">
          {groups.map((group, groupIndex) => (
            <section
              key={group.author || `anonymous-${groupIndex}`}
              className={group.author ? 'changelog-author-group' : 'changelog-author-group anonymous'}
            >
              {group.author ? <strong className="changelog-author-name">{group.author}</strong> : null}
              <ul>
                {group.items.map((item, index) => (
                  <li key={`${group.author}-${index}-${item.text}`}>{item.text}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="changelog-column-empty">暂无</p>
      )}
    </div>
  )
}

export const ChangelogPanel = ({ openedAt, onClose }: ChangelogPanelProps) => {
  const entries = useChangelogStore((state) => state.entries)
  const updatedAt = useChangelogStore((state) => state.updatedAt)
  const markRead = useChangelogStore((state) => state.markRead)
  const panelRef = useRef<HTMLElement | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // 依赖 updatedAt:面板打开早于 fetch 完成时,首次 markRead 空转(updatedAt 尚为空),
  // 数据到达后需再标记一次,否则红点会在面板开着时点亮且关闭不清除。
  useEffect(() => {
    markRead()
  }, [markRead, updatedAt])

  const visibleEntries = useMemo(() => {
    const window7 = new Set(recentDays(openedAt))
    return entries
      .filter((entry) => window7.has(entry.date))
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }, [entries, openedAt])

  const maxIndex = Math.max(visibleEntries.length - 1, 0)
  const activeIndex = Math.min(currentIndex, maxIndex)

  const currentEntry = visibleEntries[activeIndex]
  const canGoEarlier = activeIndex < visibleEntries.length - 1
  const canGoNewer = activeIndex > 0
  const focusPanel = () => panelRef.current?.focus()
  const goEarlier = () => setCurrentIndex((index) => Math.min(Math.min(index, maxIndex) + 1, maxIndex))
  const goNewer = () => setCurrentIndex((index) => Math.max(Math.min(index, maxIndex) - 1, 0))

  // 轮播轨道语义:最左是最新的一天,越往右越早——左键朝最新走,右键朝更早走。
  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || maxIndex < 1) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goNewer()
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      goEarlier()
    }
  }

  return createPortal(
    <div
      className="changelog-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <section
        ref={panelRef}
        className="changelog-panel"
        role="dialog"
        aria-modal="true"
        aria-label="更新日志"
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
      >
        <header className="changelog-header">
          <div className="changelog-title-block">
            <strong>更新日志</strong>
            <span>最近 7 天</span>
          </div>
          <button type="button" aria-label="关闭更新日志" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="changelog-carousel" aria-label="最近更新">
          {currentEntry ? (
            <>
              <div className="changelog-date-bar" aria-live="polite">
                <span className="changelog-current-date">{formatCarouselDate(currentEntry.date)}</span>
              </div>
              <div className="changelog-carousel-stage">
                <button
                  type="button"
                  className="changelog-carousel-arrow"
                  aria-label="切换到更新的更新日志"
                  disabled={!canGoNewer}
                  onClick={() => {
                    goNewer()
                    focusPanel()
                  }}
                >
                  <ChevronLeft size={18} />
                </button>
                <article key={currentEntry.date} className="changelog-day" data-date={currentEntry.date}>
                  <h3 className="changelog-day-date">{currentEntry.date}</h3>
                  <div className="changelog-day-scroll">
                    <div className="changelog-day-columns">
                      <ChangelogColumn title="✨ 新功能" items={currentEntry.features} />
                      <ChangelogColumn title="🔧 修复的问题" items={currentEntry.fixes} />
                    </div>
                  </div>
                </article>
                <button
                  type="button"
                  className="changelog-carousel-arrow"
                  aria-label="切换到更早更新日志"
                  disabled={!canGoEarlier}
                  onClick={() => {
                    goEarlier()
                    focusPanel()
                  }}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <div className="changelog-dots" aria-hidden="true">
                {visibleEntries.map((entry, index) => (
                  <span
                    key={entry.date}
                    className={index === activeIndex ? 'changelog-dot active' : 'changelog-dot'}
                  />
                ))}
              </div>
            </>
          ) : (
            <p className="changelog-empty">最近 7 天暂无更新</p>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}
