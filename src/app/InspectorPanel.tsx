import {
  Box,
  Copy,
  Download,
  FileImage,
  FileText,
  FileVideo,
  Frame,
  Info,
  Layers3,
  PencilLine,
  Sparkles,
  Star,
  StickyNote,
  Type,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { downloadCanvasNodeOriginal } from '../lib/assetDownload'
import { MarkdownPreview } from '../lib/MarkdownPreview'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import { useCanvasStore } from '../store/canvasStore'
import { renderKindForNode, type CanvasNodeRenderKind } from '../canvas/nodeTypes/canvasNodeRegistry'
import type { MivoCanvasNode } from '../types/mivoCanvas'

type InspectorPanelProps = {
  onClose?: () => void
}

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (timestamp?: number) => {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

const dimensionsLabel = (node: MivoCanvasNode) => `${Math.round(node.width)} x ${Math.round(node.height)}`

const positionLabel = (node: MivoCanvasNode) => `${Math.round(node.x)}, ${Math.round(node.y)}`

const sourceLabelFor = (node: MivoCanvasNode) => node.assetOriginalName || node.assetUrl || 'Canvas object'

const promptFor = (node: MivoCanvasNode) => node.generation?.prompt || node.aiWorkflow?.prompt || ''

const markdownStatsFor = (text = '') => {
  const lines = text ? text.split(/\r?\n/) : []
  const headingCount = lines.filter((line) => /^#{1,6}\s+/.test(line.trim())).length
  const taskCount = lines.filter((line) => /^\s*[-*]\s+\[[ xX]\]\s+/.test(line)).length
  const tableLineCount = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length
  let tableCount = 0
  let inTable = false

  lines.forEach((line) => {
    const tableLine = /^\s*\|.*\|\s*$/.test(line)
    if (tableLine && !inTable) tableCount += 1
    inTable = tableLine
  })

  return {
    characters: text.length,
    lines: lines.length,
    headings: headingCount,
    tasks: taskCount,
    tables: tableLineCount ? tableCount : 0,
  }
}

const detailsConfigFor = (
  renderKind: CanvasNodeRenderKind | undefined,
  nodeType: string,
): { label: string; Icon: LucideIcon } => {
  if (renderKind === 'markdown') return { label: 'Markdown document', Icon: FileText }
  if (renderKind === 'pdf') return { label: 'PDF document', Icon: FileText }
  if (renderKind === 'video') return { label: 'Video asset', Icon: FileVideo }
  if (renderKind === 'text') return { label: 'Text object', Icon: Type }
  if (renderKind === 'annotation') return { label: 'AI edit note', Icon: StickyNote }
  if (renderKind === 'section') return { label: 'Section', Icon: Frame }
  if (renderKind === 'markup') return { label: 'Markup', Icon: PencilLine }
  if (renderKind === 'ai-slot') return { label: 'AI slot', Icon: Sparkles }
  if (renderKind === 'task') return { label: 'Generation task', Icon: Sparkles }
  if (nodeType === 'image') return { label: 'Image asset', Icon: FileImage }
  return { label: 'Canvas object', Icon: Box }
}

const metaForNode = (node: MivoCanvasNode, renderKind: CanvasNodeRenderKind | undefined) => {
  if (renderKind === 'markdown') {
    const stats = markdownStatsFor(node.text || '')

    return [
      { label: 'Display', value: node.markdownDisplayMode === 'preview' ? 'Preview page' : 'Full page' },
      { label: 'Lines', value: `${stats.lines}` },
      { label: 'Characters', value: `${stats.characters}` },
      { label: 'Headings', value: `${stats.headings}` },
      { label: 'Tables', value: `${stats.tables}` },
      { label: 'Tasks', value: `${stats.tasks}` },
      { label: 'Canvas size', value: dimensionsLabel(node) },
      { label: 'MIME type', value: node.assetMimeType || 'text/markdown' },
      { label: 'Original file', value: sourceLabelFor(node) },
      { label: 'File size', value: formatBytes(node.assetSizeBytes) },
    ]
  }

  return [
    { label: 'Canvas size', value: dimensionsLabel(node) },
    { label: 'Position', value: positionLabel(node) },
    { label: 'Status', value: node.status },
    { label: 'MIME type', value: node.assetMimeType || node.type },
    { label: 'Original file', value: sourceLabelFor(node) },
    { label: 'File size', value: formatBytes(node.assetSizeBytes) },
    ...(node.generation
      ? [
          { label: 'Model', value: node.generation.model || 'Mivo' },
          { label: 'Seed', value: String(node.generation.seed ?? '—') },
        ]
      : []),
    ...(node.aiWorkflow
      ? [
          { label: 'AI workflow', value: node.aiWorkflow.operation || node.aiWorkflow.kind },
          { label: 'Created', value: formatDate(node.aiWorkflow.createdAt) },
        ]
      : []),
    ...(renderKind === 'markup' && node.markupKind ? [{ label: 'Markup type', value: node.markupKind }] : []),
  ]
}

const shouldShowPromptField = (node: MivoCanvasNode, renderKind: CanvasNodeRenderKind | undefined) =>
  renderKind !== 'markdown' && Boolean(node.generation || node.aiWorkflow?.prompt || renderKind === 'task')

const renderNodePreview = (
  node: MivoCanvasNode,
  renderKind: CanvasNodeRenderKind | undefined,
  resolvedAssetUrl: string,
  markdownView: 'rendered' | 'raw',
) => {
  if (renderKind === 'image' || renderKind === 'task') {
    return resolvedAssetUrl ? <img className="node-preview-image" src={resolvedAssetUrl} alt="" /> : <Box size={32} />
  }

  if (renderKind === 'video') {
    return resolvedAssetUrl ? (
      <video className="node-preview-video" src={resolvedAssetUrl} controls preload="metadata" />
    ) : (
      <FileVideo size={36} />
    )
  }

  if (renderKind === 'pdf') {
    return resolvedAssetUrl ? (
      <iframe className="node-preview-pdf" src={resolvedAssetUrl} title={node.title} />
    ) : (
      <FileText size={36} />
    )
  }

  if (renderKind === 'markdown') {
    return (
      <div className="node-preview-markdown">
        {markdownView === 'raw' ? (
          <pre className="node-preview-markdown-raw">{node.text || ''}</pre>
        ) : (
          <MarkdownPreview text={node.text} density="details" />
        )}
      </div>
    )
  }

  if (renderKind === 'text' || renderKind === 'annotation') {
    return (
      <div
        className={renderKind === 'annotation' ? 'node-preview-text annotation' : 'node-preview-text'}
        style={{
          color: node.textColor,
          fontSize: Math.min(42, Math.max(17, node.fontSize || 24)),
          fontWeight: node.fontWeight || 760,
          textAlign: node.textAlign || 'left',
        }}
      >
        {node.text || 'Empty text'}
      </div>
    )
  }

  if (renderKind === 'section') {
    return (
      <div
        className="node-preview-section"
        style={
          {
            '--section-preview-fill': node.sectionFillColor || '#fffdf8',
            '--section-preview-border': node.sectionBorderColor || node.frameColor || '#ff8a00',
        } as CSSProperties
        }
      >
        <span>{node.sectionTitleVisible === false ? 'Untitled section' : node.title}</span>
      </div>
    )
  }

  if (renderKind === 'markup') {
    return (
      <div className={`node-preview-markup kind-${node.markupKind || 'shape'}`}>
        <PencilLine size={28} />
        <strong>{node.markupKind || 'Markup'}</strong>
        {node.text ? <span>{node.text}</span> : null}
      </div>
    )
  }

  if (renderKind === 'ai-slot') {
    return (
      <div className="node-preview-ai-slot">
        <Sparkles size={30} />
        <strong>{node.title}</strong>
        <span>{node.aiWorkflow?.status || 'empty slot'}</span>
      </div>
    )
  }

  return <Box size={32} />
}

export function InspectorPanel({ onClose }: InspectorPanelProps) {
  const nodes = useCanvasStore((state) => state.nodes)
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId)
  const updatePrompt = useCanvasStore((state) => state.updatePrompt)
  const setMarkdownDisplayMode = useCanvasStore((state) => state.setMarkdownDisplayMode)
  const toggleFavorite = useCanvasStore((state) => state.toggleFavorite)
  const generateVariations = useCanvasStore((state) => state.generateVariations)
  const [markdownView, setMarkdownView] = useState<'rendered' | 'raw'>('rendered')

  const node = nodes.find((item) => item.id === selectedNodeId)
  const resolvedAssetUrl = useResolvedAssetUrl(node?.assetUrl)
  const renderKind = node ? renderKindForNode(node) : undefined

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

  const detailsConfig = detailsConfigFor(renderKind, node.type)
  const prompt = promptFor(node)
  const showPrompt = shouldShowPromptField(node, renderKind)
  const markdownStats = renderKind === 'markdown' ? markdownStatsFor(node.text || '') : undefined
  const canDownloadOriginal = Boolean(node.assetUrl)
  const canMakeVariations = renderKind === 'image' || renderKind === 'task'
  const markdownDisplayMode = node.markdownDisplayMode || 'full'
  const metaItems = metaForNode(node, renderKind).filter((item) => item.value && item.value !== '—')
  const DetailsIcon = detailsConfig.Icon

  return (
    <aside className={`inspector-panel kind-${renderKind || node.type}`}>
      <div className="panel-topline">
        <div>
          <div className="panel-kicker">Details</div>
          <h2>{node.title}</h2>
          <div className="details-title-meta">
            <span>
              <DetailsIcon size={14} />
              {detailsConfig.label}
            </span>
            <span>{dimensionsLabel(node)}</span>
          </div>
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

      <div className={`node-preview kind-${renderKind || node.type}`}>
        {renderNodePreview(node, renderKind, resolvedAssetUrl, markdownView)}
      </div>

      <div className="details-side-panel">
        <div className="details-summary-card">
          <span className="details-summary-icon">
            <Info size={16} />
          </span>
          <div>
            <strong>{detailsConfig.label}</strong>
            <span>{sourceLabelFor(node)}</span>
          </div>
        </div>

        {renderKind === 'markdown' ? (
          <div className="markdown-detail-controls">
            <div>
              <span>Detail view</span>
              <div className="segmented-control">
                <button
                  type="button"
                  className={markdownView === 'rendered' ? 'active' : undefined}
                  onClick={() => setMarkdownView('rendered')}
                >
                  Rendered
                </button>
                <button
                  type="button"
                  className={markdownView === 'raw' ? 'active' : undefined}
                  onClick={() => setMarkdownView('raw')}
                >
                  Raw
                </button>
              </div>
            </div>
            <div>
              <span>Canvas display</span>
              <div className="segmented-control">
                <button
                  type="button"
                  className={markdownDisplayMode === 'full' ? 'active' : undefined}
                  onClick={() => setMarkdownDisplayMode(node.id, 'full')}
                >
                  Full
                </button>
                <button
                  type="button"
                  className={markdownDisplayMode === 'preview' ? 'active' : undefined}
                  onClick={() => setMarkdownDisplayMode(node.id, 'preview')}
                >
                  Preview
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showPrompt ? (
          <label className="field">
            <span>Prompt / instruction</span>
            <textarea value={prompt} onChange={(event) => updatePrompt(node.id, event.target.value)} rows={5} />
          </label>
        ) : node.text && renderKind !== 'markdown' ? (
          <div className="field readonly-field">
            <span>Text</span>
            <p>{node.text}</p>
          </div>
        ) : null}

        <div className="meta-grid">
          {metaItems.map((item) => (
            <div key={`${item.label}-${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

        <div className="panel-actions">
          {canMakeVariations ? (
            <button type="button" className="primary-action" onClick={() => generateVariations(node.id)}>
              <Sparkles size={16} />
              Make variations
            </button>
          ) : null}
          {renderKind === 'markdown' ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(node.text || '')
              }}
            >
              <Copy size={16} />
              Copy Markdown
            </button>
          ) : null}
          {canDownloadOriginal ? (
            <button type="button" onClick={() => void downloadCanvasNodeOriginal(node)}>
              <Download size={16} />
              Download original
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(node, null, 2))
            }}
          >
            <Copy size={16} />
            Copy node JSON
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(sourceLabelFor(node))
            }}
          >
            <Layers3 size={16} />
            Copy source
          </button>
        </div>
        {renderKind === 'markdown' && markdownStats ? (
          <p className="markdown-detail-note">
            {markdownStats.lines} lines · {markdownStats.characters} characters · original Markdown kept unchanged
          </p>
        ) : null}
      </div>
    </aside>
  )
}
