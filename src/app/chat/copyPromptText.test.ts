import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store/remoteDebugReporter', () => ({ reportRemoteDebugEntry: () => {} }))

import { copyPromptText } from './copyPromptText'
import { useDebugLogStore } from '../../store/debugLogStore'
import { useToastStore } from '../../store/toastStore'

const chatLogs = () =>
  useDebugLogStore.getState().entries.filter((e) => e.source === 'Chat').map((e) => `${e.level}:${e.message}`)
const toasts = () => useToastStore.getState().entries.map((e) => `${e.level}:${e.message}`)

const stubDocumentCopy = (result: boolean | Error) => {
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(),
  }
  vi.stubGlobal('document', {
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn() },
    execCommand: vi.fn(() => {
      if (result instanceof Error) throw result
      return result
    }),
  })
  return textarea
}

beforeEach(() => {
  useDebugLogStore.getState().clear()
  useToastStore.getState().clearToasts()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyPromptText', () => {
  it('copies via navigator.clipboard and logs success + toast 已复制', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyPromptText('一段提示词')).resolves.toBe(true)

    expect(writeText).toHaveBeenCalledWith('一段提示词')
    expect(toasts()).toEqual(['success:已复制'])
    expect(chatLogs()).toEqual(['log:Prompt copied to clipboard (5 chars)'])
  })

  it('falls back to execCommand when clipboard API rejects', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const textarea = stubDocumentCopy(true)

    await expect(copyPromptText('fallback text')).resolves.toBe(true)

    expect(textarea.value).toBe('fallback text')
    expect(toasts()).toEqual(['success:已复制'])
    expect(chatLogs()).toEqual(['log:Prompt copied via execCommand fallback (13 chars)'])
  })

  it('uses execCommand directly when clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    stubDocumentCopy(true)

    await expect(copyPromptText('no api')).resolves.toBe(true)
    expect(toasts()).toEqual(['success:已复制'])
  })

  it('toasts 复制失败 and warns when both paths fail (失败路径日志硬规约)', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    stubDocumentCopy(false)

    await expect(copyPromptText('boom')).resolves.toBe(false)

    expect(toasts()).toEqual(['error:复制失败'])
    expect(chatLogs()).toEqual(['warning:Prompt copy failed: denied'])
  })
})
