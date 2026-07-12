// Re-export shim — the implementation moved to src/model/nodeCapabilities.ts
// (D-3: break canvasDocumentModel → canvas-UI value-import cycle, moved alongside
// canvasNodeRegistry). This file keeps the historical import path stable so
// existing src/canvas/nodeTypes consumers resolve unchanged. Prefer importing
// from src/model directly for new code.
export * from '../../model/nodeCapabilities'
