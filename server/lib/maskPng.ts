// server/lib/maskPng.ts
// P2-C2: BFF-side area mask generator for annotation area-edit. The client sends
// the source image's natural size + normalized maskBounds (0-1, relative to the
// source image); the BFF synthesizes a binary RGBA PNG the same dimensions as the
// source, with the edit area (inside bounds) fully transparent and the keep area
// opaque black — the exact format `buildEditMaskBlob` (src/canvas/imageMaskGeometry)
// produces client-side for brush masks, and what llm-proxy /edits expects (alpha=0
// ⇒ editable region). Ruling: mask PNG lives in the BFF (it has the image + bounds;
// the frontend shouldn't touch pixels).
//
// Why a hand-rolled encoder (no `pngjs`/`canvas` dep): the mask is structurally
// trivial (two solid regions split by a rectangle), so a minimal PNG (IHDR + one
// IDAT + IEND, RGBA 8-bit, filter 0) is ~60 lines and avoids a native dependency.
// zlib via node:zlib compresses the uniform rows well.

import { deflateSync } from 'node:zlib'

// PNG chunk CRC-32 (polynomial 0xEDB88320, init/final XOR 0xFFFFFFFF). Precomputed
// table for speed; the mask is small enough that a per-byte loop is fine, but the
// table is cheap and reused across the 3 chunks.
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

// Build a PNG chunk: [length:4][type:4][data:N][crc:4].
const chunk = (type: string, data: Uint8Array): Buffer => {
  const typeBytes = Buffer.from(type, 'ascii')
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.writeUInt32BE(typeBytes.readUInt32BE(0), 4)
  const crcInput = Buffer.concat([typeBytes, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([header, data, crc])
}

export type NormalizedMaskBounds = {
  // All in [0, 1], relative to the source image's natural pixel grid.
  x: number
  y: number
  width: number
  height: number
}

export type MaskSize = { width: number; height: number }

// Sanity cap mirroring src/canvas/imageMaskGeometry.validateMaskCanvasSize — the
// client already enforces this, but the BFF re-validates to avoid a rogue/legacy
// client triggering a multi-hundred-MB allocation.
export const MAX_MASK_EDGE = 6000
export const MAX_MASK_PIXELS = 24_000_000

export const validateMaskSize = (size: MaskSize): void => {
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  if (width > MAX_MASK_EDGE || height > MAX_MASK_EDGE || width * height > MAX_MASK_PIXELS) {
    throw new Error(`图片尺寸 ${width} x ${height} 过大，局部重绘请先导入较低分辨率版本。`)
  }
}

// Generate an RGBA PNG (width×height) where pixels inside `bounds` are transparent
// (0,0,0,0 — editable) and the rest are opaque black (0,0,0,255 — keep). bounds is
// normalized 0-1; out-of-range values are clamped to the image edges. Returns a PNG
// Buffer suitable to append as the `mask` File in the llm-proxy /edits FormData.
export const generateAreaMaskPng = (size: MaskSize, bounds: NormalizedMaskBounds): Buffer => {
  validateMaskSize(size)
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))

  // Pixel-space bounds, clamped to [0, width]/[0, height].
  const bx0 = Math.max(0, Math.min(width, Math.floor(bounds.x * width)))
  const by0 = Math.max(0, Math.min(height, Math.floor(bounds.y * height)))
  const bx1 = Math.max(0, Math.min(width, Math.ceil((bounds.x + bounds.width) * width)))
  const by1 = Math.max(0, Math.min(height, Math.ceil((bounds.y + bounds.height) * height)))

  // Raw scanlines: each row = 1 filter byte (0) + width×4 RGBA bytes. Opaque black
  // = 0,0,0,255; transparent = 0,0,0,0. Rows fully outside the bounds are solid
  // opaque; rows intersecting the bounds are [opaque][transparent][opaque].
  const rowBytes = 1 + width * 4
  const raw = Buffer.alloc(rowBytes * height)
  const opaque = 0xff
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes
    raw[rowStart] = 0 // filter: none
    const inBoundsY = y >= by0 && y < by1
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4
      const editable = inBoundsY && x >= bx0 && x < bx1
      // R=0, G=0, B=0 (already zeroed by alloc); only alpha differs.
      raw[px + 3] = editable ? 0 : opaque
    }
  }

  // IHDR: width, height, bit depth=8, color type=6 (RGBA), compression=0, filter=0, interlace=0.
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: none
  ihdr[12] = 0 // interlace: none

  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
