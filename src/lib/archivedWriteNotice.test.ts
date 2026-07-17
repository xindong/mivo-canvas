import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toastFeedback } from '../store/toastStore'
import {
  __getArchivedWriteNoticeSize,
  __resetArchivedWriteNotice,
  notifyArchivedWriteBlocked,
} from './archivedWriteNotice'

describe('archived write shared notifier', () => {
  beforeEach(() => {
    __resetArchivedWriteNotice()
    vi.restoreAllMocks()
  })

  it('deduplicates the same canvas within three seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_999)
    const warn = vi.spyOn(toastFeedback, 'warn').mockImplementation(() => 'toast')

    notifyArchivedWriteBlocked('c1')
    notifyArchivedWriteBlocked('c1')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('此画布已归档,请先恢复再编辑。')
  })

  it('keeps different canvases independently visible', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const warn = vi.spyOn(toastFeedback, 'warn').mockImplementation(() => 'toast')

    notifyArchivedWriteBlocked('c1')
    notifyArchivedWriteBlocked('c2')

    expect(warn).toHaveBeenCalledTimes(2)
  })

  // PR-C1 二轮 P3(SC-4):去重窗口外同 canvasId 重新弹 toast + 过期条目从 Map 移除(防长会话单调增长)。
  it('re-pops the toast for the same canvas after the dedup window elapses', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_000 + 3_000)
    const warn = vi.spyOn(toastFeedback, 'warn').mockImplementation(() => 'toast')

    notifyArchivedWriteBlocked('c1') // t=1000 → toast
    notifyArchivedWriteBlocked('c1') // t=4000, window elapsed → toast again (3000 < 3000 is false)

    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('purges expired entries on notify to bound memory across long sessions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    vi.spyOn(toastFeedback, 'warn').mockImplementation(() => 'toast')

    notifyArchivedWriteBlocked('c1') // t=1000 → {c1: 1000}
    expect(__getArchivedWriteNoticeSize()).toBe(1)

    // advance past dedup window and notify a different canvas
    vi.spyOn(Date, 'now').mockReturnValue(1_000 + 3_000 + 1)
    notifyArchivedWriteBlocked('c2') // cleanup removes c1, adds c2

    expect(__getArchivedWriteNoticeSize()).toBe(1) // c1 purged, only c2 remains
  })
})
