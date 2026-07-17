import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toastFeedback } from '../store/toastStore'
import { __resetArchivedWriteNotice, notifyArchivedWriteBlocked } from './archivedWriteNotice'

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
})
