import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useLeaferSpikeRenderer } from '../render/useLeaferSpikeRenderer'
import { filterDomNodesForLeaferSpike } from '../render/leaferSpikeFilter'
import { LocateFixed, Minus, Plus, RotateCcw } from 'lucide-react'
import { downloadCanvasNodeOriginal } from '../lib/assetDownload'
import { canReadLocalAssetDrag, parseLocalAssetDragPayload } from '../lib/canvasAssetDrag'
import { canImportCanvasFile, importFilesToCanvas, importImageUrlToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'
import { handleImportError, useOpenNodeDetails } from './canvasImportHandlers'
import { brushCursorCssFor } from './brushCursors'
import { brushOutlinePathFor, highlighterOpacity } from './brushGeometry'
import { BrushOptionsBar } from './BrushOptionsBar'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasNodeView } from './CanvasNodeView'
import { CanvasToolDock } from './CanvasToolDock'
import { AnchorOverlay } from './AnchorOverlay'
import { ImageCropOverlay, type ImageCropBox } from './ImageCropOverlay'
import { NodeActionMenu } from './NodeActionMenu'
import { SelectionQuickToolbar } from './SelectionQuickToolbar'
import { StampOptionsBar } from './StampOptionsBar'
import { stampCursorCssFor, stampGrowthSizes, stampSrcFor } from './stampDefs'
import { useCanvasInteractionController } from './useCanvasInteractionController'
import { useMaskPointArmed, type MaskPointArmedInteractionApi } from './useMaskPointArmed'
import { lockedNodeIdSetFor } from './useNodeTransform'
import { rendererMode } from '../render/rendererMode'
import { cullingMode } from '../render/cullingMode'

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

// C05: closed-interval (>=) intersection — culling over-renders to avoid border popping.
// Disambiguates from canvasInteraction.rectsIntersect (open-interval, selection-semantics).
const rectsIntersectInclusive = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x + a.width >= b.x && b.x + b.width >= a.x && a.y + a.height >= b.y && b.y + b.height >= a.y

const canImportDataTransfer = (dataTransfer: DataTransfer) =>
  Array.from(dataTransfer.files).some(canImportCanvasFile) ||
  dataTransfer.types.includes('Files') ||
  canReadLocalAssetDrag(dataTransfer)

export function MivoCanvas({
  onOpenDetails,
  onRegisterExternalAssetDrop,
  onMaskEditActiveChange,
  maskCancelRequestId = 0,
}: MivoCanvasProps) {
  const shellRef = useRef<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const maskPointInteractionRef = useRef<MaskPointArmedInteractionApi>({
    beginNodePointerDown: () => undefined,
    handleCanvasPointerDown: () => undefined,
    temporaryTool: undefined,
    isPanning: false,
  })
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [cropNodeId, setCropNodeId] = useState<string>()
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 })
  const nodes = useCanvasStore((state) => state.nodes)
  const sceneId = useCanvasStore((state) => state.sceneId)
  const storeActiveTool = useCanvasStore((state) => state.activeTool)
  const brushStyle = useCanvasStore((state) => state.brushStyle)
  const activeStampKind = useCanvasStore((state) => state.activeStampKind)
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
  // P2-D2: only mount the AnchorOverlay when at least one anchor exists (cheap
  // boolean selector — stable false when no anchors, so no re-render cost).
  const hasAnchors = useCanvasStore((state) => state.nodes.some((node) => Boolean(node.experimentalAnchors?.length)))
  const contextMenuNodeId = contextMenu?.nodeId
  const visibleNodes = useMemo(() => nodes.filter((node) => !node.hidden), [nodes])
  // C03+C04 (commit #4): O(n) memoized locked-id set replaces the per-rendered-node
  // local find (was O(n²) on renderedNodes). Re-derived only when visibleNodes changes.
  const lockedNodeIds = useMemo(() => lockedNodeIdSetFor(visibleNodes), [visibleNodes])
  const contextMenuNode =
    contextMenu?.kind === 'node' ? visibleNodes.find((node) => node.id === contextMenuNodeId) : undefined
  const cropNode = cropNodeId ? visibleNodes.find((node) => node.id === cropNodeId && node.type === 'image') : undefined
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const clearCropNode = useCallback(() => setCropNodeId(undefined), [])
  const {
    maskArmed,
    maskEditNodeId,
    maskEditSubmittingNodeId,
    initialClientPoint,
    beginMaskEdit,
    submitMaskEdit,
    cancelMaskEdit,
    toggleMaskArmed,
    wrapNodePointerDown,
    wrapCanvasPointerDown,
    handleInitialClientPointHandled,
  } = useMaskPointArmed({
    sceneId,
    maskCancelRequestId,
    onMaskEditActiveChange,
    selectNode,
    closeContextMenu,
    clearCropNode,
    interactionRef: maskPointInteractionRef,
  })
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
    selectionSpacingHandles,
    activeSectionDropTargetId,
    activeConnectorDropTargetId,
    showGroupSelectionBounds,
    activeSelectionRect,
    activeTextCreationRect,
    activeFrameCreationRect,
    activeMarkupCreationRect,
    markupCreationBox,
    stampPlacementPreview,
    selectionPreviewSet,
    beginGroupResize,
    beginSelectionSpacingDrag,
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

  useLayoutEffect(() => {
    maskPointInteractionRef.current = {
      beginNodePointerDown,
      handleCanvasPointerDown,
      temporaryTool,
      isPanning,
    }
  }, [beginNodePointerDown, handleCanvasPointerDown, isPanning, temporaryTool])

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

  const canvasRenderedNodes = useMemo(() => {
    if (cullingMode === 'off' || !shellSize.width || !shellSize.height) {
      return visibleNodes
    }
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

    return visibleNodes.filter((node) => pinnedNodeIds.has(node.id) || rectsIntersectInclusive(node, viewportRect))
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
  const renderedNodes = useMemo(
    () => filterDomNodesForLeaferSpike(canvasRenderedNodes, rendererMode),
    [canvasRenderedNodes],
  )

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

  const handleOpenNodeDetails = useOpenNodeDetails(setContextMenu, selectNode, onOpenDetails)

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
        await importFilesToCanvas(files, position, addImportedFileNode).catch(handleImportError)
      }

      input.click()
    },
    [addImportedFileNode],
  )

  const importLocalAssetAtClientPoint = useCallback(
    (dataTransfer: DataTransfer, clientX: number, clientY: number) => {
      const payload = parseLocalAssetDragPayload(dataTransfer)
      if (!payload) return false

      void importImageUrlToCanvas(payload.url, payload.name, screenToCanvasPoint(clientX, clientY), addImportedImage).catch(handleImportError)
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
        void importFilesToCanvas(files, position, addImportedFileNode).catch(handleImportError)
        return
      }

      const payload = parseLocalAssetDragPayload(event.dataTransfer)
      if (payload) void importImageUrlToCanvas(payload.url, payload.name, position, addImportedImage).catch(handleImportError)
    },
    [addImportedFileNode, addImportedImage, screenToCanvasPoint],
  )

  useEffect(() => {
    onRegisterExternalAssetDrop?.(importLocalAssetAtClientPoint)
    return () => onRegisterExternalAssetDrop?.(undefined)
  }, [importLocalAssetAtClientPoint, onRegisterExternalAssetDrop])

  const leaferSpikeStats = useLeaferSpikeRenderer({ hostRef, viewport, nodes: visibleNodes, rendererMode })

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
  const overlayHandleSize = 14
  const overlayHandleBorderWidth = 2.5
  const overlaySelectionStrokeWidth = 2
  const selectionOverlayBounds = selectedBounds
    ? {
        x: viewport.x + selectedBounds.x * viewport.scale,
        y: viewport.y + selectedBounds.y * viewport.scale,
        width: selectedBounds.width * viewport.scale,
        height: selectedBounds.height * viewport.scale,
      }
    : undefined
  const canvasToOverlayX = (x: number) => viewport.x + x * viewport.scale
  const canvasToOverlayY = (y: number) => viewport.y + y * viewport.scale

  const brushToolActive = storeActiveTool === 'markup-brush' && !temporaryTool && !isPanning
  const stampToolActive = storeActiveTool === 'stamp' && !temporaryTool && !isPanning

  return (
    <section
      className={`canvas-shell tool-${interactionMode} ${isPanning ? 'is-panning' : ''} ${
        selectionBox ? 'is-selecting' : ''
      } ${selectedNodes.length > 1 ? 'has-multi-selection' : ''} ${brushToolActive ? 'brush-tool' : ''} ${
        stampToolActive ? 'stamp-tool' : ''
      } ${maskArmed ? 'mask-armed' : ''}`}
      aria-label="Mivo Canvas" data-renderer-mode={rendererMode} data-culling-mode={cullingMode}
      data-viewport-scale={viewport.scale}
      data-viewport-x={viewport.x}
      data-viewport-y={viewport.y}
      data-rendered-node-count={renderedNodes.length}
      data-total-node-count={visibleNodes.length}
      data-leafer-expected-children={leaferSpikeStats.expectedChildren}
      data-leafer-children={leaferSpikeStats.children}
      data-leafer-pixel-nonempty={leaferSpikeStats.pixelNonEmpty ? 'true' : 'false'}
      data-leafer-pixel-sample-count={leaferSpikeStats.pixelSampleCount}
      data-leafer-sync-version={leaferSpikeStats.syncVersion}
      ref={shellRef}
      onWheel={handleWheel}
      onPointerDown={wrapCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerEnd}
      onPointerCancel={handleCanvasPointerEnd}
      onDragOver={handleCanvasDragOver}
      onDrop={handleCanvasDrop}
      onContextMenu={openBlankContextMenu}
      style={{
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        backgroundSize: `${36 * viewport.scale}px ${36 * viewport.scale}px`,
        ...(brushToolActive
          ? ({ '--brush-cursor': brushCursorCssFor(brushStyle.kind, brushStyle.color) } as CSSProperties)
          : {}),
        ...(stampToolActive
          ? ({ '--stamp-cursor': stampCursorCssFor(activeStampKind) } as CSSProperties)
          : {}),
      }}
    >
      <div className="canvas-host" ref={hostRef} />
      <CanvasToolDock
        previewTool={temporaryTool === 'hand' ? 'hand' : undefined}
        onStartMaskEdit={beginMaskEdit}
        maskArmed={maskArmed}
        onToggleMaskArmed={toggleMaskArmed}
      />
      {storeActiveTool === 'markup-brush' && !temporaryTool ? <BrushOptionsBar /> : null}
      {storeActiveTool === 'stamp' && !temporaryTool ? <StampOptionsBar /> : null}
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
                  <path
                    d={brushOutlinePathFor(
                      markupCreationBox.points.map((point) => ({
                        ...point,
                        x: point.x - activeMarkupCreationRect.x,
                        y: point.y - activeMarkupCreationRect.y,
                      })),
                      brushStyle.width,
                      brushStyle.kind === 'highlighter' ? 'highlighter' : 'marker',
                      { last: false },
                    )}
                    fill={brushStyle.color}
                    fillOpacity={brushStyle.kind === 'highlighter' ? highlighterOpacity : 1}
                    stroke="none"
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
              effectiveLocked={lockedNodeIds.has(node.id)}
              handleSize={handleSize}
              handleBorderWidth={handleBorderWidth}
              selectionStrokeWidth={selectionStrokeWidth}
              maskEditActive={node.id === maskEditNodeId}
              maskEditSubmitting={node.id === maskEditSubmittingNodeId}
              initialMaskClientPoint={initialClientPoint?.nodeId === node.id ? initialClientPoint : undefined}
              viewportScale={viewport.scale}
              onSelect={selectNode}
              onPointerDown={wrapNodePointerDown}
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
              onInitialMaskClientPointHandled={handleInitialClientPointHandled}
              onOpenDetails={handleOpenNodeDetails}
              onOpenContextMenu={openNodeContextMenu}
            />
          )
        })}
        {stampPlacementPreview ? (
          <div
            className="stamp-placement-preview"
            style={{
              left: stampPlacementPreview.x - stampGrowthSizes[stampPlacementPreview.stage] / 2,
              top: stampPlacementPreview.y - stampGrowthSizes[stampPlacementPreview.stage] / 2,
              width: stampGrowthSizes[stampPlacementPreview.stage],
              height: stampGrowthSizes[stampPlacementPreview.stage],
            }}
          >
            <img src={stampSrcFor(activeStampKind)} alt="" draggable={false} />
          </div>
        ) : null}
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
      {showGroupSelectionBounds && selectionOverlayBounds ? (
        <>
          <div
            className="selection-bounds"
            data-selection-bounds="true"
            style={{
              left: selectionOverlayBounds.x,
              top: selectionOverlayBounds.y,
              width: selectionOverlayBounds.width,
              height: selectionOverlayBounds.height,
              borderWidth: overlaySelectionStrokeWidth,
            }}
          />
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <button
              key={corner}
              type="button"
              className={`selection-handle ${corner}`}
              aria-label={`Resize selection ${corner}`}
              style={{
                left: corner.endsWith('e')
                  ? selectionOverlayBounds.x + selectionOverlayBounds.width
                  : selectionOverlayBounds.x,
                top: corner.startsWith('s')
                  ? selectionOverlayBounds.y + selectionOverlayBounds.height
                  : selectionOverlayBounds.y,
                width: overlayHandleSize,
                height: overlayHandleSize,
                borderWidth: overlayHandleBorderWidth,
              }}
              onPointerDown={(event) => beginGroupResize(corner, event)}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerEnd}
              onPointerCancel={handleCanvasPointerEnd}
            />
          ))}
          {selectionSpacingHandles.map((handle) => (
            <button
              key={handle.id}
              type="button"
              className={`selection-spacing-handle ${handle.axis} layout-${handle.layoutKind}`}
              aria-label={`Adjust ${handle.axis} spacing ${handle.label}px`}
              title={`${handle.label}px`}
              data-smart-layout={handle.layoutKind}
              data-smart-spacing={handle.label}
              style={{
                left: canvasToOverlayX(handle.x),
                top: canvasToOverlayY(handle.y),
                width: handle.width * viewport.scale,
                height: handle.height * viewport.scale,
                fontSize: 10,
              }}
              onPointerDown={(event) => beginSelectionSpacingDrag(handle, event)}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerEnd}
              onPointerCancel={handleCanvasPointerEnd}
            >
              <span>{handle.label}</span>
            </button>
          ))}
        </>
      ) : null}
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
          <span>
            <strong>空画布</strong>
            <em>从右侧 AI 对话生成，或把素材拖到这里</em>
          </span>
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
      {/* P2-D2 EXPERIMENTAL — Anchor MVP overlay. Only mounted when at least one
          anchor exists (hasAnchors selector) so unrelated views (assets drawer) pay
          zero overhead. Marks sit above dom-canvas-layer; each is small + positioned
          so canvas events pass through everywhere else. */}
      {hasAnchors ? <AnchorOverlay viewport={viewport} /> : null}
    </section>
  )
}
