import type { Context } from 'hono'
import { mimeForFile } from './assets'
import type { AppEnv } from './types'

// Hono-flavored successor to vite.config.ts sendImageBuffer (L1056-L1060):
// sets Content-Type via magic-byte sniff + Cache-Control: no-store, then
// streams the bytes. Used by local-assets file and eagle thumbnail/file routes.
//
// Hono's `Data` type is `string | ArrayBuffer | ReadableStream | Uint8Array<ArrayBuffer>`;
// Node's Buffer is `Uint8Array<ArrayBufferLike>`, which does not satisfy that.
// `as never` is the only cast that bypasses the overload resolution landing on
// the `null` overload. At runtime Response accepts Buffer (a BufferSource).
export const sendImageBuffer = (c: Context<AppEnv>, file: Buffer, filePath: string): Response => {
  c.header('Content-Type', mimeForFile(file, filePath))
  c.header('Cache-Control', 'no-store')
  return c.body(file as never)
}
