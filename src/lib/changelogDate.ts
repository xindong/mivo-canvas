// 更新日志的"结算日"边界：每天 8:00(本地时区)为界——07:59 属前一天,08:00 起属当天。
// 实现钉死本地 calendar getters(getFullYear/getMonth/getDate),禁用 toISOString():
// 后者取的是 UTC 日,在东八区会把 8:00 边界错移成 16:00。
const DAY_BOUNDARY_HOUR = 8
const HOUR_MS = 3_600_000

const formatLocalDay = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const toChangelogDay = (ts: number): string =>
  formatLocalDay(new Date(ts - DAY_BOUNDARY_HOUR * HOUR_MS))

export const recentDays = (now: number, n = 7): string[] => {
  const shifted = new Date(now - DAY_BOUNDARY_HOUR * HOUR_MS)
  return Array.from({ length: n }, (_, index) =>
    formatLocalDay(new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate() - index)),
  )
}
