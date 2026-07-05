import { describe, expect, it } from 'vitest'
import { recentDays, toChangelogDay } from '../changelogDate'

// 所有样例用本地时间构造(new Date(y, m, d, h, min)),断言与运行环境时区无关:
// 8:00 边界语义定义在本地时区上,本地构造 + 本地取日天然自洽。
const localTs = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number => new Date(year, month - 1, day, hour, minute).getTime()

describe('toChangelogDay', () => {
  it('07:59 归前一天', () => {
    expect(toChangelogDay(localTs(2026, 7, 5, 7, 59))).toBe('2026-07-04')
  })

  it('08:00 整点起归当天', () => {
    expect(toChangelogDay(localTs(2026, 7, 5, 8, 0))).toBe('2026-07-05')
  })

  it('08:01 归当天', () => {
    expect(toChangelogDay(localTs(2026, 7, 5, 8, 1))).toBe('2026-07-05')
  })

  it('跨月:8月1日 07:59 归 7月31日', () => {
    expect(toChangelogDay(localTs(2026, 8, 1, 7, 59))).toBe('2026-07-31')
  })

  it('跨年:1月1日 07:59 归上年 12月31日', () => {
    expect(toChangelogDay(localTs(2026, 1, 1, 7, 59))).toBe('2025-12-31')
  })

  it('本地时区语义:取本地 calendar 日,不等于 toISOString 的 UTC 日', () => {
    const ts = localTs(2026, 7, 5, 8, 0)
    expect(toChangelogDay(ts)).toBe('2026-07-05')
    const shifted = new Date(ts - 8 * 3_600_000)
    if (shifted.getTimezoneOffset() < 0) {
      // 东侧时区(如 Asia/Shanghai):shifted 是本地 00:00,UTC 日仍是前一天。
      // 若实现误用 toISOString 取日,这里会拿到 2026-07-04 而非 2026-07-05。
      expect(shifted.toISOString().slice(0, 10)).toBe('2026-07-04')
      expect(toChangelogDay(ts)).not.toBe(shifted.toISOString().slice(0, 10))
    }
  })
})

describe('recentDays', () => {
  it('默认返回最近 7 个结算日,降序且包含当前结算日', () => {
    const days = recentDays(localTs(2026, 7, 5, 12, 0))
    expect(days).toEqual([
      '2026-07-05',
      '2026-07-04',
      '2026-07-03',
      '2026-07-02',
      '2026-07-01',
      '2026-06-30',
      '2026-06-29',
    ])
  })

  it('08:00 前调用时窗口从前一天开始', () => {
    const days = recentDays(localTs(2026, 7, 5, 7, 30), 2)
    expect(days).toEqual(['2026-07-04', '2026-07-03'])
  })

  it('7 天窗口过滤:窗口外日期不在列表内', () => {
    const days = recentDays(localTs(2026, 7, 5, 12, 0))
    expect(days).not.toContain('2026-06-28')
    expect(days).toHaveLength(7)
  })
})
