// server/lib/upstream.ts
// HTTP helpers ported from vite.config.ts (fetchUpstreamWithTimeout / readUpstreamError /
// error classes). Timeout default reads getEnvConfig() lazily so tests can override.
import { getEnvConfig } from './config'

export class RequestBodyTooLargeError extends Error {}
export class UpstreamRequestTimeoutError extends Error {}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

export const fetchUpstreamWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> => {
  const limit = timeoutMs ?? getEnvConfig().upstreamTimeoutMs
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, limit)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (isAbortError(error) && timedOut) {
      throw new UpstreamRequestTimeoutError('Image API request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export const readUpstreamError = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: { message?: string } | string; message?: string }
    if (typeof payload.error === 'string') return payload.error
    return payload.error?.message || payload.message || `${response.status} ${response.statusText}`
  } catch {
    try {
      return await response.text()
    } catch {
      return `${response.status} ${response.statusText}`
    }
  }
}
