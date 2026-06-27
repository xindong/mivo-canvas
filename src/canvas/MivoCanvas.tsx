import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Leafer } from 'leafer-ui'
import '@leafer-in/view'
import { LocateFixed, Minus, Plus, RotateCcw } from 'lucide-react'
import { downloadCanvasNodeOriginal } from '../lib/assetDownload'
import { saveImportedAsset } from '../lib/assetStorage'
import { importedImageDisplaySize } from '../lib/imageSizing'
import { useCanvasStore } from '../store/canvasStore'
import { CanvasContextMenu } from './CanvasContextMenu'
import { CanvasNodeView } from './CanvasNodeView'
import { CanvasToolDock } from './CanvasToolDock'
import { ImageCropOverlay, type ImageCropBox } from './ImageCropOverlay'
import { NodeActionMenu } from './NodeActionMenu'
import { SelectionQuickToolbar } from './SelectionQuickToolbar'
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
}

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
      '[data-canvas-ui="true"], .canvas-controls, .canvas-tool-dock, .node-context-menu, .empty-canvas-note',
    ),
  )

const isNodeEffectivelyLocked = (nodeId: string, nodes: Array<{ id: string; type: string; sectionId?: string; locked?: boolean; sectionLockMode?: string }>) => {
  const node = nodes.find((item) => item.id === nodeId)
  if (!node) return false

  const section = node.sectionId ? nodes.find((item) => item.id === node.sectionId && item.type === 'frame') : undefined
  return Boolean(node.locked || section?.sectionLockMode === 'all')
}

export function MivoCanvas({ onOpenDetails }: MivoCanvasProps) {
  const shellRef = useRef<HTMLElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const leaferRef = useRef<Leafer | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [cropNodeId, setCropNodeId] = useState<string>()
  const nodes = useCanvasStore((state) => state.nodes)
  const sceneId = useCanvasStore((state) => state.sceneId)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds)
  const selectNode = useCanvasStore((state) => state.selectNode)
  const addTextNode = useCanvasStore((state) => state.addTextNode)
  const addFrameNode = useCanvasStore((state) => state.addFrameNode)
  const addImportedImage = useCanvasStore((state) => state.addImportedImage)
  const cropImageNode = useCanvasStore((state) => state.cropImageNode)
  const renameNode = useCanvasStore((state) => state.renameNode)
  const visibleNodes = useMemo(() => nodes.filter((node) => !node.hidden), [nodes])
  const contextMenuNode =
    contextMenu?.kind === 'node' ? visibleNodes.find((node) => node.id === contextMenu.nodeId) : undefined
  const cropNode = cropNodeId ? visibleNodes.find((node) => node.id === cropNodeId && node.type === 'image') : undefined
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
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
    showGroupSelectionBounds,
    activeSelectionRect,
    activeTextCreationRect,
    activeFrameCreationRect,
    selectionPreviewSet,
    beginGroupResize,
    beginNodePointerDown,
    beginNodeResize,
    editTextNode,
    beginTextResize,
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

  const importImageAt = useCallback(
    (position: { x: number; y: number }) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.multiple = true

      input.onchange = async () => {
        const files = Array.from(input.files || [])

        for (const [index, file] of files.entries()) {
          const asset = await saveImportedAsset(file)
          const displaySize = importedImageDisplaySize(asset.dimensions)
          const offset = index * 28

          addImportedImage(
            asset.assetUrl,
            asset.title,
            asset.size,
            {
              x: position.x - displaySize.width / 2 + offset,
              y: position.y - displaySize.height / 2 + offset,
            },
            asset,
          )
        }
      }

      input.click()
    },
    [addImportedImage],
  )

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
    if (!contextMenu) return

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('.node-context-menu')) return
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
      ref={shellRef}
      onWheel={handleWheel}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerEnd}
      onPointerCancel={handleCanvasPointerEnd}
      onContextMenu={openBlankContextMenu}
      style={{
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        backgroundSize: `${36 * viewport.scale}px ${36 * viewport.scale}px`,
      }}
    >
      <div className="canvas-host" ref={hostRef} />
      <CanvasToolDock previewTool={temporaryTool} />
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
        {visibleNodes.map((node) => {
          const selected = selectedNodeIds.includes(node.id)

          return (
            <CanvasNodeView
              key={node.id}
              node={node}
              selected={selected}
              selectionPreview={selectionPreviewSet.has(node.id)}
              sectionDropTarget={node.id === activeSectionDropTargetId}
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
              onSelect={selectNode}
              onPointerDown={beginNodePointerDown}
              onResizeHandlePointerDown={beginNodeResize}
              onTextResizeHandlePointerDown={beginTextResize}
              onEditText={editTextNode}
              onRenameNode={promptRenameNode}
              onUpdateText={updateEditingText}
              onFinishTextEdit={finishTextEditing}
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
        {!cropNode ? (
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
            onImportImageAt={importImageAt}
          />
        </CanvasContextMenu>
      ) : null}
      {visibleNodes.length === 0 ? (
        <div className="empty-canvas-note">
          <span>空画布</span>
        </div>
      ) : null}
      <div className="canvas-controls" aria-label="Canvas zoom controls">
        <button type="button" onClick={() => zoomBy(1 / 1.12)} aria-label="Zoom out" title="Zoom out">
          <Minus size={16} />
        </button>
        <button
          type="button"
          onClick={selectedNodes.length ? fitSelection : fitAll}
          aria-label={selectedNodes.length ? 'Fit selection' : 'Fit all'}
          title={selectedNodes.length ? 'Fit selection' : 'Fit all'}
        >
          <LocateFixed size={16} />
        </button>
        <button type="button" onClick={resetView} aria-label="Reset view" title="Reset view">
          <RotateCcw size={15} />
        </button>
        <button type="button" onClick={() => zoomBy(1.12)} aria-label="Zoom in" title="Zoom in">
          <Plus size={16} />
        </button>
        <span className="zoom-readout">{Math.round(viewport.scale * 100)}%</span>
      </div>
    </section>
  )
}
