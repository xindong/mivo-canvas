import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bug,
  ChevronDown,
  ChevronRight,
  Copy,
  Image,
  MonitorUp,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import { selectHasUnreadChangelog, useChangelogStore } from '../store/changelogStore'
import { debugLogger, useDebugLogStore, type DebugLogEntry, type DebugLogLevel } from '../store/debugLogStore'
import { getRemoteDebugDropCount } from '../store/remoteDebugReporter'
import { toastFeedback } from '../store/toastStore'
import type { CanvasId } from '../types/mivoCanvas'
import { ChangelogPanel } from './ChangelogPanel'
import { UserChip } from './settings/UserChip'
import { buildSidebarModel } from './sidebar/projectSidebarModel'
import { useCollapsedProjects } from './sidebar/useCollapsedProjects'
import { ProjectRow } from './sidebar/ProjectRow'
import { CanvasRow } from './sidebar/CanvasRow'

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
  const projects = useCanvasStore((state) => state.projects)
  const loadScene = useCanvasStore((state) => state.loadScene)
  const createCanvas = useCanvasStore((state) => state.createCanvas)
  const createProject = useCanvasStore((state) => state.createProject)
  const debugEntries = useDebugLogStore((state) => state.entries)
  const clearDebugLog = useDebugLogStore((state) => state.clear)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [changelogOpenedAt, setChangelogOpenedAt] = useState<number | null>(null)
  const [debugLogOpen, setDebugLogOpen] = useState(false)
  const [debugLogFilter, setDebugLogFilter] = useState<DebugLogLevel | 'all'>('all')
  // FX-7 / A6: persisted remote-debug drop count (batches lost after retry exhaustion).
  // Loaded when the Debug Log panel opens so operators can see unrecoverable diagnostic
  // losses during the A3 persist gray observation window without scraping server logs.
  const [remoteDropCount, setRemoteDropCount] = useState<number | null>(null)
  // Track which project is in inline-rename mode. Lifted (not per-ProjectRow) so a
  // freshly-created project can enter rename mode immediately (B7: 段头 + → create
  // → rename).
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const { collapsed, toggle: toggleProjectCollapsed, setCollapsed: setProjectCollapsed } = useCollapsedProjects()
  const hasUnreadChangelog = useChangelogStore(selectHasUnreadChangelog)
  const loadChangelog = useChangelogStore((state) => state.loadChangelog)

  useEffect(() => {
    void loadChangelog()
  }, [loadChangelog])

  // FX-7 / A6: refresh the persisted drop count whenever the Debug Log panel opens so
  // the operator sees the current value (it survives refresh in IDB; a live bump from a
  // retry-exhaustion in another code path lands on the next open).
  useEffect(() => {
    if (!debugLogOpen) return
    void getRemoteDebugDropCount().then(setRemoteDropCount)
  }, [debugLogOpen])

  // Derived sidebar model: project groups (sorted by latest activity) + standalone
  // canvas ids. Replaces the hardcoded demo projectGroups/starterCanvasIds.
  const sidebarModel = useMemo(() => buildSidebarModel(projects, canvases), [projects, canvases])

  const openChangelog = () => {
    setChangelogOpenedAt(Date.now())
    debugLogger.log('Changelog', 'Changelog panel opened')
  }

  const openCanvasById = (canvasId: CanvasId) => {
    loadScene(canvasId)
    onOpenCanvas(canvasId)
  }

  const createStandaloneCanvas = () => {
    const canvasId = createCanvas('Untitled Canvas')
    // PR-C1 二轮 P2:createCanvas blocked → 返 undefined。store 层已弹 warn,caller 不重复提示/不打开。
    if (!canvasId) return
    onOpenCanvas(canvasId)
    toastFeedback.success('已新建画板')
  }

  const newProject = () => {
    const id = createProject()
    setRenamingProjectId(id)
  }

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
            <button
              type="button"
              aria-label="New project"
              title="New project"
              onClick={newProject}
            >
              <Plus size={15} />
            </button>
          </div>
          {projectsOpen ? (
            <div className="project-tree" aria-label="Project canvas tree">
              {sidebarModel.projectGroups.map((group) => (
                <ProjectRow
                  key={group.project.id}
                  project={group.project}
                  canvasIds={group.canvasIds}
                  collapsed={collapsed.has(group.project.id)}
                  onToggle={() => toggleProjectCollapsed(group.project.id)}
                  onExpandProject={(projectId) => setProjectCollapsed(projectId, false)}
                  onOpenCanvas={openCanvasById}
                  renaming={renamingProjectId === group.project.id}
                  onRenameStart={() => setRenamingProjectId(group.project.id)}
                  onRenameSubmit={() => setRenamingProjectId(null)}
                  onRenameCancel={() => setRenamingProjectId(null)}
                />
              ))}
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
            {sidebarModel.standaloneCanvasIds.map((canvasId) => (
              <CanvasRow
                key={canvasId}
                canvasId={canvasId}
                onOpenCanvas={openCanvasById}
                onExpandProject={(projectId) => setProjectCollapsed(projectId, false)}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="settings-area">
        <div className="changelog-area">
          {changelogOpenedAt !== null ? (
            <ChangelogPanel openedAt={changelogOpenedAt} onClose={() => setChangelogOpenedAt(null)} />
          ) : null}
          <button
            type="button"
            className="debug-log-row changelog-row"
            aria-label="Change Log"
            onClick={openChangelog}
          >
            <Sparkles size={17} />
            <span>Change Log</span>
            {hasUnreadChangelog ? <span className="changelog-badge-dot" aria-hidden="true" /> : null}
          </button>
        </div>
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
                      <div className="debug-log-dropcount" title="Remote diagnostic batches dropped after retry exhaustion (FX-7)">
                        {remoteDropCount === null ? (
                          <span aria-live="polite">Dropped…</span>
                        ) : remoteDropCount > 0 ? (
                          <span className="debug-log-dropcount-warn" aria-live="polite">
                            Dropped {remoteDropCount}
                          </span>
                        ) : (
                          <span aria-live="polite">Dropped 0</span>
                        )}
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
        <UserChip />
      </div>
    </aside>
  )
}
