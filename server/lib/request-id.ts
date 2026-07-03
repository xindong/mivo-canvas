import type { MiddlewareHandler } from 'hono'
import { randomUUID } from 'node:crypto'
import type { AppEnv } from './types'

// Per-request correlation id. Echoed on the response header and in the log
// line so a client-reported id can be traced to a server log entry.
export const HEADER_REQUEST_ID = 'x-mivo-request-id'

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header(HEADER_REQUEST_ID)
  const id = incoming || randomUUID()
  c.set('requestId', id)
  c.header(HEADER_REQUEST_ID, id)
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  // Log only method/path/status/latency/id. Per roadmap §6.2 P1-c: never log
  // API keys, image blobs, or full prompts. Path is already safe (no query
  // secrets here; eagle query strings are limit/offset/folderId/tags).
  console.log(`[mivo-bff] req id=${id} ${c.req.method} ${c.req.path} → ${c.res.status} ${ms}ms`)
}
