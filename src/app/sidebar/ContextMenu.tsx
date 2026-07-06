// ContextMenu — self-researched lightweight right-click menu (Phase 3 / B3·C9).
//
// No Radix. Portal to document.body, fixed-positioned at the cursor, viewport-
// clamped (right/bottom overflow flips). Escape + pointerdown-outside close.
// Submenus open on CLICK (not hover) — v1 accepts the maker-hover-vs-click delta
// as a locked decision (D2/v1 子菜单点击展开). role=menu/menuitem/separator.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { ChevronRight } from 'lucide-react'

export type ContextMenuItem =
  | {
      kind: 'item'
      id: string
      label: string
      icon?: LucideIcon
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'submenu'; id: string; label: string; icon?: LucideIcon; items: ContextMenuItem[] }
  | { kind: 'separator'; id: string }

const MENU_WIDTH = 224
const ITEM_HEIGHT = 32
const MENU_PADDING = 12
// Submenu clamp estimates (kept in sync with .sidebar-context-menu-submenu CSS:
// min-width 168 + margin 4; max-height 240).
const SUBMENU_WIDTH = 172
const SUBMENU_MAX_HEIGHT = 240

export function ContextMenu(props: {
  position: { x: number; y: number }
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const { position, items, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  const [openSubmenu, setOpenSubmenu] = useState<{ id: string; flipX: boolean; flipY: boolean } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [onClose])

  // Viewport clamp: flip right→left and bottom→up when the menu would overflow.
  const style = useMemo(() => {
    const estimatedHeight = items.length * ITEM_HEIGHT + MENU_PADDING
    const x = Math.min(position.x, window.innerWidth - MENU_WIDTH - 8)
    const y = Math.min(position.y, window.innerHeight - estimatedHeight - 8)
    return { left: Math.max(8, x), top: Math.max(8, y) }
  }, [position, items.length])

  const close = () => onClose()

  return createPortal(
    <div className="sidebar-context-menu" ref={ref} style={style} role="menu">
      {items.map((item) => {
        if (item.kind === 'separator') {
          return <div key={item.id} className="sidebar-context-menu-separator" role="separator" />
        }
        if (item.kind === 'submenu') {
          const Icon = item.icon
          const isOpen = openSubmenu?.id === item.id
          const submenuClass = [
            'sidebar-context-menu-submenu',
            openSubmenu?.flipX ? 'is-flip-x' : '',
            openSubmenu?.flipY ? 'is-flip-y' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div key={item.id} className="sidebar-context-menu-submenu-wrap">
              <button
                type="button"
                role="menuitem"
                className={`sidebar-context-menu-item${isOpen ? ' is-open' : ''}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (isOpen) {
                    setOpenSubmenu(null)
                    return
                  }
                  // Viewport-edge handling for the submenu (mirrors the root menu
                  // clamp): flip to the left edge / open upward when the default
                  // right/down placement would overflow.
                  const rect = event.currentTarget.getBoundingClientRect()
                  setOpenSubmenu({
                    id: item.id,
                    flipX: rect.right + SUBMENU_WIDTH > window.innerWidth - 8,
                    flipY: rect.top + SUBMENU_MAX_HEIGHT > window.innerHeight - 8,
                  })
                }}
              >
                <span className="sidebar-context-menu-icon">{Icon ? <Icon size={14} /> : null}</span>
                <span className="sidebar-context-menu-label">{item.label}</span>
                <ChevronRight size={14} className="sidebar-context-menu-chevron" />
              </button>
              {isOpen && (
                <div className={submenuClass} role="menu">
                  {item.items.map((sub) => {
                    if (sub.kind === 'separator') {
                      return <div key={sub.id} className="sidebar-context-menu-separator" role="separator" />
                    }
                    if (sub.kind === 'item') {
                      const SubIcon = sub.icon
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          role="menuitem"
                          className={`sidebar-context-menu-item${sub.danger ? ' is-danger' : ''}`}
                          disabled={sub.disabled}
                          onClick={() => {
                            if (sub.disabled) return
                            sub.onSelect()
                            close()
                          }}
                        >
                          <span className="sidebar-context-menu-icon">{SubIcon ? <SubIcon size={14} /> : null}</span>
                          <span className="sidebar-context-menu-label">{sub.label}</span>
                        </button>
                      )
                    }
                    // Nested submenus are not supported in v1 (single-level click-open).
                    return null
                  })}
                </div>
              )}
            </div>
          )
        }
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`sidebar-context-menu-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              close()
            }}
          >
            <span className="sidebar-context-menu-icon">{Icon ? <Icon size={14} /> : null}</span>
            <span className="sidebar-context-menu-label">{item.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
