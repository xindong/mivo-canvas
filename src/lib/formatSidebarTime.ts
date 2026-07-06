// formatSidebarTime — relative + absolute time labels for the sidebar (Phase 2 / A1·A2).
//
// Ported from maker's formatSidebarTime rules, labels localized to Chinese to match
// the existing sidebar UI language. Pure functions: no React, no globals except
// Date.now() (injectable via the `now` arg for deterministic tests).

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86400

const pad = (value: number) => String(value).padStart(2, '0')

/** Relative label: 刚刚 / N 分钟 / N 小时 / N 天 / N 周 / N 个月 / N 年. */
export const formatSidebarTime = (iso: string, now?: number): string => {
  const nowMs = typeof now === 'number' ? now : Date.now()
  const thenMs = Date.parse(iso)
  if (Number.isNaN(thenMs)) return '刚刚'

  let seconds = Math.floor((nowMs - thenMs) / 1000)
  if (seconds < 0) seconds = 0 // future timestamps collapse to 刚刚 (no negative buckets)

  if (seconds < SECONDS_PER_MINUTE) return '刚刚'

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
  if (minutes < 60) return `${minutes} 分钟`

  const hours = Math.floor(seconds / SECONDS_PER_HOUR)
  if (hours < 24) return `${hours} 小时`

  const days = Math.floor(seconds / SECONDS_PER_DAY)
  if (days < 7) return `${days} 天`

  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks} 周`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月`

  const years = Math.floor(days / 365)
  return `${years} 年`
}

/** Absolute title label: YYYY-MM-DD HH:mm (local time), for the `title` attribute. */
export const formatSidebarTimeTitle = (iso: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
