// Re-export shim — the implementation moved to src/model/brushGeometry.ts
// (D-3: break canvasDocumentModel → canvas-UI value-import cycle). This file
// keeps the historical import path stable so existing src/canvas consumers and
// tests resolve unchanged. Prefer importing from src/model directly for new code.
export * from '../model/brushGeometry'
