import { Fragment, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bug,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
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
  X,
} from 'lucide-react'
import { scenes, useCanvasStore } from '../store/canvasStore'
import { debugLogger, useDebugLogStore, type DebugLogEntry, type DebugLogLevel } from '../store/debugLogStore'
import { toastFeedback } from '../store/toastStore'
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

const settingsMenuItems = [
  {
    id: 'preferences',
    label: 'Preferences',
    meta: undefined,
    Icon: SlidersHorizontal,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    meta: 'System',
    Icon: Palette,
  },
  {
    id: 'keyboard-shortcuts',
    label: 'Keyboard shortcuts',
    meta: undefined,
    Icon: Keyboard,
  },
  {
    id: 'theme',
    label: 'Theme',
    meta: 'Auto',
    Icon: Moon,
  },
  {
    id: 'help-feedback',
    label: 'Help and feedback',
    meta: undefined,
    Icon: CircleHelp,
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
  const debugEntries = useDebugLogStore((state) => state.entries)
  const clearDebugLog = useDebugLogStore((state) => state.clear)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [debugLogOpen, setDebugLogOpen] = useState(false)
  const [debugLogFilter, setDebugLogFilter] = useState<DebugLogLevel | 'all'>('all')
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

  const handleSettingsMenuItem = (label: string) => {
    debugLogger.warn('Settings', `${label} is not implemented yet`)
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
  const visibleDebugEntries =
    debugLogFilter === 'all' ? debugEntries : debugEntries.filter((entry) => entry.level === debugLogFilter)
  const debugLogCounts = {
    all: debugEntries.length,
    log: debugEntries.filter((entry) => entry.level === 'log').length,
    warning: debugEntries.filter((entry) => entry.level === 'warning').length,
    error: debugEntries.filter((entry) => entry.level === 'error').length,
  }
  const formatDebugTime = (timestamp: number) =>
    new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestamp))
  const formatDebugEntryForClipboard = (entry: DebugLogEntry) =>
    `[${entry.level.toUpperCase()}] ${formatDebugTime(entry.timestamp)} ${entry.source}\n${entry.message}`
  const copyErrorLogEntry = async (entry: DebugLogEntry) => {
    if (!navigator.clipboard?.writeText) {
      debugLogger.error('Debug Log', 'Clipboard API unavailable while copying error log')
      toastFeedback.error('Clipboard is unavailable')
      return
    }

    try {
      await navigator.clipboard.writeText(formatDebugEntryForClipboard(entry))
      toastFeedback.success('Error log copied')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLogger.error('Debug Log', `Failed to copy error log: ${message}`)
      toastFeedback.error('Failed to copy error log')
    }
  }

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
        <div className="debug-log-area">
          {debugLogOpen
            ? createPortal(
                <div
                  className="debug-log-backdrop"
                  role="presentation"
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) {
                      setDebugLogOpen(false)
                    }
                  }}
                >
                  <section className="debug-log-panel" role="dialog" aria-modal="true" aria-label="Debug log console">
                    <header className="debug-log-header">
                      <div>
                        <strong>Debug Log</strong>
                        <span>Runtime console</span>
                      </div>
                      <button type="button" aria-label="Close debug log" onClick={() => setDebugLogOpen(false)}>
                        <X size={16} />
                      </button>
                    </header>
                    <div className="debug-log-toolbar" role="toolbar" aria-label="Debug log filters">
                      {[
                        { id: 'all' as const, label: 'All', count: debugLogCounts.all },
                        { id: 'log' as const, label: 'Log', count: debugLogCounts.log },
                        { id: 'warning' as const, label: 'Warning', count: debugLogCounts.warning },
                        { id: 'error' as const, label: 'Error', count: debugLogCounts.error },
                      ].map((filter) => (
                        <button
                          key={filter.id}
                          type="button"
                          className={debugLogFilter === filter.id ? 'active' : ''}
                          onClick={() => setDebugLogFilter(filter.id)}
                        >
                          {filter.label} {filter.count}
                        </button>
                      ))}
                      <button type="button" className="debug-log-clear" aria-label="Clear debug log" onClick={clearDebugLog}>
                        Clear
                      </button>
                    </div>
                    <ol className="debug-log-list" aria-label="Recent debug events">
                      {visibleDebugEntries.length ? (
                        visibleDebugEntries.map((entry) => (
                          <li key={entry.id} className={`debug-log-entry ${entry.level}`}>
                            <span className="debug-log-level">{entry.level === 'warning' ? 'Warn' : entry.level}</span>
                            <time>{formatDebugTime(entry.timestamp)}</time>
                            <span className="debug-log-source">{entry.source}</span>
                            <span className="debug-log-message">{entry.message}</span>
                            {entry.level === 'error' ? (
                              <button
                                type="button"
                                className="debug-log-copy"
                                aria-label="Copy error log content"
                                title="Copy error log content"
                                onClick={() => void copyErrorLogEntry(entry)}
                              >
                                <Copy size={14} />
                              </button>
                            ) : null}
                          </li>
                        ))
                      ) : (
                        <li className="debug-log-empty">No debug entries</li>
                      )}
                    </ol>
                  </section>
                </div>,
                document.body,
              )
            : null}
          <button
            type="button"
            className="debug-log-row"
            aria-label="Debug Log"
            onClick={() => setDebugLogOpen(true)}
          >
            <Bug size={17} />
            <span>Debug Log</span>
            <span className="debug-log-badges" aria-hidden="true">
              {debugLogCounts.warning ? <span className="debug-log-badge warning">{debugLogCounts.warning}</span> : null}
              {debugLogCounts.error ? <span className="debug-log-badge error">{debugLogCounts.error}</span> : null}
            </span>
          </button>
        </div>
        {settingsOpen ? (
          <div className="settings-menu" role="menu" aria-label="Settings menu">
            {settingsMenuItems.map(({ id, label, meta, Icon }, index) => (
              <Fragment key={id}>
                {index === settingsMenuItems.length - 1 ? <span className="settings-menu-separator" /> : null}
                <button type="button" role="menuitem" onClick={() => handleSettingsMenuItem(label)}>
                  <Icon size={15} />
                  <span>{label}</span>
                  {meta ? <em>{meta}</em> : null}
                </button>
              </Fragment>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="settings-row"
          aria-label="Settings"
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
