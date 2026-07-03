// server/lib/request.ts
// Request-side helpers: body reading (clean 413), multipart parsing, requestId,
// request logger. Ported from vite.config.ts with D1 fix (no request.destroy()).
import type { Context } from 'hono'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { getEnvConfig } from './config'
import { RequestBodyTooLargeError } from './upstream'

type ParsedMivoMultipart = {
  fields: Map<string, string[]>
  files: Map<string, File[]>
}

// Read the request body as a Buffer, enforcing a hard size cap.
// D1 (intentional change vs dev middleware): on overflow we throw and let the
// caller return a clean 413. dev called request.destroy() which tore the socket
// down BEFORE the 413 could be delivered (client observed ECONNRESET). BFF
// delivers an observable 413 without destroying the request prematurely.
export const readBodyWithLimit = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new RequestBodyTooLargeError('Request body is too large')
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

export const readJsonBody = async <T>(c: Context, maxBytes?: number): Promise<T> => {
  const limit = maxBytes ?? getEnvConfig().jsonRequestMaxBytes
  const buffer = await readBodyWithLimit(c.req.raw.body, limit)
  if (!buffer.length) return {} as T
  return JSON.parse(buffer.toString('utf8')) as T
}

export const parseMultipartBody = async (c: Context): Promise<ParsedMivoMultipart> => {
  const buffer = await readBodyWithLimit(c.req.raw.body, getEnvConfig().imageRequestMaxBytes)
  const webRequest = new Request('http://127.0.0.1/api/mivo/edit', {
    method: c.req.method || 'POST',
    headers: c.req.raw.headers,
    body: buffer,
  })
  const formData = await webRequest.formData()
  const fields = new Map<string, string[]>()
  const files = new Map<string, File[]>()
  formData.forEach((value, key) => {
    if (value instanceof File) {
      const next = files.get(key) || []
      next.push(value)
      files.set(key, next)
      return
    }
    const next = fields.get(key) || []
    next.push(value)
    fields.set(key, next)
  })
  return { fields, files }
}

export const firstMultipartField = (fields: Map<string, string[]>, key: string): string =>
  fields.get(key)?.[0] || ''

export const multipartFiles = (files: Map<string, File[]>, key: string): File[] =>
  files.get(key) || []

export const appendFile = (formData: FormData, key: string, file: File): void => {
  formData.append(key, file, file.name || `${key}.png`)
}

export const newRequestId = (): string => randomUUID()

// Request logger — records upstream status / latency / timeout / abort.
// NEVER logs API key, original image blob, or full prompt (per §6.1).
export const logRequest = (info: {
  method: string
  path: string
  requestId: string
  status: number
  upstream?: string
  latencyMs: number
  note?: string
}): void => {
  const parts = [
    '[mivo-bff]',
    `rid=${info.requestId}`,
    `${info.method} ${info.path}`,
    `-> ${info.status}`,
    info.upstream ? `upstream=${info.upstream}` : '',
    `latency=${info.latencyMs}ms`,
    info.note || '',
  ].filter(Boolean)
  console.log(parts.join(' '))
}
