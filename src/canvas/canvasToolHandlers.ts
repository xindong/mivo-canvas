import type { PointerEvent as ReactPointerEvent } from 'react'
import type { ResizeCorner } from './canvasGeometry'
import type { RuntimeCanvasTool } from './canvasInteraction'

type CanvasSurfacePointerEvent = ReactPointerEvent<HTMLElement>
type CanvasNodePointerEvent = ReactPointerEvent<HTMLDivElement>
type ResizeHandlePointerEvent = ReactPointerEvent<HTMLButtonElement>

export type CanvasToolHandlerContext = {
  beginPan: (event: CanvasSurfacePointerEvent, options?: { clearSelection?: boolean }) => void
  beginSelection: (event: CanvasSurfacePointerEvent) => void
  beginZoomGesture: (event: CanvasSurfacePointerEvent | CanvasNodePointerEvent | ResizeHandlePointerEvent) => void
  beginNodeMove: (nodeId: string, event: CanvasNodePointerEvent) => void
  beginNodeMoveFromShell: (
    nodeId: string,
    event: CanvasSurfacePointerEvent,
    captureTarget?: HTMLElement | null,
  ) => void
  beginNodeResize: (nodeId: string, corner: ResizeCorner, event: ResizeHandlePointerEvent) => void
  beginTextBox: (event: CanvasSurfacePointerEvent) => void
  beginFrameBox: (event: CanvasSurfacePointerEvent) => void
  beginMarkupBox: (event: CanvasSurfacePointerEvent) => void
  beginStampPlacement: (event: CanvasSurfacePointerEvent) => void
  beginTextEdit: (nodeId: string, event: CanvasSurfacePointerEvent) => boolean
}

export type CanvasToolHandler = {
  id: RuntimeCanvasTool
  onCanvasPointerDown: (event: CanvasSurfacePointerEvent, context: CanvasToolHandlerContext) => void
  onNodePointerDown: (nodeId: string, event: CanvasSurfacePointerEvent, context: CanvasToolHandlerContext) => void
  onResizeHandlePointerDown: (
    nodeId: string,
    corner: ResizeCorner,
    event: ResizeHandlePointerEvent,
    context: CanvasToolHandlerContext,
  ) => void
}

const selectToolHandler: CanvasToolHandler = {
  id: 'select',
  onCanvasPointerDown: (event, context) => {
    if (event.button === 1) {
      context.beginPan(event)
      return
    }

    if (event.button === 0) {
      context.beginSelection(event)
    }
  },
  onNodePointerDown: (nodeId, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    context.beginNodeMoveFromShell(nodeId, event)
  },
  onResizeHandlePointerDown: (nodeId, corner, event, context) => {
    if (event.button !== 0) return

    context.beginNodeResize(nodeId, corner, event)
  },
}

const handToolHandler: CanvasToolHandler = {
  id: 'hand',
  onCanvasPointerDown: (event, context) => {
    if (event.button === 0 || event.button === 1) {
      context.beginPan(event)
    }
  },
  onNodePointerDown: (_nodeId, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    context.beginPan(event)
  },
  onResizeHandlePointerDown: (_nodeId, _corner, event) => {
    event.stopPropagation()
  },
}

const textToolHandler: CanvasToolHandler = {
  id: 'text',
  onCanvasPointerDown: (event, context) => {
    if (event.button !== 0) return

    context.beginTextBox(event)
  },
  onNodePointerDown: (nodeId, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    if (!context.beginTextEdit(nodeId, event)) {
      context.beginNodeMoveFromShell(nodeId, event)
    }
  },
  onResizeHandlePointerDown: (_nodeId, _corner, event) => {
    event.stopPropagation()
  },
}

const frameToolHandler: CanvasToolHandler = {
  id: 'frame',
  onCanvasPointerDown: (event, context) => {
    if (event.button !== 0) return

    context.beginFrameBox(event)
  },
  onNodePointerDown: (nodeId, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    context.beginNodeMoveFromShell(nodeId, event)
  },
  onResizeHandlePointerDown: (_nodeId, _corner, event) => {
    event.stopPropagation()
  },
}

const markupToolHandler: CanvasToolHandler = {
  id: 'markup',
  onCanvasPointerDown: (event, context) => {
    if (event.button !== 0) return

    context.beginMarkupBox(event)
  },
  onNodePointerDown: (_nodeId, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    context.beginMarkupBox(event)
  },
  onResizeHandlePointerDown: (_nodeId, _corner, event) => {
    event.stopPropagation()
  },
}

const stampToolHandler: CanvasToolHandler = {
  id: 'stamp',
  onCanvasPointerDown: (event, context) => {
    if (event.button !== 0) return

    context.beginStampPlacement(event)
  },
  onNodePointerDown: (_nodeId, event, context) => {
    if (event.button !== 0) return

    // FigJam stamps land on top of objects, so node hits stamp instead of moving.
    event.stopPropagation()
    context.beginStampPlacement(event)
  },
  onResizeHandlePointerDown: (_nodeId, _corner, event) => {
    event.stopPropagation()
  },
}

const zoomToolHandler: CanvasToolHandler = {
  id: 'zoom',
  onCanvasPointerDown: (event, context) => {
    if (event.button !== 0) return

    context.beginZoomGesture(event)
  },
  onNodePointerDown: (_nodeId, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    context.beginZoomGesture(event)
  },
  onResizeHandlePointerDown: (_nodeId, _corner, event, context) => {
    if (event.button !== 0) return

    event.stopPropagation()
    context.beginZoomGesture(event)
  },
}

export const canvasToolHandlers: Record<RuntimeCanvasTool, CanvasToolHandler> = {
  select: selectToolHandler,
  hand: handToolHandler,
  text: textToolHandler,
  frame: frameToolHandler,
  markup: markupToolHandler,
  stamp: stampToolHandler,
  zoom: zoomToolHandler,
}
