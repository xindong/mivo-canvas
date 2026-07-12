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
// W2.6 (QoL batch): optional bodyBytes (request body size, desensitized — just the
// byte count, never the bytes) + upstreamMs (time spent waiting on the upstream
// image API, distinct from total latencyMs which covers the whole BFF handler).
export const logRequest = (info: {
  method: string
  path: string
  requestId: string
  status: number
  upstream?: string
  latencyMs: number
  bodyBytes?: number
  upstreamMs?: number
  note?: string
}): void => {
  const parts = [
    '[mivo-bff]',
    `rid=${info.requestId}`,
    `${info.method} ${info.path}`,
    `-> ${info.status}`,
    info.upstream ? `upstream=${info.upstream}` : '',
    `latency=${info.latencyMs}ms`,
    info.bodyBytes !== undefined ? `body=${info.bodyBytes}B` : '',
    info.upstreamMs !== undefined ? `upstreamMs=${info.upstreamMs}ms` : '',
    info.note || '',
  ].filter(Boolean)
  console.log(parts.join(' '))
}

export const logMaskModelOverride = (info: {
  requestId: string
  path: string
  fromModel: string
  toModel: string
  taskId?: string
}): void => {
  const parts = [
    '[mivo-bff]',
    `rid=${info.requestId}`,
    info.taskId ? `taskId=${info.taskId}` : '',
    `event=mask-model-override`,
    `path=${info.path}`,
    `from=${info.fromModel}`,
    `to=${info.toModel}`,
  ].filter(Boolean)
  console.log(parts.join(' '))
}

export const logTaskTerminal = (info: {
  taskId: string
  requestId: string
  kind: string
  model: string
  quality?: string
  imgRatio?: string
  resolution?: string
  pollDeadlineMs?: number
  platformJobIdHash?: string
  hasMask: boolean
  hasReferences: boolean
  channel: string
  finalStatus: string
  latencyMs: number
  promptLength?: number
  errorClass?: string
  httpStatus?: number
  /** edit-timeout-batch: 分档后的上游超时（ms），据此定位撞线 case。 */
  timeoutMs?: number
  /** 双图指认排查：平台路径实际上传的图片数（2 = 原图+红圈标注图）。 */
  imagesUploaded?: number
  /** mask 区域指令版本：marked=红圈指认 / region=文字坐标定位。 */
  maskClause?: string
}): void => {
  const parts = [
    '[mivo-bff-task]',
    `ts=${new Date().toISOString()}`,
    `taskId=${info.taskId}`,
    `rid=${info.requestId}`,
    `kind=${info.kind}`,
    `model=${info.model}`,
    info.quality ? `quality=${info.quality}` : '',
    info.imgRatio ? `imgRatio=${info.imgRatio}` : '',
    info.resolution ? `resolution=${info.resolution}` : '',
    info.pollDeadlineMs !== undefined ? `pollDeadlineMs=${info.pollDeadlineMs}` : '',
    info.timeoutMs !== undefined ? `timeoutMs=${info.timeoutMs}` : '',
    info.platformJobIdHash ? `platformJobIdHash=${info.platformJobIdHash}` : '',
    `hasMask=${info.hasMask ? 'true' : 'false'}`,
    `hasReferences=${info.hasReferences ? 'true' : 'false'}`,
    `channel=${info.channel}`,
    info.imagesUploaded !== undefined ? `imagesUploaded=${info.imagesUploaded}` : '',
    info.maskClause ? `maskClause=${info.maskClause}` : '',
    `finalStatus=${info.finalStatus}`,
    `latency=${info.latencyMs}ms`,
    info.promptLength !== undefined ? `promptLength=${info.promptLength}` : '',
    info.errorClass ? `errorClass=${info.errorClass}` : '',
    info.httpStatus !== undefined ? `httpStatus=${info.httpStatus}` : '',
  ].filter(Boolean)
  console.log(parts.join(' '))
}

// P-6 saga 补偿日志:restore/delete 第二步(unRevoke/revoke 级联)的 attempt 结果。失败必记(状态改变 + 失败操作,
// 按 docs/development-logging.md);成功也记(可观察:saga 收敛过程可追溯)。nothing-pending 不记(噪声)。
export const logCompensation = (info: {
  requestId: string
  projectId: string
  op: 'restore' | 'delete'
  outcome: 'completed' | 'failed'
  attempts: number
  count?: number
  error?: string
}): void => {
  const parts = [
    '[mivo-bff-compensation]',
    `ts=${new Date().toISOString()}`,
    `rid=${info.requestId}`,
    `project=${info.projectId}`,
    `op=${info.op}`,
    `outcome=${info.outcome}`,
    `attempts=${info.attempts}`,
    info.count !== undefined ? `count=${info.count}` : '',
    info.error ? `error=${info.error}` : '',
  ].filter(Boolean)
  console.log(parts.join(' '))
}
