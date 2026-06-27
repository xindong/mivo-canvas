import { PanelLeftOpen } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'

type ProjectSidebarControlsProps = {
  peekDisabled?: boolean
  onOpenProjectSidebar: () => void
  onPeekProjectSidebar: () => void
  onPeekEnabled?: () => void
}

export function ProjectSidebarControls({
  peekDisabled = false,
  onOpenProjectSidebar,
  onPeekProjectSidebar,
  onPeekEnabled,
}: ProjectSidebarControlsProps) {
  const peekTimerRef = useRef<number | undefined>(undefined)

  const clearPeekTimer = useCallback(() => {
    if (peekTimerRef.current) {
      window.clearTimeout(peekTimerRef.current)
      peekTimerRef.current = undefined
    }
  }, [])

  const scheduleProjectPeek = useCallback(() => {
    if (peekDisabled) return
    if (peekTimerRef.current) return

    peekTimerRef.current = window.setTimeout(() => {
      onPeekProjectSidebar()
      peekTimerRef.current = undefined
    }, 120)
  }, [onPeekProjectSidebar, peekDisabled])

  const openProjectSidebar = () => {
    clearPeekTimer()
    onOpenProjectSidebar()
  }

  useEffect(() => clearPeekTimer, [clearPeekTimer])

  return (
    <nav className="top-navigation" data-project-sidebar-trigger="true" aria-label="Workspace navigation">
      <span className="floating-sidebar-mark" role="img" aria-label="Mivo">
        <span className="mivo-logo" aria-hidden="true" />
      </span>
      <button
        type="button"
        className="top-nav-button round"
        data-project-sidebar-trigger="true"
        onClick={openProjectSidebar}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') {
            scheduleProjectPeek()
          }
        }}
        onMouseEnter={scheduleProjectPeek}
        onMouseMove={scheduleProjectPeek}
        onMouseLeave={() => {
          clearPeekTimer()
          onPeekEnabled?.()
        }}
        aria-label="Open projects"
      >
        <PanelLeftOpen size={19} />
      </button>
    </nav>
  )
}
