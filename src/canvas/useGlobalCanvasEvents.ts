import { useEffect, useRef } from 'react'
import type { RuntimeCanvasTool } from './canvasInteraction'
import type { SnapGuide } from './canvasGeometry'
import { hasActiveTextSelection, isEditingTarget } from './canvasInteraction'
import { toolForKeyboardShortcut } from './canvasToolRegistry'
import { importImageFileToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'
import { wrapMutation } from './actions/canvasSyncRuntime'

export type GlobalEventsApi = {
  maskEditNodeId: string | undefined
  onCancelMaskEdit: (() => void) | undefined
  onCloseContextMenu: () => void
  setTemporaryTool: (tool: RuntimeCanvasTool | undefined) => void
  setEditingTextNodeId: (id: string | undefined) => void
  setSnapGuides: (guides: SnapGuide[]) => void
  setActiveConnectorDropTargetId: (id: string | undefined) => void
  setZoomOutCursor: (active: boolean) => void
  zoomBy: (factor: number, center?: { clientX: number; clientY: number }) => void
  zoomTo: (scale: number, center?: { clientX: number; clientY: number }) => void
  fitAll: () => void
  fitSelection: () => void
  viewportCenter: () => { x: number; y: number }
  resetMarquee: () => void
  resetNodeTransform: () => void
  resetPan: () => void
  resetTextAnnotation: () => void
  resetBrushStamp: () => void
  resetGroupTransform: () => void
  resetZoomGesture: () => void
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
    setZoomOutCursor,
    zoomBy,
    zoomTo,
    fitAll,
    fitSelection,
    viewportCenter,
    resetMarquee,
    resetNodeTransform,
    resetPan,
    resetTextAnnotation,
    resetBrushStamp,
    resetGroupTransform,
    resetZoomGesture,
  } = api
  const pressedTemporaryToolsRef = useRef<RuntimeCanvasTool[]>([])

  useEffect(() => {
    const pressTemporaryTool = (tool: RuntimeCanvasTool) => {
      const pressedTools = pressedTemporaryToolsRef.current.filter((item) => item !== tool)
      pressedTools.push(tool)
      pressedTemporaryToolsRef.current = pressedTools
      setTemporaryTool(tool)
    }

    const releaseTemporaryTool = (tool: RuntimeCanvasTool) => {
      const pressedTools = pressedTemporaryToolsRef.current.filter((item) => item !== tool)
      pressedTemporaryToolsRef.current = pressedTools
      setTemporaryTool(pressedTools.at(-1))
    }

    const resetTemporaryTools = () => {
      pressedTemporaryToolsRef.current = []
      setTemporaryTool(undefined)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditingTarget(event.target)) return

      const store = useCanvasStore.getState()
      const modifier = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      setZoomOutCursor(event.altKey || event.key === 'Alt')

      if (event.code === 'Space') {
        event.preventDefault()
        if (!event.repeat) pressTemporaryTool('hand')
        return
      }

      if (event.code === 'KeyZ' && !modifier && !event.repeat) {
        event.preventDefault()
        pressTemporaryTool('zoom')
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
        resetZoomGesture()
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
        zoomTo(1)
        return
      }

      if (!modifier && !event.altKey && (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd')) {
        event.preventDefault()
        zoomBy(1.12)
        return
      }

      if (!modifier && !event.altKey && (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract')) {
        event.preventDefault()
        zoomBy(1 / 1.12)
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
        // 有活动文字选区(chat 气泡等)→ 放行系统复制;preventDefault 会吞掉它。
        if (hasActiveTextSelection()) return
        event.preventDefault()
        store.copySelectedNodes()
        return
      }

      if (modifier && key === 'x') {
        if (hasActiveTextSelection()) return
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
        wrapMutation(store.duplicateSelectedNodes)()
        return
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        wrapMutation(store.deleteSelectedNodes)()
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
      setZoomOutCursor(event.altKey && event.key !== 'Alt')

      if (event.code === 'Space') {
        event.preventDefault()
        releaseTemporaryTool('hand')
      }

      if (event.code === 'KeyZ') {
        event.preventDefault()
        releaseTemporaryTool('zoom')
      }
    }

    const handleWindowBlur = () => {
      resetTemporaryTools()
      setZoomOutCursor(false)
      resetPan()
      resetMarquee()
      resetNodeTransform()
      resetGroupTransform()
      resetTextAnnotation()
      resetBrushStamp()
      resetZoomGesture()
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
        wrapMutation(() => store.pasteClipboardNodes())()
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
    resetZoomGesture,
    setActiveConnectorDropTargetId,
    setEditingTextNodeId,
    setSnapGuides,
    setTemporaryTool,
    setZoomOutCursor,
    viewportCenter,
    zoomBy,
    zoomTo,
  ])
}
