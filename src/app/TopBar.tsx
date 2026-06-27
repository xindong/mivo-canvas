import {
  ClipboardCopy,
  Copy,
  Download,
  Ellipsis,
  FileUp,
  FolderInput,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useEffect } from 'react'
import { useRef } from 'react'
import { useState } from 'react'
import { restoreCanvasImportAssets, stringifyCanvasArchive } from '../lib/canvasArchive'
import { parseCanvasSnapshot } from '../lib/snapshotValidation'
import { useCanvasStore } from '../store/canvasStore'

const downloadText = (filename: string, text: string) => {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

type TopBarProps = {
  projectSidebarOpen: boolean
}

export function TopBar({ projectSidebarOpen }: TopBarProps) {
  const importRef = useRef<HTMLInputElement | null>(null)
  const [importError, setImportError] = useState<string>()
  const [menuOpen, setMenuOpen] = useState(false)
  const nodes = useCanvasStore((state) => state.nodes)
  const tasks = useCanvasStore((state) => state.tasks)
  const sceneId = useCanvasStore((state) => state.sceneId)
  const canvasTitle = useCanvasStore((state) => state.canvases[state.sceneId]?.title || 'Workspace')
  const renameCanvas = useCanvasStore((state) => state.renameCanvas)
  const duplicateCanvas = useCanvasStore((state) => state.duplicateCanvas)
  const deleteCanvas = useCanvasStore((state) => state.deleteCanvas)
  const getSnapshot = useCanvasStore((state) => state.getSnapshot)
  const replaceSnapshot = useCanvasStore((state) => state.replaceSnapshot)
  const canvasCount = useCanvasStore((state) => Object.keys(state.canvases).length)

  const archiveText = () => stringifyCanvasArchive(getSnapshot())

  useEffect(() => {
    if (!menuOpen) return

    const closeMenu = () => setMenuOpen(false)
    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', closeMenu)

    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', closeMenu)
    }
  }, [menuOpen])

  const handleImport = async (file?: File) => {
    if (!file) return
    const text = await file.text()
    const result = parseCanvasSnapshot(text)

    if (!result.ok) {
      setImportError(result.message)
      return
    }

    try {
      await restoreCanvasImportAssets(result)
      setImportError(undefined)
      replaceSnapshot(result.snapshot)
    } catch {
      setImportError('归档素材恢复失败，请检查文件内容。')
    }
  }

  const promptRenameCanvas = () => {
    const nextTitle = window.prompt('Rename canvas', canvasTitle)?.trim()
    if (!nextTitle) return

    renameCanvas(sceneId, nextTitle)
  }

  const duplicateCurrentCanvas = () => {
    duplicateCanvas(sceneId)
  }

  const deleteCurrentCanvas = () => {
    if (canvasCount <= 1) return
    if (!window.confirm(`Delete "${canvasTitle}"?`)) return

    deleteCanvas(sceneId)
  }

  const closeAndRun = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  return (
    <header className={projectSidebarOpen ? 'top-bar sidebar-open' : 'top-bar sidebar-closed'}>
      <div className="top-title-area">
        <div className="top-title-lockup">
          <strong>{canvasTitle}</strong>
          <span>{nodes.length} nodes · {tasks.length} tasks</span>
        </div>
        {importError ? <span className="top-error">{importError}</span> : null}

        <div className="canvas-menu-wrap" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="canvas-menu-button"
            aria-label="Canvas options"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <Ellipsis size={20} />
          </button>
          {menuOpen ? (
            <div className="canvas-title-menu" role="menu" aria-label="Canvas options">
              <button type="button" role="menuitem" onClick={() => closeAndRun(promptRenameCanvas)}>
                <Pencil size={15} />
                <span>Rename</span>
              </button>
              <button type="button" role="menuitem" onClick={() => closeAndRun(duplicateCurrentCanvas)}>
                <Copy size={15} />
                <span>Duplicate canvas</span>
              </button>
              <button type="button" role="menuitem" disabled>
                <FolderInput size={15} />
                <span>Move to project</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                disabled={canvasCount <= 1}
                onClick={() => closeAndRun(deleteCurrentCanvas)}
              >
                <Trash2 size={15} />
                <span>Delete canvas</span>
              </button>
              <span className="canvas-menu-separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeAndRun(() => {
                    void archiveText().then((text) => navigator.clipboard?.writeText(text))
                  })
                }}
              >
                <ClipboardCopy size={15} />
                <span>Copy JSON</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => closeAndRun(() => void archiveText().then((text) => downloadText('mivo-canvas.json', text)))}
              >
                <Download size={15} />
                <span>Export JSON</span>
              </button>
              <button type="button" role="menuitem" onClick={() => closeAndRun(() => importRef.current?.click())}>
                <FileUp size={15} />
                <span>Import JSON</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <input
        ref={importRef}
        type="file"
        accept="application/json"
        onChange={(event) => {
          void handleImport(event.target.files?.[0])
          event.target.value = ''
        }}
        hidden
      />
    </header>
  )
}
