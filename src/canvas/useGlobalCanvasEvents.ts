import { useEffect } from 'react'
import type { RuntimeCanvasTool } from './canvasInteraction'
import type { SnapGuide } from './canvasGeometry'
import { isEditingTarget } from './canvasInteraction'
import { toolForKeyboardShortcut } from './canvasToolRegistry'
import { importImageFileToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'

export type GlobalEventsApi = {
  maskEditNodeId: string | undefined
  onCancelMaskEdit: (() => void) | undefined
  onCloseContextMenu: () => void
  setTemporaryTool: (tool: RuntimeCanvasTool | undefined) => void
  setEditingTextNodeId: (id: string | undefined) => void
  setSnapGuides: (guides: SnapGuide[]) => void
  setActiveConnectorDropTargetId: (id: string | undefined) => void
  zoomBy: (factor: number, center?: { clientX: number; clientY: number }) => void
  fitAll: () => void
  fitSelection: () => void
  resetView: () => void
  viewportCenter: () => { x: number; y: number }
  resetMarquee: () => void
  resetNodeTransform: () => void
  resetPan: () => void
  resetTextAnnotation: () => void
  resetBrushStamp: () => void
  resetGroupTransform: () => void
}

// Global window keyboard / wheel / paste / blur handling. Extracted from
// useCanvasInteractionController (F7 global-events gap). Store actions are read
// via getState() inside the handlers (same as the original, which used getState
// for cmd+a / activeTool / brushStyle to avoid re-subscribing on every node
// change). Non-store callbacks arrive via `api`.
export function useGlobalCanvasEvents(api: GlobalEventsApi) {
  const {
    maskEditNodeId,
    onCancelMaskEdit,
    onCloseContextMenu,
    setTemporaryTool,
    setEditingTextNodeId,
    setSnapGuides,
    setActiveConnectorDropTargetId,
    zoomBy,
    fitAll,
    fitSelection,
    resetView,
    viewportCenter,
    resetMarquee,
    resetNodeTransform,
    resetPan,
    resetTextAnnotation,
    resetBrushStamp,
    resetGroupTransform,
  } = api

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditingTarget(event.target)) return

      const store = useCanvasStore.getState()
      const modifier = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (event.code === 'Space') {
        event.preventDefault()
        if (!event.repeat) setTemporaryTool('hand')
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        if (maskEditNodeId) {
          onCancelMaskEdit?.()
          return
        }
        onCloseContextMenu()
        resetMarquee()
        resetNodeTransform()
        resetGroupTransform()
        resetTextAnnotation()
        resetBrushStamp()
        setEditingTextNodeId(undefined)
        setSnapGuides([])
        setActiveConnectorDropTargetId(undefined)
        store.selectNode(undefined)
        if (store.activeTool !== 'select') store.setActiveTool('select')
        return
      }

      if (modifier && (event.key === '=' || event.key === '+' || event.code === 'Equal')) {
        event.preventDefault()
        zoomBy(1.12)
        return
      }

      if (modifier && (event.key === '-' || event.code === 'Minus')) {
        event.preventDefault()
        zoomBy(1 / 1.12)
        return
      }

      if (modifier && event.code === 'Digit0') {
        event.preventDefault()
        resetView()
        return
      }

      if (!modifier && event.shiftKey && event.code === 'Digit1') {
        event.preventDefault()
        fitAll()
        return
      }

      if (!modifier && event.shiftKey && event.code === 'Digit2') {
        event.preventDefault()
        fitSelection()
        return
      }

      if (modifier && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
        return
      }

      if (modifier && key === 'a') {
        event.preventDefault()
        // Read nodes via getState so this effect does not re-subscribe on every node change.
        const allNodes = store.nodes
        store.selectNodes(allNodes.filter((node) => !node.hidden).map((node) => node.id))
        return
      }

      if (modifier && key === 'c') {
        event.preventDefault()
        store.copySelectedNodes()
        return
      }

      if (modifier && key === 'x') {
        event.preventDefault()
        store.cutSelectedNodes()
        return
      }

      if (modifier && key === 'g') {
        event.preventDefault()
        if (event.shiftKey) store.ungroupSelectedNodes()
        else store.groupSelectedNodes()
        return
      }

      if (modifier && key === 'd') {
        event.preventDefault()
        store.duplicateSelectedNodes()
        return
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        store.deleteSelectedNodes()
        return
      }

      if (event.key === '[') {
        event.preventDefault()
        store.moveSelectedLayer(event.shiftKey ? 'back' : 'backward')
        return
      }

      if (event.key === ']') {
        event.preventDefault()
        store.moveSelectedLayer(event.shiftKey ? 'front' : 'forward')
        return
      }

      if (!modifier && key === 'e') {
        event.preventDefault()
        store.setActiveTool('markup-brush')
        if (store.brushStyle.kind !== 'eraser') store.setBrushStyle({ kind: 'eraser' })
        return
      }

      const shortcutTool = modifier ? undefined : toolForKeyboardShortcut(key)
      if (shortcutTool) {
        event.preventDefault()
        store.setActiveTool(shortcutTool)
        if (shortcutTool === 'markup-brush') {
          // P always means "draw": leaving eraser mode goes back to the marker.
          if (store.brushStyle.kind === 'eraser') store.setBrushStyle({ kind: 'marker' })
        }
        return
      }

      const arrowDelta = event.shiftKey ? 10 : 1
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        store.moveSelectedNodesBy(-arrowDelta, 0)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        store.moveSelectedNodesBy(arrowDelta, 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        store.moveSelectedNodesBy(0, -arrowDelta)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        store.moveSelectedNodesBy(0, arrowDelta)
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault()
        setTemporaryTool(undefined)
      }
    }

    const handleWindowBlur = () => {
      setTemporaryTool(undefined)
      resetPan()
      resetMarquee()
      resetNodeTransform()
      resetGroupTransform()
      resetTextAnnotation()
      resetBrushStamp()
      setEditingTextNodeId(undefined)
      setActiveConnectorDropTargetId(undefined)
    }

    const handlePaste = async (event: ClipboardEvent) => {
      if (isEditingTarget(event.target)) return

      const store = useCanvasStore.getState()
      if (store.clipboardAssets.length) {
        event.preventDefault()
        store.pasteClipboardAssets(viewportCenter())
        return
      }

      const items = Array.from(event.clipboardData?.items || [])
      const imageItem = items.find((item) => item.type.startsWith('image/'))

      if (imageItem) {
        const file = imageItem.getAsFile()
        if (!file) return

        event.preventDefault()
        const namedFile = file.name
          ? file
          : new File([file], `clipboard-${Date.now()}.png`, { type: file.type || 'image/png' })
        const center = viewportCenter()
        await importImageFileToCanvas({
          file: namedFile,
          position: center,
          addImportedImage: store.addImportedImage,
        })
        return
      }

      if (store.clipboardNodes.length) {
        event.preventDefault()
        store.pasteClipboardNodes()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('paste', handlePaste)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('paste', handlePaste)
    }
  }, [
    fitAll,
    fitSelection,
    maskEditNodeId,
    onCancelMaskEdit,
    onCloseContextMenu,
    resetBrushStamp,
    resetGroupTransform,
    resetMarquee,
    resetNodeTransform,
    resetPan,
    resetTextAnnotation,
    resetView,
    setActiveConnectorDropTargetId,
    setEditingTextNodeId,
    setSnapGuides,
    setTemporaryTool,
    viewportCenter,
    zoomBy,
  ])
}
