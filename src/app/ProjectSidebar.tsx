import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Folder,
  FolderOpen,
  Image,
  Keyboard,
  Moon,
  MonitorUp,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Plug,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { scenes, useCanvasStore } from '../store/canvasStore'
import type { CanvasId } from '../types/mivoCanvas'

export type WorkspaceView = 'canvas' | 'assets' | 'plugins' | 'skills'

type ProjectSidebarProps = {
  activeView: WorkspaceView
  open: boolean
  peeking: boolean
  closing: boolean
  onOpenAssets: () => void
  onOpenCanvas: (canvasId: CanvasId) => void
  onOpenPlugins: () => void
  onOpenSkills: () => void
  onClose: () => void
  onPin: () => void
  onPeek: () => void
  onPeekEnd: () => void
}

type ProjectGroup = {
  id: string
  label: string
  canvasIds: CanvasId[]
}

const sceneOptions = scenes()
const sceneMap = new Map<CanvasId, (typeof sceneOptions)[number]>(
  sceneOptions.map((scene) => [scene.id, scene]),
)

const starterCanvasIds: CanvasId[] = ['task-states', 'empty']

const projectGroups: ProjectGroup[] = [
  {
    id: 'concept-battlepass',
    label: 'Concept Battlepass',
    canvasIds: ['character-flow', 'variants', 'asset-handoff'],
  },
  {
    id: 'product-direction',
    label: '商品图方向',
    canvasIds: ['stress-test'],
  },
]

export function ProjectSidebar({
  activeView,
  open,
  peeking,
  closing,
  onOpenAssets,
  onOpenCanvas,
  onOpenPlugins,
  onOpenSkills,
  onClose,
  onPin,
  onPeek,
  onPeekEnd,
}: ProjectSidebarProps) {
  const sceneId = useCanvasStore((state) => state.sceneId)
  const canvases = useCanvasStore((state) => state.canvases)
  const loadScene = useCanvasStore((state) => state.loadScene)
  const createCanvas = useCanvasStore((state) => state.createCanvas)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    'concept-battlepass': true,
  })

  const openCanvas = (canvasId: CanvasId) => {
    loadScene(canvasId)
    onOpenCanvas(canvasId)
  }

  const createStandaloneCanvas = () => {
    const canvasId = createCanvas('Untitled Canvas')
    onOpenCanvas(canvasId)
  }

  const renderCanvasRow = (canvasId: CanvasId) => {
    const scene = sceneMap.get(canvasId)
    const active = activeView === 'canvas' && sceneId === canvasId

    return (
      <button
        key={canvasId}
        type="button"
        className={active ? 'canvas-row active' : 'canvas-row'}
        onClick={() => openCanvas(canvasId)}
      >
        <MonitorUp size={14} />
        <span>{canvases[canvasId]?.title || scene?.label || canvasId}</span>
        <ChevronRight className="row-hover-arrow" size={14} />
      </button>
    )
  }

  const projectCanvasIds = new Set(projectGroups.flatMap((project) => project.canvasIds))
  const dynamicStandaloneCanvasIds = Object.keys(canvases).filter(
    (canvasId) => !projectCanvasIds.has(canvasId) && !starterCanvasIds.includes(canvasId),
  )
  const standaloneCanvasIds = [...dynamicStandaloneCanvasIds, ...starterCanvasIds]

  if (!open && !peeking && !closing) {
    return null
  }

  const sidebarClassName = [
    'project-sidebar',
    !open && !peeking ? 'closed' : '',
    peeking ? 'drawer' : '',
    peeking && closing ? 'closing' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <aside
      className={sidebarClassName}
      aria-label="Project sidebar"
      aria-hidden={!open && !peeking}
      onMouseEnter={peeking ? onPeek : undefined}
      onMouseLeave={
        peeking
          ? (event) => {
              const nextTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null

              if (nextTarget?.closest('[data-project-sidebar-trigger="true"]')) {
                return
              }

              onPeekEnd()
            }
          : undefined
      }
    >
      <div className="sidebar-header">
        <span className="sidebar-mark" role="img" aria-label="Mivo">
          <span className="mivo-logo" aria-hidden="true" />
        </span>
        <div className="sidebar-nav-controls" aria-label="Sidebar navigation">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={peeking ? onPin : onClose}
            aria-label={peeking ? 'Keep projects open' : 'Collapse projects'}
          >
            {peeking ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
      </div>

      <label className="sidebar-search">
        <Search size={15} />
        <input type="search" placeholder="Search" />
      </label>

      <nav className="sidebar-section primary-actions" aria-label="Workspace navigation">
        <div className={activeView === 'canvas' ? 'nav-row nav-row-composite active' : 'nav-row nav-row-composite'}>
          <button type="button" className="nav-row-main" onClick={() => onOpenCanvas(sceneId)}>
            <MonitorUp size={17} />
            <span>Canvas</span>
          </button>
          <button
            type="button"
            className="nav-row-create"
            aria-label="New canvas"
            title="New canvas"
            onClick={createStandaloneCanvas}
          >
            <Plus size={15} />
          </button>
        </div>
        <button
          type="button"
          className={activeView === 'assets' ? 'nav-row active' : 'nav-row'}
          onClick={onOpenAssets}
        >
          <Image size={17} />
          <span>Assets</span>
        </button>
        <button
          type="button"
          className={activeView === 'plugins' ? 'nav-row active' : 'nav-row'}
          onClick={onOpenPlugins}
        >
          <Plug size={17} />
          <span>Plugins</span>
        </button>
        <button
          type="button"
          className={activeView === 'skills' ? 'nav-row active' : 'nav-row'}
          onClick={onOpenSkills}
        >
          <Sparkles size={17} />
          <span>Skills</span>
        </button>
      </nav>

      <div className="sidebar-scroll">
        <section className="sidebar-section project-tree-section">
          <div className="section-heading">
            <button
              type="button"
              className="tree-heading"
              aria-expanded={projectsOpen}
              onClick={() => setProjectsOpen((current) => !current)}
            >
              <span>Projects</span>
              {projectsOpen ? (
                <ChevronDown className="row-hover-arrow" size={15} />
              ) : (
                <ChevronRight className="row-hover-arrow" size={15} />
              )}
            </button>
            <button type="button" aria-label="New project" title="New project">
              <Plus size={15} />
            </button>
          </div>
          {projectsOpen ? (
            <div className="project-tree" aria-label="Project canvas tree">
              {projectGroups.map((project) => {
                const projectOpen = expandedProjects[project.id]

                return (
                  <div key={project.id} className="project-branch">
                    <button
                      type="button"
                      className="project-row tree-row"
                      aria-expanded={projectOpen}
                      onClick={() =>
                        setExpandedProjects((current) => ({
                          ...current,
                          [project.id]: !current[project.id],
                        }))
                      }
                    >
                      {projectOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                      <span>{project.label}</span>
                      {projectOpen ? (
                        <ChevronDown className="row-hover-arrow" size={14} />
                      ) : (
                        <ChevronRight className="row-hover-arrow" size={14} />
                      )}
                    </button>

                    {projectOpen ? (
                      <div className="canvas-tree project-canvas-tree">{project.canvasIds.map(renderCanvasRow)}</div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}
        </section>

        <section className="sidebar-section project-tree-section">
          <div className="section-heading">
            <span>Canvases</span>
            <button
              type="button"
              aria-label="New standalone canvas"
              title="New standalone canvas"
              onClick={createStandaloneCanvas}
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="canvas-tree standalone-tree" aria-label="Standalone canvases">
            {standaloneCanvasIds.map(renderCanvasRow)}
          </div>
        </section>
      </div>

      <div className={settingsOpen ? 'settings-area open' : 'settings-area'}>
        {settingsOpen ? (
          <div className="settings-menu" role="menu" aria-label="Settings menu">
            <button type="button" role="menuitem">
              <SlidersHorizontal size={15} />
              <span>Preferences</span>
            </button>
            <button type="button" role="menuitem">
              <Palette size={15} />
              <span>Appearance</span>
              <em>System</em>
            </button>
            <button type="button" role="menuitem">
              <Keyboard size={15} />
              <span>Keyboard shortcuts</span>
            </button>
            <button type="button" role="menuitem">
              <Moon size={15} />
              <span>Theme</span>
              <em>Auto</em>
            </button>
            <span className="settings-menu-separator" />
            <button type="button" role="menuitem">
              <CircleHelp size={15} />
              <span>Help and feedback</span>
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="settings-row"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <Settings size={17} />
          <span>Settings</span>
          {settingsOpen ? <ChevronDown size={15} /> : <ChevronUp className="row-hover-arrow" size={15} />}
        </button>
      </div>
    </aside>
  )
}
