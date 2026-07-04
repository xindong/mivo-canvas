import { beforeEach, describe, expect, it } from 'vitest'
import { useDebugLogStore } from '../store/debugLogStore'
import {
  formatMivoClientError,
  mivoUpstreamSafetyFailureMessage,
  mivoUpstreamTemporaryFailureMessage,
} from './mivoImageClient'

describe('formatMivoClientError', () => {
  beforeEach(() => {
    useDebugLogStore.getState().clear()
  })

  it('wraps raw 5xx upstream failures and keeps the original error in debug logs', () => {
    const message = formatMivoClientError(502, 'java.nio.channels.ClosedChannelException', 'Test')
    expect(message).toBe(mivoUpstreamTemporaryFailureMessage)
    expect(useDebugLogStore.getState().entries[0]?.message).toContain('ClosedChannelException')
  })

  it('wraps safety-style 400 failures with a user-facing suggestion', () => {
    const message = formatMivoClientError(400, 'request blocked by safety policy', 'Test')
    expect(message).toBe(mivoUpstreamSafetyFailureMessage)
    expect(useDebugLogStore.getState().entries[0]?.message).toContain('safety policy')
  })
})
