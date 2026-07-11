// server/lib/canonicalize.ts
// P1-A (third-round root fix): replace the magic-byte sniffer with a full decode +
// canonical re-encode via sharp. The uploaded bytes are handed to sharp; only bytes
// that DECODE to a real image in the static-image allowlist (png/jpeg/webp/gif/avif)
// are accepted, and the STORED bytes are sharp's re-encoded canonical output — so
// assetId = sha256(canonical). Polyglots / truncated headers / trailing payloads
// either fail to decode outright (→ 415) or are stripped by the re-encode (a
// decodable image with trailing script → clean canonical bytes; the trailing payload
// "naturally disappears").
//
// Why this is the root fix: the old sniffer validated a format HEADER only (magic +
// leading chunk/box/LSD integrity). A byte-perfect-but-corrupt payload that still
// parsed its header was accepted at the gate (a "200 false positive"). sharp does a
// FULL decode — libvips/vips parses the entire image — so a truncated PNG (no IDAT),
// a 16-byte RIFF/WEBP shell (no VP8 bitstream), a 14-byte GIF (no image data), or a
// JPEG header + trailing script (no scan data) all fail to decode → 415. No hand-
// rolled per-format validator can keep pace with format quirks; deferring to the
// decoder is the safe boundary.
//
// Decode-bomb guard (P1-A): a small compressed payload can expand to a huge
// uncompressed buffer on decode. We bound both the per-frame dimension
// (maxDimension, default 12000) and the total decoded pixel count across all frames
// (maxPixels) BEFORE committing to the full re-encode. A request exceeding either
// → 413 image_too_large.
//
// Animation preservation (P1-A): GIF/WebP animations are read with
// { animated: true } so all frames/pages load, and re-encoded with the same option
// so frames are preserved (without it, sharp collapses to the first page — verified
// empirically). Animated AVIF is also read with animated:true.
//
// This module is SERVER-only (runs in node via tsx; never bundled into the browser —
// Vite only builds src/, and server/ is type-checked via tsconfig.server.json with
// noEmit). sharp is a native dep with prebuilt binaries for linux-x64 (CI) and
// darwin-arm64 (dev); package-lock.json pins all platform variants as optionalDeps
// so `npm ci` on Linux installs @img/sharp-linux-x64 without a build step.

import sharp from 'sharp'
import { Buffer } from 'node:buffer'

/**
 * sharp reports the detected input format via `metadata().format`. AVIF inputs come
 * back as `'heif'` (the ISOBMFF container brand); we normalize both to image/avif.
 * The MIME is what we store on the record and serve on GET.
 */
const SHARP_FORMAT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heif: 'image/avif',
  avif: 'image/avif',
}

/**
 * The sharp output encoder name per detected input format. We re-encode in the SAME
 * format sharp decoded (the lead-chosen canonical policy: "按解码出的真实格式重编码"),
 * so a PNG stays PNG, a JPEG stays JPEG, etc. heif (avif input) → 'avif' encoder.
 */
const SHARP_FORMAT_TO_ENCODER: Readonly<Record<string, string>> = {
  png: 'png',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  heif: 'avif',
  avif: 'avif',
}

/** Formats sharp may report that we accept (the static-image allowlist). */
const ALLOWED_FORMATS: ReadonlySet<string> = new Set(Object.keys(SHARP_FORMAT_TO_MIME))

// sharp's own pixel-limit guard throws "Input image exceeds pixel limit" when the decoded
// pixel count (width × stackedHeight for animations) exceeds sharp's internal limit
// (default ~268M). That fires BEFORE our maxPixels check can read metadata for images
// above the sharp limit (e.g. a 2-frame 12000×12000 GIF = 288M pixels), so without this
// mapping such a pixel bomb would fall to decode-failed → 415. A pixel bomb is a size
// rejection, not a decode failure → mapped to too-large → 413. (If maxPixels is env-
// raised above sharp's limit, the toBuffer catch below re-maps the same throw too.)
const PIXEL_LIMIT_RE = /exceeds pixel limit/i
const isSharpPixelLimitError = (error: unknown): boolean =>
  error instanceof Error && PIXEL_LIMIT_RE.test(error.message)

export type CanonicalizeOutcome =
  | {
      kind: 'ok'
      canonicalBytes: Buffer
      mimeType: string
      /** Per-frame (single page) width/height. */
      width: number
      height: number
      /** Frame count (1 for static, N for animated). */
      pages: number
    }
  | { kind: 'unsupported'; reason: 'decode-failed' | 'format-not-allowed' | 'no-dimensions' }
  | { kind: 'too-large'; reason: 'dimensions' | 'pixels'; width?: number; height?: number }

export type CanonicalizeLimits = {
  /** Max per-frame width OR height (decode-bomb guard). */
  maxDimension: number
  /** Max total decoded pixel count across all frames (memory guard). */
  maxPixels: number
}

/**
 * Decode `bytes` via sharp, enforce the static-image allowlist + decode-bomb limits,
 * and re-encode to canonical bytes in the decoded format. The canonical bytes are
 * what the store persists; assetId = sha256(canonical bytes).
 *
 * - decode failure (truncated / polyglot / corrupt / non-image) → unsupported/decode-failed.
 * - a format outside the allowlist → unsupported/format-not-allowed.
 * - missing dimensions → unsupported/no-dimensions.
 * - per-frame dimension or total pixel count over the limit → too-large.
 * - success → { canonicalBytes, mimeType, width, height, pages }.
 */
export const canonicalizeImage = async (
  bytes: Buffer,
  limits: CanonicalizeLimits,
): Promise<CanonicalizeOutcome> => {
  // Read with animated:true so multi-frame GIF/WebP/AVIF load ALL frames. Without it,
  // sharp reads only the first page and the subsequent re-encode collapses the
  // animation to a single frame (verified empirically). A pixel-limit throw (image
  // above sharp's internal ~268M-pixel limit) is mapped to too-large (413), NOT
  // decode-failed (415) — a pixel bomb is a size rejection, not a decode failure.
  let pixelLimitHit = false
  const metaResult = await (async () => {
    try {
      return await sharp(bytes, { animated: true }).metadata()
    } catch (error) {
      if (isSharpPixelLimitError(error)) pixelLimitHit = true
      return null
    }
  })()
  if (pixelLimitHit) {
    // sharp refused before returning metadata → dimensions unavailable. The rejection
    // is unambiguously "too many pixels" (sharp's own guard), so this is 413 not 415.
    return { kind: 'too-large', reason: 'pixels' }
  }
  if (!metaResult) {
    return { kind: 'unsupported', reason: 'decode-failed' }
  }
  const meta = metaResult

  const fmt = meta.format
  if (!fmt || !ALLOWED_FORMATS.has(fmt)) {
    return { kind: 'unsupported', reason: 'format-not-allowed' }
  }

  const width = meta.width ?? 0
  // pageHeight is the per-frame height for animated images; for static images it is
  // undefined and meta.height IS the (single) image height. Either way this is the
  // per-frame dimension we bound against maxDimension.
  const pageHeight = meta.pageHeight ?? meta.height ?? 0
  if (width <= 0 || pageHeight <= 0) {
    return { kind: 'unsupported', reason: 'no-dimensions' }
  }
  if (width > limits.maxDimension || pageHeight > limits.maxDimension) {
    return { kind: 'too-large', reason: 'dimensions', width, height: pageHeight }
  }

  // With animated:true, meta.height is the STACKED total (pages * pageHeight); for
  // static images it is the image height. Either way width * height = total decoded
  // pixels across all frames — the memory bound we cap with maxPixels.
  const stackedHeight = meta.height ?? pageHeight
  const totalPixels = width * stackedHeight
  const pages = meta.pages && meta.pages > 1 ? meta.pages : 1
  if (totalPixels > limits.maxPixels) {
    return { kind: 'too-large', reason: 'pixels', width, height: stackedHeight }
  }

  const encoder = SHARP_FORMAT_TO_ENCODER[fmt]
  const mimeType = SHARP_FORMAT_TO_MIME[fmt]
  try {
    // Re-encode in the decoded format. animated:true on the pipeline preserves frames
    // for GIF/WebP/AVIF animations (a decoded-but-trailing payload is dropped here —
    // sharp only re-encodes the decoded image, not trailing bytes).
    const canonicalBytes = await sharp(bytes, { animated: true })
      .toFormat(encoder as 'png' | 'jpeg' | 'webp' | 'gif' | 'avif')
      .toBuffer()
    return { kind: 'ok', canonicalBytes, mimeType, width, height: pageHeight, pages }
  } catch (error) {
    // Defensive: if maxPixels was env-raised above sharp's limit, a >sharp-limit image
    // could reach toBuffer and hit the same pixel-limit throw — map it to too-large.
    if (isSharpPixelLimitError(error)) {
      return { kind: 'too-large', reason: 'pixels', width, height: pageHeight }
    }
    return { kind: 'unsupported', reason: 'decode-failed' }
  }
}
