import { useLayoutEffect, useRef, type ReactNode } from 'react'

type CanvasContextMenuProps = {
  x: number
  y: number
  children: ReactNode
}

const contextMenuMargin = 12
const minimumMenuHeight = 180

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const visualViewportRect = () => {
  const viewport = window.visualViewport

  return {
    left: viewport?.offsetLeft || 0,
    top: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight,
  }
}

const fitMenuToViewport = (element: HTMLDivElement, x: number, y: number) => {
  const viewport = visualViewportRect()
  const menu = element.querySelector<HTMLElement>('.node-action-menu')
  const availableHeight = Math.max(minimumMenuHeight, viewport.height - contextMenuMargin * 2)

  if (menu) {
    menu.style.maxHeight = `${Math.floor(availableHeight)}px`
  }

  const rect = element.getBoundingClientRect()
  const maxLeft = Math.max(viewport.left + contextMenuMargin, viewport.left + viewport.width - rect.width - contextMenuMargin)
  const maxTop = Math.max(viewport.top + contextMenuMargin, viewport.top + viewport.height - rect.height - contextMenuMargin)
  const nextLeft = clamp(x, viewport.left + contextMenuMargin, maxLeft)
  const nextTop = clamp(y, viewport.top + contextMenuMargin, maxTop)

  element.style.left = `${Math.round(nextLeft)}px`
  element.style.top = `${Math.round(nextTop)}px`
}

export function CanvasContextMenu({ x, y, children }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return undefined

    let animationFrame = 0
    const updatePosition = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => fitMenuToViewport(element, x, y))
    }
    const resizeObserver = new ResizeObserver(updatePosition)

    fitMenuToViewport(element, x, y)
    resizeObserver.observe(element)
    const menu = element.querySelector('.node-action-menu')
    if (menu) resizeObserver.observe(menu)

    window.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('scroll', updatePosition)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('scroll', updatePosition)
    }
  }, [x, y])

  return (
    <div
      className="node-context-menu"
      ref={menuRef}
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>
  )
}
