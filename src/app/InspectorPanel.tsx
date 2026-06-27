import { Box, Copy, Database, Sparkles, Star, X } from 'lucide-react'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import { useCanvasStore } from '../store/canvasStore'

type InspectorPanelProps = {
  onClose?: () => void
}

export function InspectorPanel({ onClose }: InspectorPanelProps) {
  const nodes = useCanvasStore((state) => state.nodes)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const updatePrompt = useCanvasStore((state) => state.updatePrompt)
  const toggleFavorite = useCanvasStore((state) => state.toggleFavorite)
  const generateVariations = useCanvasStore((state) => state.generateVariations)

  const node = nodes.find((item) => item.id === selectedNodeId)
  const resolvedAssetUrl = useResolvedAssetUrl(node?.assetUrl)

  if (!node) {
    return (
      <aside className="inspector-panel empty">
        <div className="panel-topline">
          <div>
            <div className="panel-kicker">Details</div>
            <h2>No selection</h2>
          </div>
          {onClose ? (
            <button type="button" className="panel-close" onClick={onClose} aria-label="Close details">
              <X size={17} />
            </button>
          ) : null}
        </div>
      </aside>
    )
  }

  return (
    <aside className="inspector-panel">
      <div className="panel-topline">
        <div>
          <div className="panel-kicker">Selected image</div>
          <h2>{node.title}</h2>
        </div>
        <div className="panel-header-actions">
          <button
            type="button"
            className={node.favorited ? 'favorite active' : 'favorite'}
            onClick={() => toggleFavorite(node.id)}
            aria-label="Toggle favorite"
            title="Toggle favorite"
          >
            <Star size={17} />
          </button>
          {onClose ? (
            <button type="button" className="panel-close" onClick={onClose} aria-label="Close details">
              <X size={17} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="node-preview">
        {resolvedAssetUrl ? <img className="node-preview-image" src={resolvedAssetUrl} alt="" /> : <Box size={32} />}
      </div>

      <label className="field">
        <span>Prompt</span>
        <textarea
          value={node.generation?.prompt || ''}
          onChange={(event) => updatePrompt(node.id, event.target.value)}
          rows={5}
        />
      </label>

      <div className="meta-grid">
        <div>
          <span>Model</span>
          <strong>{node.generation?.model || 'Mivo'}</strong>
        </div>
        <div>
          <span>Size</span>
          <strong>{node.generation?.size || `${node.width}x${node.height}`}</strong>
        </div>
        <div>
          <span>Seed</span>
          <strong>{node.generation?.seed ?? '-'}</strong>
        </div>
        <div>
          <span>Parents</span>
          <strong>{node.parentIds?.length || 0}</strong>
        </div>
      </div>

      <div className="panel-actions">
        <button type="button" onClick={() => generateVariations(node.id)}>
          <Sparkles size={16} />
          Make 4
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(JSON.stringify(node, null, 2))
          }}
        >
          <Copy size={16} />
          Copy node
        </button>
        <button type="button">
          <Database size={16} />
          Add asset
        </button>
      </div>
    </aside>
  )
}
