import { describe, expect, it } from 'vitest'
import { formatSidebarTime, formatSidebarTimeTitle } from './formatSidebarTime'

// Fixed "now" so boundary assertions are deterministic. 2026-07-06T20:00:00 local
// → use a stable epoch and ISO pair.
const NOW_MS = Date.parse('2026-07-06T12:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

const ago = (seconds: number) => new Date(NOW_MS - seconds * 1000).toISOString()

describe('formatSidebarTime — relative labels (maker rules)', () => {
  it('labels < 60s as 刚刚', () => {
    expect(formatSidebarTime(ago(5), NOW_MS)).toBe('刚刚')
    expect(formatSidebarTime(ago(59), NOW_MS)).toBe('刚刚')
  })

  it('labels < 60m as N 分钟', () => {
    expect(formatSidebarTime(ago(60), NOW_MS)).toBe('1 分钟')
    expect(formatSidebarTime(ago(300), NOW_MS)).toBe('5 分钟')
    expect(formatSidebarTime(ago(3599), NOW_MS)).toBe('59 分钟')
  })

  it('labels < 24h as N 小时', () => {
    expect(formatSidebarTime(ago(3600), NOW_MS)).toBe('1 小时')
    expect(formatSidebarTime(ago(3600 * 5), NOW_MS)).toBe('5 小时')
    expect(formatSidebarTime(ago(3600 * 23), NOW_MS)).toBe('23 小时')
  })

  it('labels < 7d as N 天', () => {
    expect(formatSidebarTime(ago(86400), NOW_MS)).toBe('1 天')
    expect(formatSidebarTime(ago(86400 * 3), NOW_MS)).toBe('3 天')
    expect(formatSidebarTime(ago(86400 * 6), NOW_MS)).toBe('6 天')
  })

  it('labels < 5w as N 周', () => {
    expect(formatSidebarTime(ago(86400 * 7), NOW_MS)).toBe('1 周')
    expect(formatSidebarTime(ago(86400 * 14), NOW_MS)).toBe('2 周')
    expect(formatSidebarTime(ago(86400 * 34), NOW_MS)).toBe('4 周')
  })

  it('labels < 12mo as N 个月', () => {
    // ~35 days (just past 5w boundary) → 1 个月
    expect(formatSidebarTime(ago(86400 * 35), NOW_MS)).toBe('1 个月')
    expect(formatSidebarTime(ago(86400 * 60), NOW_MS)).toBe('2 个月')
    expect(formatSidebarTime(ago(86400 * 330), NOW_MS)).toBe('11 个月')
  })

  it('labels >= 12mo as N 年', () => {
    expect(formatSidebarTime(ago(86400 * 365), NOW_MS)).toBe('1 年')
    expect(formatSidebarTime(ago(86400 * 365 * 3), NOW_MS)).toBe('3 年')
  })

  it('uses Date.now() when now is omitted (smoke; not boundary-asserted)', () => {
    // recent → 刚刚
    expect(formatSidebarTime(new Date(Date.now() - 1000).toISOString())).toBe('刚刚')
  })

  it('handles a future timestamp as 刚刚 (no negative buckets)', () => {
    expect(formatSidebarTime(new Date(NOW_MS + 5000).toISOString(), NOW_MS)).toBe('刚刚')
    void NOW_ISO
  })
})

describe('formatSidebarTimeTitle — absolute time title', () => {
  it('formats as YYYY-MM-DD HH:mm (local time)', () => {
    // Construct an ISO whose local-time rendering is predictable; assert shape.
    const iso = '2026-07-06T12:34:00.000Z'
    const title = formatSidebarTimeTitle(iso)
    expect(title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    // Year and month are timezone-stable.
    expect(title.startsWith('2026-07-')).toBe(true)
  })
})
