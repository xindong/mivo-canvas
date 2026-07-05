// 更新日志面板:复用 Debug Log 的 createPortal + backdrop 模式(ProjectSidebar 内联版)。
// 每天一个区块,左列"✨ 新功能"、右列"🔧 修复的问题",只展示最近 7 个结算日。
import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { recentDays } from '../lib/changelogDate'
import { useChangelogStore } from '../store/changelogStore'

type ChangelogPanelProps = {
  // 打开面板那一刻的时间戳(事件处理器里取,规避 render 期调用 Date.now 的纯度限制)。
  openedAt: number
  onClose: () => void
}

export const ChangelogPanel = ({ openedAt, onClose }: ChangelogPanelProps) => {
  const entries = useChangelogStore((state) => state.entries)
  const updatedAt = useChangelogStore((state) => state.updatedAt)
  const markRead = useChangelogStore((state) => state.markRead)

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
      <section className="changelog-panel" role="dialog" aria-modal="true" aria-label="更新日志">
        <header className="changelog-header">
          <div>
            <strong>更新日志</strong>
            <span>最近 7 天</span>
          </div>
          <button type="button" aria-label="关闭更新日志" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="changelog-list" aria-label="最近更新">
          {visibleEntries.length ? (
            visibleEntries.map((entry) => (
              <article key={entry.date} className="changelog-day">
                <h3 className="changelog-day-date">{entry.date}</h3>
                <div className="changelog-day-columns">
                  <div className="changelog-column">
                    <h4>✨ 新功能</h4>
                    {entry.features.length ? (
                      <ul>
                        {entry.features.map((item, index) => (
                          <li key={`${index}-${item.text}`}>
                            {item.text}
                            {item.by ? <span className="changelog-item-by">{item.by}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="changelog-column-empty">暂无</p>
                    )}
                  </div>
                  <div className="changelog-column">
                    <h4>🔧 修复的问题</h4>
                    {entry.fixes.length ? (
                      <ul>
                        {entry.fixes.map((item, index) => (
                          <li key={`${index}-${item.text}`}>
                            {item.text}
                            {item.by ? <span className="changelog-item-by">{item.by}</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="changelog-column-empty">暂无</p>
                    )}
                  </div>
                </div>
              </article>
            ))
          ) : (
            <p className="changelog-empty">最近 7 天暂无更新</p>
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}
