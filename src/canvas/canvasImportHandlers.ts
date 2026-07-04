import { useCallback } from 'react'
import { debugLogger } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'

// C02: shared error sink for fire-and-forget asset imports. Without this the
// downstream reject becomes an unhandled rejection with zero user feedback.
// Extracted to a module so MivoCanvas.tsx (structure-guarded) doesn't grow.
export const handleImportError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  debugLogger.error('Canvas Import', `Asset import failed: ${message}`)
  toastFeedback.error(`素材导入失败：${message}`)
}

// C01: stable callback so memo(CanvasNodeView) doesn't break on every render.
// Previously an inline closure in the node map → new ref each render → 全量击穿 memo.
// Extracted to a hook so MivoCanvas.tsx (structure-guarded) doesn't grow.
export const useOpenNodeDetails = (
  setContextMenu: (value: null) => void,
  selectNode: (nodeId: string) => void,
  onOpenDetails?: () => void,
) =>
  useCallback(
    (nodeId: string) => {
      setContextMenu(null)
      selectNode(nodeId)
      onOpenDetails?.()
    },
    [setContextMenu, selectNode, onOpenDetails],
  )
