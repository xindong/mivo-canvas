import { describe, expect, it, vi } from 'vitest'
import { canvasToolHandlers, type CanvasToolHandlerContext } from './canvasToolHandlers'

const context = (): CanvasToolHandlerContext => ({
  beginPan: vi.fn(),
  beginSelection: vi.fn(),
  beginZoomGesture: vi.fn(),
  beginNodeMove: vi.fn(),
  beginNodeResize: vi.fn(),
  beginTextBox: vi.fn(),
  beginFrameBox: vi.fn(),
  beginMarkupBox: vi.fn(),
  beginStampPlacement: vi.fn(),
  beginTextEdit: vi.fn(() => false),
})

describe('canvasToolHandlers.zoom', () => {
  it('routes canvas and node pointer down through the zoom gesture handler', () => {
    const handlerContext = context()
    const canvasEvent = { button: 0 } as never
    const stopPropagation = vi.fn()
    const nodeEvent = { button: 0, stopPropagation } as never

    canvasToolHandlers.zoom.onCanvasPointerDown(canvasEvent, handlerContext)
    canvasToolHandlers.zoom.onNodePointerDown('node-1', nodeEvent, handlerContext)

    expect(handlerContext.beginZoomGesture).toHaveBeenCalledWith(canvasEvent)
    expect(handlerContext.beginZoomGesture).toHaveBeenCalledWith(nodeEvent)
    expect(handlerContext.beginNodeMove).not.toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
  })
})
