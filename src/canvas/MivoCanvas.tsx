import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Leafer } from 'leafer-ui'
import '@leafer-in/view'
import { LocateFixed, Minus, Plus, RotateCcw } from 'lucide-react'
import { downloadCanvasNodeOriginal } from '../lib/assetDownload'
import { canReadLocalAssetDrag, parseLocalAssetDragPayload } from '../lib/canvasAssetDrag'
import { canImportCanvasFile, importFilesToCanvas, importImageUrlToCanvas } from '../lib/canvasAssetImport'
import { readCanvasImageBlob } from '../lib/canvasImageSource'
import { editMivoImage } from '../lib/mivoImageClient'
import { useCanvasStore } from '../store/canvasStore'
import { useChatStore } from '../store/chatStore'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasNodeView } from './CanvasNodeView'
import { CanvasToolDock } from './CanvasToolDock'
import { ImageCropOverlay, type ImageCropBox } from './ImageCropOverlay'
import { NodeActionMenu } from './NodeActionMenu'
import { SelectionQuickToolbar } from './SelectionQuickToolbar'
import type { ImageMaskSubmitPayload } from './imageMaskGeometry'
import type { MivoImageRatio } from '../types/generation'
import { useCanvasInteractionController } from './useCanvasInteractionController'

type ContextMenuState = {
  kind: 'node' | 'blank'
  nodeId?: string
  x: number
  y: number
  canvasPosition: {
    x: number
    y: number
  }
}

type MivoCanvasProps = {
  onOpenDetails?: () => void
  onOpenGeneratePanel?: () => void
  onRegisterExternalAssetDrop?: (handler?: ExternalAssetDropHandler) => void
  onMaskEditActiveChange?: (active: boolean) => void
  maskCancelRequestId?: number
}

export type ExternalAssetDropHandler = (dataTransfer: DataTransfer, clientX: number, clientY: number) => boolean

const contextMenuWidth = 252
const contextMenuMaxHeight = 620
const contextMenuMargin = 12

const clampContextMenuPosition = (clientX: number, clientY: number, maxHeight = contextMenuMaxHeight) => ({
  x: Math.min(
    Math.max(contextMenuMargin, clientX),
    Math.max(contextMenuMargin, window.innerWidth - contextMenuWidth - contextMenuMargin),
  ),
  y: Math.min(
    Math.max(contextMenuMargin, clientY),
    Math.max(contextMenuMargin, window.innerHeight - maxHeight - contextMenuMargin),
  ),
})

const isCanvasChromeTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  Boolean(
    target.closest(
      '[data-canvas-ui="true"], .canvas-controls, .canvas-tool-dock, .canvas-ai-action-bar, .node-context-menu, .empty-canvas-note',
    ),
  )

const canvasRenderOverscanPx = 520

const supportedMivoRatios: Array<{ id: MivoImageRatio; value: number }> = [
  { id: '1:1', value: 1 },
  { id: '3:2', value: 3 / 2 },
  { id: '2:3', value: 2 / 3 },
  { id: '16:9', value: 16 / 9 },
  { id: '9:16', value: 9 / 16 },
]

const closestMivoRatioForSize = (size: { width: number; height: number }): MivoImageRatio => {
  const ratio = Math.max(1, size.width) / Math.max(1, size.height)
  return supportedMivoRatios.reduce((best, candidate) => (
    Math.abs(Math.log(ratio / candidate.value)) < Math.abs(Math.log(ratio / best.value)) ? candidate : best
  )).id
}

const rectsIntersect = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x + a.width >= b.x && b.x + b.width >= a.x && a.y + a.height >= b.y && b.y + b.height >= a.y

const canImportDataTransfer = (dataTransfer: DataTransfer) =>
  Array.from(dataTransfer.files).some(canImportCanvasFile) ||
  dataTransfer.types.includes('Files') ||
  canReadLocalAssetDrag(dataTransfer)

const isNodeEffectivelyLocked = (nodeId: string, nodes: Array<{ id: string; type: string; sectionId?: string; locked?: boolean; sectionLockMode?: string }>) => {
  const node = nodes.find((item) => item.id === nodeId)
  if (!node) return false

  const section = node.sectionId ? nodes.find((item) => item.id === node.sectionId && item.type === 'frame') : undefined
  return Boolean(node.locked || section?.sectionLockMode === 'all')
}

export function MivoCanvas({
  onOpenDetails,
  onRegisterExternalAssetDrop,
  onMaskEditActiveChange,
  maskCancelRequestId = 0,
}: MivoCanvasProps) {
  const shellRef = useRef<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const leaferRef = useRef<Leafer | null>(null)
  const maskEditAbortRef = useRef<AbortController | null>(null)
  const lastMaskCancelRequestIdRef = useRef(maskCancelRequestId)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [cropNodeId, setCropNodeId] = useState<string>()
  const [maskEditNodeId, setMaskEditNodeId] = useState<string>()
  const [maskEditSubmittingNodeId, setMaskEditSubmittingNodeId] = useState<string>()
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 })
  const nodes = useCanvasStore((state) => state.nodes)
  const sceneId = useCanvasStore((state) => state.sceneId)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds)
  const selectNode = useCanvasStore((state) => state.selectNode)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addFrameNode = useCanvasStore((state) => state.addFrameNode)
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const addImportedFileNode = useCanvasStore((state) => state.addImportedFileNode)
  const updateNodeMeasuredSize = useCanvasStore((state) => state.updateNodeMeasuredSize)
  const cropImageNode = useCanvasStore((state) => state.cropImageNode)
  const renameNode = useCanvasStore((state) => state.renameNode)
  const commitGenerationResult = useCanvasStore((state) => state.commitGenerationResult)
  const contextMenuNodeId = contextMenu?.nodeId
  const visibleNodes = useMemo(() => nodes.filter((node) => !node.hidden), [nodes])
  const contextMenuNode =
    contextMenu?.kind === 'node' ? visibleNodes.find((node) => node.id === contextMenuNodeId) : undefined
  const cropNode = cropNodeId ? visibleNodes.find((node) => node.id === cropNodeId && node.type === 'image') : undefined
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const cancelMaskEdit = useCallback(() => {
    maskEditAbortRef.current?.abort()
    maskEditAbortRef.current = null
    setMaskEditNodeId(undefined)
    setMaskEditSubmittingNodeId(undefined)
  }, [])
  const {
    viewport,
    snapGuides,
    selectionBox,
    isPanning,
    temporaryTool,
    editingTextNodeId,
    interactionMode,
    selectedNodes,
    selectedBounds,
    activeSectionDropTargetId,
    activeConnectorDropTargetId,
    showGroupSelectionBounds,
    activeSelectionRect,
    activeTextCreationRect,
    activeFrameCreationRect,
    activeMarkupCreationRect,
    markupCreationBox,
    selectionPreviewSet,
    beginGroupResize,
    beginNodePointerDown,
    beginNodeResize,
    editTextNode,
    beginTextResize,
    beginMarkupPointMove,
    updateEditingText,
    finishTextEditing,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerEnd,
    handleWheel,
    zoomBy,
    fitAll,
    fitSelection,
    resetView,
  } = useCanvasInteractionController({
    shellRef,
    sceneId,
    nodes: visibleNodes,
    selectedNodeIds,
    maskEditNodeId,
    onCancelMaskEdit: cancelMaskEdit,
    onCloseContextMenu: closeContextMenu,
  })

  const screenToCanvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = shellRef.current?.getBoundingClientRect()

      return {
        x: (clientX - (rect?.left || 0) - viewport.x) / viewport.scale,
        y: (clientY - (rect?.top || 0) - viewport.y) / viewport.scale,
      }
    },
    [viewport.scale, viewport.x, viewport.y],
  )

  const renderedNodes = useMemo(() => {
    if (!shellSize.width || !shellSize.height) return visibleNodes

    const viewportRect = {
      x: (-viewport.x - canvasRenderOverscanPx) / viewport.scale,
      y: (-viewport.y - canvasRenderOverscanPx) / viewport.scale,
      width: (shellSize.width + canvasRenderOverscanPx * 2) / viewport.scale,
      height: (shellSize.height + canvasRenderOverscanPx * 2) / viewport.scale,
    }
    const pinnedNodeIds = new Set(selectedNodeIds)
    if (selectedNodeId) pinnedNodeIds.add(selectedNodeId)
    if (cropNodeId) pinnedNodeIds.add(cropNodeId)
    if (maskEditNodeId) pinnedNodeIds.add(maskEditNodeId)
    if (contextMenuNodeId) pinnedNodeIds.add(contextMenuNodeId)

    return visibleNodes.filter((node) => pinnedNodeIds.has(node.id) || rectsIntersect(node, viewportRect))
  }, [
    contextMenuNodeId,
    cropNodeId,
    maskEditNodeId,
    selectedNodeId,
    selectedNodeIds,
    shellSize.height,
    shellSize.width,
    viewport.scale,
    viewport.x,
    viewport.y,
    visibleNodes,
  ])

  const openNodeContextMenu = useCallback(
    (nodeId: string, clientX: number, clientY: number) => {
      const position = clampContextMenuPosition(clientX, clientY)
      setContextMenu({
        kind: 'node',
        nodeId,
        x: position.x,
        y: position.y,
        canvasPosition: screenToCanvasPoint(clientX, clientY),
      })
    },
    [screenToCanvasPoint],
  )

  const openBlankContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (isCanvasChromeTarget(event.target)) return

      event.preventDefault()
      event.stopPropagation()

      const position = clampContextMenuPosition(event.clientX, event.clientY, 300)
      setContextMenu({
        kind: 'blank',
        x: position.x,
        y: position.y,
        canvasPosition: screenToCanvasPoint(event.clientX, event.clientY),
      })
    },
    [screenToCanvasPoint],
  )

  const beginCropNode = useCallback(
    (nodeId: string) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      if (!node || node.type !== 'image') return

      selectNode(nodeId)
      setContextMenu(null)
      setCropNodeId(nodeId)
    },
    [selectNode],
  )

  const commitCropNode = useCallback(
    (nodeId: string, box: ImageCropBox) => {
      cropImageNode(nodeId, box)
      setCropNodeId(undefined)
    },
    [cropImageNode],
  )

  const beginMaskEdit = useCallback(
    (nodeId: string) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId && item.type === 'image' && !item.hidden)
      if (!node) return

      selectNode(nodeId)
      setContextMenu(null)
      setCropNodeId(undefined)
      setMaskEditNodeId(nodeId)
    },
    [selectNode],
  )

  const submitMaskEdit = useCallback(
    async (nodeId: string, resolvedAssetUrl: string, payload: ImageMaskSubmitPayload) => {
      const source = useCanvasStore.getState().nodes.find((node) => node.id === nodeId && node.type === 'image' && !node.hidden)
      if (!source) throw new Error('Source image not found')

      setMaskEditSubmittingNodeId(nodeId)
      const abortController = new AbortController()
      maskEditAbortRef.current?.abort()
      maskEditAbortRef.current = abortController
      try {
        const image = await readCanvasImageBlob(source, resolvedAssetUrl)
        const response = await editMivoImage({
          image,
          mask: payload.mask,
          prompt: payload.prompt,
          imgRatio: closestMivoRatioForSize(payload.sourceSize),
          quality: 'medium',
          model: 'gpt-image-2',
          signal: abortController.signal,
        })
        const nodeIds = await commitGenerationResult({
          sourceNodeId: source.id,
          resultImages: response.images,
          prompt: payload.prompt,
          model: 'gpt-image-2',
          kind: 'edit',
          maskBounds: payload.maskBounds,
          placement: 'right',
        })
        const sceneId = useCanvasStore.getState().sceneId
        useChatStore.getState().appendNotice({ sceneId, origin: 'mask-edit', nodeIds, prompt: payload.prompt })
        setMaskEditNodeId(undefined)
      } finally {
        if (maskEditAbortRef.current === abortController) {
          maskEditAbortRef.current = null
        }
        setMaskEditSubmittingNodeId(undefined)
      }
    },
    [commitGenerationResult],
  )

  const downloadOriginal = useCallback((node?: typeof contextMenuNode) => {
    if (!node) return

    void downloadCanvasNodeOriginal(node)
  }, [])

  const createTextAt = useCallback(
    (position: { x: number; y: number }) => {
      const id = addTextNode(position)
      editTextNode(id)
    },
    [addTextNode, editTextNode],
  )

  const createFrameAt = useCallback(
    (position: { x: number; y: number }) => {
      addFrameNode(
        {
          x: position.x - 280,
          y: position.y - 160,
        },
        { width: 560, height: 320 },
      )
    },
    [addFrameNode],
  )

  const promptRenameNode = useCallback(
    (nodeId: string) => {
      const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)
      if (!node) return

      const nextTitle = window.prompt(node.type === 'frame' ? 'Rename section' : 'Rename node', node.title)
      if (!nextTitle?.trim()) return

      renameNode(nodeId, nextTitle)
    },
    [renameNode],
  )

  const importAssetAt = useCallback(
    (position: { x: number; y: number }) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*,.md,.markdown,application/pdf,video/*'
      input.multiple = true

      input.onchange = async () => {
        const files = Array.from(input.files || [])
        await importFilesToCanvas(files, position, addImportedFileNode)
      }

      input.click()
    },
    [addImportedFileNode],
  )

  const importLocalAssetAtClientPoint = useCallback(
    (dataTransfer: DataTransfer, clientX: number, clientY: number) => {
      const payload = parseLocalAssetDragPayload(dataTransfer)
      if (!payload) return false

      void importImageUrlToCanvas(payload.url, payload.name, screenToCanvasPoint(clientX, clientY), addImportedImage)
      return true
    },
    [addImportedImage, screenToCanvasPoint],
  )

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!canImportDataTransfer(event.dataTransfer)) return
    if (isCanvasChromeTarget(event.target)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!canImportDataTransfer(event.dataTransfer)) return
      if (isCanvasChromeTarget(event.target)) return

      event.preventDefault()
      event.stopPropagation()

      const position = screenToCanvasPoint(event.clientX, event.clientY)
      const files = Array.from(event.dataTransfer.files)
      if (files.length) {
        void importFilesToCanvas(files, position, addImportedFileNode)
        return
      }

      const payload = parseLocalAssetDragPayload(event.dataTransfer)
      if (payload) void importImageUrlToCanvas(payload.url, payload.name, position, addImportedImage)
    },
    [addImportedFileNode, addImportedImage, screenToCanvasPoint],
  )

  useEffect(() => {
    onRegisterExternalAssetDrop?.(importLocalAssetAtClientPoint)
    return () => onRegisterExternalAssetDrop?.(undefined)
  }, [importLocalAssetAtClientPoint, onRegisterExternalAssetDrop])

  useEffect(() => {
    if (lastMaskCancelRequestIdRef.current === maskCancelRequestId) return
    lastMaskCancelRequestIdRef.current = maskCancelRequestId
    cancelMaskEdit()
  }, [cancelMaskEdit, maskCancelRequestId])

  useEffect(() => {
    const active = Boolean(maskEditNodeId)
    onMaskEditActiveChange?.(active)

    return () => {
      if (active) onMaskEditActiveChange?.(false)
    }
  }, [maskEditNodeId, onMaskEditActiveChange])

  useEffect(() => () => {
    maskEditAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (!hostRef.current || leaferRef.current) return

    const host = hostRef.current
    const size = host.getBoundingClientRect()
    const leafer = new Leafer({
      view: host,
      type: 'design',
      width: Math.max(1, Math.floor(size.width)),
      height: Math.max(1, Math.floor(size.height)),
      fill: 'rgba(246, 243, 235, 0)',
      smooth: true,
    })

    leaferRef.current = leafer
    leafer.start()

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      leafer.resize({
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(height)),
        pixelRatio: window.devicePixelRatio,
      })
    })

    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      leafer.destroy()
      leaferRef.current = null
    }
  }, [])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return undefined

    const updateShellSize = () => {
      const width = shell.clientWidth
      const height = shell.clientHeight
      setShellSize((current) => (current.width === width && current.height === height ? current : { width, height }))
    }
    updateShellSize()

    const resizeObserver = new ResizeObserver(updateShellSize)
    resizeObserver.observe(shell)

    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    if (!contextMenu) return

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('.node-context-menu, .node-action-submenu')) return
      setContextMenu(null)
    }

    window.addEventListener('pointerdown', handleOutsidePointerDown, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', handleOutsidePointerDown, { capture: true })
    }
  }, [contextMenu])

  const handleSize = 14 / viewport.scale
  const handleBorderWidth = 2.5 / viewport.scale
  const selectionStrokeWidth = 2 / viewport.scale

  return (
    <section
      className={`canvas-shell tool-${interactionMode} ${isPanning ? 'is-panning' : ''} ${
        selectionBox ? 'is-selecting' : ''
      } ${selectedNodes.length > 1 ? 'has-multi-selection' : ''}`}
      aria-label="Mivo Canvas"
      data-viewport-scale={viewport.scale}
      data-viewport-x={viewport.x}
      data-viewport-y={viewport.y}
      data-rendered-node-count={renderedNodes.length}
      data-total-node-count={visibleNodes.length}
      ref={shellRef}
      onWheel={handleWheel}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerEnd}
      onPointerCancel={handleCanvasPointerEnd}
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
      onContextMenu={openBlankContextMenu}
      style={{
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        backgroundSize: `${36 * viewport.scale}px ${36 * viewport.scale}px`,
      }}
    >
      <div className="canvas-host" ref={hostRef} />
      <CanvasToolDock previewTool={temporaryTool === 'hand' ? 'hand' : undefined} />
      <div
        className="dom-canvas-layer"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
      >
        {snapGuides.map((guide) => (
          <div
            key={guide.id}
            className={`snap-guide ${guide.orientation}`}
            style={
              guide.orientation === 'vertical'
                ? {
                    left: guide.position,
                    top: guide.start,
                    height: guide.end - guide.start,
                  }
                : {
                    left: guide.start,
                    top: guide.position,
                    width: guide.end - guide.start,
                  }
            }
          />
        ))}
        {activeSelectionRect ? (
          <div
            className="selection-marquee"
            style={{
              left: activeSelectionRect.x,
              top: activeSelectionRect.y,
              width: activeSelectionRect.width,
              height: activeSelectionRect.height,
              borderWidth: selectionStrokeWidth,
            }}
          />
        ) : null}
        {activeTextCreationRect ? (
          <div
            className="text-creation-box"
            style={{
              left: activeTextCreationRect.x,
              top: activeTextCreationRect.y,
              width: Math.max(1, activeTextCreationRect.width),
              height: Math.max(1, activeTextCreationRect.height),
              borderWidth: selectionStrokeWidth,
            }}
          />
        ) : null}
        {activeFrameCreationRect ? (
          <div
            className="frame-creation-box"
            style={{
              left: activeFrameCreationRect.x,
              top: activeFrameCreationRect.y,
              width: Math.max(1, activeFrameCreationRect.width),
              height: Math.max(1, activeFrameCreationRect.height),
              borderWidth: selectionStrokeWidth,
            }}
          />
        ) : null}
        {activeMarkupCreationRect && markupCreationBox ? (
          <div
            className={`markup-creation-box kind-${markupCreationBox.kind}`}
            style={{
              left: activeMarkupCreationRect.x,
              top: activeMarkupCreationRect.y,
              width: Math.max(1, activeMarkupCreationRect.width),
              height: Math.max(1, activeMarkupCreationRect.height),
              borderWidth: selectionStrokeWidth,
            }}
          >
            {markupCreationBox.kind === 'arrow' ||
            markupCreationBox.kind === 'line' ||
            markupCreationBox.kind === 'brush' ? (
              <svg
                viewBox={`0 0 ${Math.max(1, activeMarkupCreationRect.width)} ${Math.max(1, activeMarkupCreationRect.height)}`}
                preserveAspectRatio="none"
              >
                <defs>
                  <marker
                    id="markup-preview-arrow"
                    markerWidth="18"
                    markerHeight="18"
                    refX="15"
                    refY="9"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path
                      d="M 5 3 L 15 9 L 5 15"
                      fill="none"
                      stroke="var(--violet)"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </marker>
                </defs>
                {markupCreationBox.kind === 'brush' ? (
                  <polyline
                    points={markupCreationBox.points
                      .map((point) => `${point.x - activeMarkupCreationRect.x},${point.y - activeMarkupCreationRect.y}`)
                      .join(' ')}
                  />
                ) : (
                  <line
                    className={markupCreationBox.kind === 'arrow' ? 'markup-preview-arrow-line' : undefined}
                    x1={markupCreationBox.startX - activeMarkupCreationRect.x}
                    y1={markupCreationBox.startY - activeMarkupCreationRect.y}
                    x2={markupCreationBox.currentX - activeMarkupCreationRect.x}
                    y2={markupCreationBox.currentY - activeMarkupCreationRect.y}
                    markerEnd={markupCreationBox.kind === 'arrow' ? 'url(#markup-preview-arrow)' : undefined}
                  />
                )}
              </svg>
            ) : null}
          </div>
        ) : null}
        {showGroupSelectionBounds && selectedBounds ? (
          <>
            <div
              className="selection-bounds"
              data-selection-bounds="true"
              style={{
                left: selectedBounds.x,
                top: selectedBounds.y,
                width: selectedBounds.width,
                height: selectedBounds.height,
                borderWidth: selectionStrokeWidth,
              }}
            />
            {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
              <button
                key={corner}
                type="button"
                className={`selection-handle ${corner}`}
                aria-label={`Resize selection ${corner}`}
                style={{
                  left: corner.endsWith('e') ? selectedBounds.x + selectedBounds.width : selectedBounds.x,
                  top: corner.startsWith('s') ? selectedBounds.y + selectedBounds.height : selectedBounds.y,
                  width: handleSize,
                  height: handleSize,
                  borderWidth: handleBorderWidth,
                }}
                onPointerDown={(event) => beginGroupResize(corner, event)}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerEnd}
                onPointerCancel={handleCanvasPointerEnd}
              />
            ))}
          </>
        ) : null}
        {renderedNodes.map((node) => {
          const selected = selectedNodeIds.includes(node.id)

          return (
            <CanvasNodeView
              key={node.id}
              node={node}
              selected={selected}
              selectionPreview={selectionPreviewSet.has(node.id)}
              sectionDropTarget={node.id === activeSectionDropTargetId}
              connectorDropTarget={node.id === activeConnectorDropTargetId}
              editing={editingTextNodeId === node.id}
              primarySelected={
                interactionMode === 'select' &&
                selectedNodeIds.length === 1 &&
                node.id === selectedNodeId &&
                node.id !== cropNodeId
              }
              effectiveLocked={isNodeEffectivelyLocked(node.id, visibleNodes)}
              handleSize={handleSize}
              handleBorderWidth={handleBorderWidth}
              selectionStrokeWidth={selectionStrokeWidth}
              maskEditActive={node.id === maskEditNodeId}
              maskEditSubmitting={node.id === maskEditSubmittingNodeId}
              viewportScale={viewport.scale}
              onSelect={selectNode}
              onPointerDown={beginNodePointerDown}
              onResizeHandlePointerDown={beginNodeResize}
              onMarkupPointPointerDown={beginMarkupPointMove}
              onTextResizeHandlePointerDown={beginTextResize}
              onEditText={editTextNode}
              onRenameNode={promptRenameNode}
              onUpdateText={updateEditingText}
              onFinishTextEdit={finishTextEditing}
              onResizeNodeToContent={updateNodeMeasuredSize}
              onSubmitMaskEdit={submitMaskEdit}
              onCancelMaskEdit={cancelMaskEdit}
              onOpenDetails={(nodeId) => {
                setContextMenu(null)
                selectNode(nodeId)
                onOpenDetails?.()
              }}
              onOpenContextMenu={openNodeContextMenu}
            />
          )
        })}
        {cropNode ? (
          <ImageCropOverlay
            node={cropNode}
            scale={viewport.scale}
            onCommit={(box) => commitCropNode(cropNode.id, box)}
            onCancel={() => setCropNodeId(undefined)}
          />
        ) : null}
        {!cropNode && !maskEditNodeId ? (
          <SelectionQuickToolbar
            selectedNodes={selectedNodes}
            selectedBounds={selectedBounds}
            editingTextNodeId={editingTextNodeId}
            scale={viewport.scale}
            viewportOffset={{ x: viewport.x, y: viewport.y }}
            onOpenDetails={onOpenDetails}
            onFitSelection={fitSelection}
            onEditText={editTextNode}
            onRenameNode={promptRenameNode}
            onCropNode={beginCropNode}
            onStartImageMaskEdit={beginMaskEdit}
            onDownloadOriginal={downloadOriginal}
          />
        ) : null}
      </div>
      {contextMenu && contextMenuNode ? (
        <CanvasContextMenu x={contextMenu.x} y={contextMenu.y}>
          <NodeActionMenu
            node={contextMenuNode}
            canvasPosition={contextMenu.canvasPosition}
            onClose={() => setContextMenu(null)}
            onOpenDetails={() => {
              selectNode(contextMenuNode.id)
              onOpenDetails?.()
            }}
            onFitSelection={fitSelection}
            onEditText={editTextNode}
            onRenameNode={promptRenameNode}
            onCropNode={beginCropNode}
            onStartImageMaskEdit={beginMaskEdit}
            onDownloadOriginal={downloadOriginal}
          />
        </CanvasContextMenu>
      ) : null}
      {contextMenu?.kind === 'blank' ? (
        <CanvasContextMenu x={contextMenu.x} y={contextMenu.y}>
          <NodeActionMenu
            selectedNodes={[]}
            canvasPosition={contextMenu.canvasPosition}
            onClose={() => setContextMenu(null)}
            onFitAll={fitAll}
            onCreateTextAt={createTextAt}
            onCreateFrameAt={createFrameAt}
            onImportAssetAt={importAssetAt}
          />
        </CanvasContextMenu>
      ) : null}
      {visibleNodes.length === 0 ? (
        <div className="empty-canvas-note">
          <span>空画布</span>
        </div>
      ) : null}
      <div className="canvas-controls" aria-label="Canvas zoom controls">
        <button type="button" onClick={() => zoomBy(1 / 1.12)} aria-label="Zoom out" title="Zoom out (⌘-)">
          <Minus size={16} />
        </button>
        <button
          type="button"
          onClick={selectedNodes.length ? fitSelection : fitAll}
          aria-label={selectedNodes.length ? 'Fit selection' : 'Fit all'}
          title={selectedNodes.length ? 'Fit selection (Shift+2)' : 'Fit all (Shift+1)'}
        >
          <LocateFixed size={16} />
        </button>
        <button type="button" onClick={resetView} aria-label="Reset view" title="Reset view (⌘0)">
          <RotateCcw size={15} />
        </button>
        <button type="button" onClick={() => zoomBy(1.12)} aria-label="Zoom in" title="Zoom in (⌘+)">
          <Plus size={16} />
        </button>
        <span className="zoom-readout">{Math.round(viewport.scale * 100)}%</span>
      </div>
    </section>
  )
}
