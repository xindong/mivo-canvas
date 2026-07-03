// server/lib/upstream.ts
// HTTP helpers ported from vite.config.ts (fetchUpstreamWithTimeout / readUpstreamError /
// error classes). Timeout default reads getEnvConfig() lazily so tests can override.
import { getEnvConfig } from './config'

export class RequestBodyTooLargeError extends Error {}
export class UpstreamRequestTimeoutError extends Error {}

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

// Link an external cancel signal (e.g. a task's AbortController) into the
// timeout controller so either trigger aborts the fetch. Avoids AbortSignal.any
// for lib-portability; the `timedOut` flag below still distinguishes the cause
// (timeout → UpstreamRequestTimeoutError; external cancel → AbortError rethrow).
const linkExternalSignal = (controller: AbortController, external?: AbortSignal): void => {
  if (!external) return
  if (external.aborted) {
    controller.abort()
    return
  }
  external.addEventListener('abort', () => controller.abort(), { once: true })
}

export const fetchUpstreamWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs?: number,
  externalSignal?: AbortSignal,
): Promise<Response> => {
  const limit = timeoutMs ?? getEnvConfig().upstreamTimeoutMs
  const controller = new AbortController()
  let timedOut = false
  // P2-C1a: propagate task cancel into the upstream fetch (llm-proxy path).
  linkExternalSignal(controller, externalSignal)
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
