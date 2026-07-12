// Re-export shim — the implementation moved to src/model/canvasNodeRegistry.ts
// (D-3: break canvasDocumentModel → canvas-UI value-import cycle). This file
// keeps the historical import path stable so existing src/canvas/nodeTypes
// consumers and the contract test resolve unchanged. Prefer importing from
// src/model directly for new code.
export * from '../../model/canvasNodeRegistry'
