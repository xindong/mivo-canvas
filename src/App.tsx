import './App.css'
import { useCallback, type DragEvent as ReactDragEvent } from 'react'
import { useEffect } from 'react'
import { useRef } from 'react'
import { useState } from 'react'
import { AIToolPanel } from './app/AIToolPanel'
import { LibraryWorkspace } from './app/LibraryWorkspace'
import { MivoCanvas, type ExternalAssetDropHandler } from './canvas/MivoCanvas'
import { InspectorPanel } from './app/InspectorPanel'
import { canReadLocalAssetDrag } from './lib/canvasAssetDrag'
import { ProjectSidebar } from './app/ProjectSidebar'
import { ProjectSidebarControls } from './app/ProjectSidebarControls'
import { TaskQueue } from './app/TaskQueue'
import { TopBar } from './app/TopBar'
import { useCanvasStore } from './store/canvasStore'
import type { WorkspaceView } from './app/ProjectSidebar'

const SIDEBAR_PINNING_MS = 300
const SIDEBAR_CLOSE_MS = 280
const SIDEBAR_PEEK_CLOSE_MS = 220

type ProjectSidebarState = 'open' | 'closed' | 'closing' | 'peeking' | 'peekClosing' | 'pinning'

function App() {
  const sceneId = useCanvasStore((state) => state.sceneId)
  const [projectSidebarState, setProjectSidebarState] = useState<ProjectSidebarState>('open')
  const [projectSidebarHoverLocked, setProjectSidebarHoverLocked] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(true)
  const [aiPanelFocusRequestId, setAiPanelFocusRequestId] = useState(0)
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('canvas')
  const [detailsSceneId, setDetailsSceneId] = useState<string>()
  const [maskCancelRequestId, setMaskCancelRequestId] = useState(0)
  const projectSidebarTimerRef = useRef<number | undefined>(undefined)
  const externalAssetDropRef = useRef<ExternalAssetDropHandler | undefined>(undefined)
  const isCanvasWorkspace = workspaceView === 'canvas' || workspaceView === 'assets'
  const detailsOpen = isCanvasWorkspace && detailsSceneId === sceneId
  const projectSidebarOpen = projectSidebarState === 'open' || projectSidebarState === 'pinning'
  const projectSidebarPeek = projectSidebarState === 'peeking' || projectSidebarState === 'peekClosing'
  const projectSidebarClosing = projectSidebarState === 'closing' || projectSidebarState === 'peekClosing'
  const projectSidebarPinning = projectSidebarState === 'pinning'

  const clearProjectSidebarTimer = useCallback(() => {
    if (projectSidebarTimerRef.current) {
      window.clearTimeout(projectSidebarTimerRef.current)
      projectSidebarTimerRef.current = undefined
    }
  }, [])

  const openGeneratePanel = useCallback(() => {
    setWorkspaceView('canvas')
    setAiPanelOpen(true)
    setAiPanelFocusRequestId((id) => id + 1)
  }, [])

  const openAssetsWorkspace = useCallback(() => {
    setMaskCancelRequestId((id) => id + 1)
    setAiPanelOpen(false)
    setWorkspaceView('assets')
  }, [])

  const registerExternalAssetDrop = useCallback((handler?: ExternalAssetDropHandler) => {
    externalAssetDropRef.current = handler
  }, [])

  const handleAssetDrawerDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!canReadLocalAssetDrag(event.dataTransfer)) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleAssetDrawerDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!canReadLocalAssetDrag(event.dataTransfer)) return

    event.preventDefault()
    event.stopPropagation()

    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.asset-library-drawer')) return

    if (externalAssetDropRef.current?.(event.dataTransfer, event.clientX, event.clientY)) {
      setWorkspaceView('canvas')
    }
  }, [])

  const openProjectSidebar = useCallback(() => {
    const pinningFromPeek = projectSidebarState === 'peeking' || projectSidebarState === 'peekClosing'

    clearProjectSidebarTimer()
    setProjectSidebarHoverLocked(false)

    if (pinningFromPeek) {
      setProjectSidebarState('pinning')
      projectSidebarTimerRef.current = window.setTimeout(() => {
        setProjectSidebarState('open')
        projectSidebarTimerRef.current = undefined
      }, SIDEBAR_PINNING_MS)
    } else {
      setProjectSidebarState('open')
    }
  }, [clearProjectSidebarTimer, projectSidebarState])

  const closeProjectSidebar = useCallback(() => {
    clearProjectSidebarTimer()
    setProjectSidebarHoverLocked(true)
    setProjectSidebarState('closing')
    projectSidebarTimerRef.current = window.setTimeout(() => {
      setProjectSidebarState('closed')
      projectSidebarTimerRef.current = undefined
    }, SIDEBAR_CLOSE_MS)
  }, [clearProjectSidebarTimer])

  const peekProjectSidebar = useCallback(() => {
    if (projectSidebarHoverLocked) return
    if (projectSidebarState === 'open' || projectSidebarState === 'pinning') return
    if (projectSidebarState === 'peeking') return

    clearProjectSidebarTimer()
    setProjectSidebarState('peeking')
  }, [clearProjectSidebarTimer, projectSidebarHoverLocked, projectSidebarState])

  const closeProjectSidebarPeek = useCallback(() => {
    if (projectSidebarState !== 'peeking') return

    clearProjectSidebarTimer()
    setProjectSidebarState('peekClosing')
    projectSidebarTimerRef.current = window.setTimeout(() => {
      setProjectSidebarState('closed')
      projectSidebarTimerRef.current = undefined
    }, SIDEBAR_PEEK_CLOSE_MS)
  }, [clearProjectSidebarTimer, projectSidebarState])

  useEffect(() => () => clearProjectSidebarTimer(), [clearProjectSidebarTimer])

  useEffect(() => {
    if (projectSidebarState !== 'peeking') return

    const closeWhenPointerLeavesDrawer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null

      if (
        target?.closest('.project-sidebar.drawer') ||
        target?.closest('[data-project-sidebar-trigger="true"]')
      ) {
        return
      }

      closeProjectSidebarPeek()
    }

    window.addEventListener('pointermove', closeWhenPointerLeavesDrawer, { passive: true })

    return () => {
      window.removeEventListener('pointermove', closeWhenPointerLeavesDrawer)
    }
  }, [closeProjectSidebarPeek, projectSidebarState])

  return (
    <main
      className={`mivo-app ${projectSidebarOpen ? '' : 'project-collapsed'} ${
        projectSidebarPeek ? 'project-peeking' : ''
      } ${
        projectSidebarPinning ? 'project-pinning' : ''
      } ${
        isCanvasWorkspace ? '' : 'library-active'
      } ${
        aiPanelOpen ? '' : 'ai-collapsed'
      }`}
    >
      <ProjectSidebar
        activeView={workspaceView}
        open={projectSidebarOpen}
        peeking={projectSidebarPeek}
        closing={projectSidebarClosing}
        onOpenAssets={openAssetsWorkspace}
        onOpenCanvas={() => setWorkspaceView('canvas')}
        onOpenPlugins={() => setWorkspaceView('plugins')}
        onOpenSkills={() => setWorkspaceView('skills')}
        onClose={closeProjectSidebar}
        onPin={openProjectSidebar}
        onPeek={peekProjectSidebar}
        onPeekEnd={closeProjectSidebarPeek}
      />
      {!projectSidebarOpen ? (
        <div className="project-floating-chrome">
          <ProjectSidebarControls
            peekDisabled={projectSidebarHoverLocked}
            onOpenProjectSidebar={openProjectSidebar}
            onPeekProjectSidebar={peekProjectSidebar}
            onPeekEnabled={() => setProjectSidebarHoverLocked(false)}
          />
        </div>
      ) : null}
      {isCanvasWorkspace ? (
        <div className="workspace">
          <TopBar projectSidebarOpen={projectSidebarOpen} />
          <div className="work-surface">
            <MivoCanvas
              key={sceneId}
              onOpenDetails={() => setDetailsSceneId(sceneId)}
              onOpenGeneratePanel={openGeneratePanel}
              onRegisterExternalAssetDrop={registerExternalAssetDrop}
              maskCancelRequestId={maskCancelRequestId}
            />
            <AIToolPanel
              open={aiPanelOpen}
              onToggle={() => setAiPanelOpen((current) => !current)}
              focusRequestId={aiPanelFocusRequestId}
            />
            {workspaceView === 'assets' ? (
              <div
                className="asset-library-drawer-backdrop"
                data-canvas-ui="true"
                role="presentation"
                onDragOver={handleAssetDrawerDragOver}
                onDrop={handleAssetDrawerDrop}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) setWorkspaceView('canvas')
                }}
              >
                <LibraryWorkspace
                  type="assets"
                  variant="canvas-drawer"
                  onOpenCanvas={() => setWorkspaceView('canvas')}
                />
              </div>
            ) : null}
          </div>
          <TaskQueue />
        </div>
      ) : (
        <div className="workspace library-mode">
          <LibraryWorkspace type={workspaceView} onOpenCanvas={() => setWorkspaceView('canvas')} />
        </div>
      )}
      {detailsOpen ? (
        <div
          className="details-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setDetailsSceneId(undefined)
            }
          }}
        >
          <div className="details-dialog" role="dialog" aria-modal="true" aria-label="Asset details">
            <InspectorPanel onClose={() => setDetailsSceneId(undefined)} />
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
