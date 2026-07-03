import type { Context } from 'hono'
import type { AppEnv } from './types'

// Plain-text response with NO Content-Type header, matching the dev-middleware
// quirk preserved as D3/D4 known-quirks (vite.config.ts sets neither Content-Type
// nor a JSON envelope on 403/404/502/500 plain-text errors).
//
// Implementation note: Hono's c.body builds a Web Response. A string body makes
// the Response spec auto-set `text/plain;charset=UTF-8`, which would break the
// `content-type: null` invariant in server/contracts/__captures__. Using a
// Buffer body avoids that auto header. c.body's signature is
// `(data: Data | null, init?: ResponseInit | Response)` — status goes in the
// ResponseInit, not as a bare number. `as never` bypasses the Buffer vs
// Uint8Array<ArrayBuffer> overload mismatch (runtime: Response accepts Buffer).
export const plainTextNoContentType = (c: Context<AppEnv>, text: string, status: number): Response =>
  c.body(Buffer.from(text) as never, { status: status as never })

// JSON response with Content-Type: application/json; charset=utf-8, matching the
// dev-middleware baseline (captures record "application/json; charset=utf-8";
// vite.config.ts used setHeader('Content-Type', 'application/json; charset=utf-8')).
// Hono's c.json omits the charset in some runtimes, so we set it explicitly to
// keep the contract diff at zero.
export const jsonResponse = (payload: unknown, status?: number): Response =>
  new Response(JSON.stringify(payload), {
    ...(status !== undefined ? { status } : {}),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
