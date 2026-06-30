import './App.css'
import { useCallback } from 'react'
import { useEffect } from 'react'
import { useRef } from 'react'
import { useState } from 'react'
import { AIToolPanel } from './app/AIToolPanel'
import { LibraryWorkspace } from './app/LibraryWorkspace'
import { MivoCanvas } from './canvas/MivoCanvas'
import { InspectorPanel } from './app/InspectorPanel'
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
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('canvas')
  const [detailsSceneId, setDetailsSceneId] = useState<string>()
  const projectSidebarTimerRef = useRef<number | undefined>(undefined)
  const detailsOpen = workspaceView === 'canvas' && detailsSceneId === sceneId
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
        workspaceView === 'canvas' ? '' : 'library-active'
      } ${
        aiPanelOpen ? '' : 'ai-collapsed'
      }`}
    >
      <ProjectSidebar
        activeView={workspaceView}
        open={projectSidebarOpen}
        peeking={projectSidebarPeek}
        closing={projectSidebarClosing}
        onOpenAssets={() => setWorkspaceView('assets')}
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
      {workspaceView === 'canvas' ? (
        <div className="workspace">
          <TopBar projectSidebarOpen={projectSidebarOpen} />
          <div className="work-surface">
            <MivoCanvas key={sceneId} onOpenDetails={() => setDetailsSceneId(sceneId)} />
            <AIToolPanel open={aiPanelOpen} onToggle={() => setAiPanelOpen((current) => !current)} />
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
