import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { MarkdownPreview } from '../lib/MarkdownPreview'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { useCanvasStore } from '../store/canvasStore'
import { brushOutlinePathFor } from './brushGeometry'
import {
  frameRenderStyleFor,
  markupRenderStyleFor,
  nodeRenderBoxFor,
  textRenderStyleFor,
} from './canvasRenderAdapter'
import type { ResizeCorner } from './canvasGeometry'
import { ImageMaskEditOverlay } from './ImageMaskEditOverlay'
import type { ImageMaskSubmitPayload } from './imageMaskGeometry'
import { renderKindForNode } from './nodeTypes/canvasNodeRegistry'
import { stampSrcFor } from './stampDefs'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from './textGeometry'
import type { TextResizeEdge } from './useCanvasInteractionController'

type CanvasNodeViewProps = {
  node: MivoCanvasNode
  selected: boolean
  selectionPreview: boolean
  sectionDropTarget: boolean
  connectorDropTarget: boolean
  primarySelected: boolean
  editing: boolean
  effectiveLocked: boolean
  handleSize: number
  handleBorderWidth: number
  selectionStrokeWidth: number
  maskEditActive: boolean
  maskEditSubmitting: boolean
  viewportScale: number
  onSelect: (nodeId: string, options?: { additive?: boolean }) => void
  onPointerDown: (nodeId: string, event: React.PointerEvent<HTMLDivElement>) => void
  onResizeHandlePointerDown: (
    nodeId: string,
    corner: ResizeCorner,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void
  onMarkupPointPointerDown: (
    nodeId: string,
    pointIndex: number,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void
  onTextResizeHandlePointerDown: (
    nodeId: string,
    edge: TextResizeEdge,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void
  onOpenDetails: (nodeId: string) => void
  onOpenContextMenu: (nodeId: string, x: number, y: number) => void
  onEditText: (nodeId: string) => void
  onRenameNode: (nodeId: string) => void
  onUpdateText: (nodeId: string, text: string) => void
  onFinishTextEdit: (nodeId: string) => void
  onResizeNodeToContent: (nodeId: string, width: number, height: number) => void
  onSubmitMaskEdit: (nodeId: string, resolvedAssetUrl: string, payload: ImageMaskSubmitPayload) => Promise<void>
  onCancelMaskEdit: () => void
}

function CanvasTextEditor({
  node,
  onUpdateText,
  onFinishTextEdit,
  className = 'dom-text-editor',
  style,
  autoSize = false,
}: {
  node: MivoCanvasNode
  onUpdateText: (nodeId: string, text: string) => void
  onFinishTextEdit: (nodeId: string) => void
  className?: string
  style?: CSSProperties
  autoSize?: boolean
}) {
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

  const resizeTextArea = useCallback(() => {
    const textArea = textAreaRef.current
    if (!textArea || !autoSize) return

    textArea.style.height = '0px'
    textArea.style.height = `${textArea.scrollHeight}px`
  }, [autoSize])

  useEffect(() => {
    const textArea = textAreaRef.current
    if (!textArea) return

    textArea.focus()
    const textLength = textArea.value.length
    textArea.setSelectionRange(textLength, textLength)
    resizeTextArea()
  }, [node.id, resizeTextArea])

  useEffect(() => {
    resizeTextArea()
  }, [resizeTextArea, node.text, node.fontSize, node.fontWeight, node.width])

  return (
    <textarea
      ref={textAreaRef}
      className={className}
      value={node.text || ''}
      style={{
        fontSize: node.fontSize || defaultTextFontSize,
        color: node.textColor || defaultTextColor,
        fontWeight: node.fontWeight || defaultTextWeight,
        textAlign: node.textAlign || defaultTextAlign,
        ...style,
      }}
      onChange={(event) => {
        if (autoSize) {
          event.currentTarget.style.height = '0px'
          event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`
        }
        onUpdateText(node.id, event.currentTarget.value)
      }}
      onBlur={() => onFinishTextEdit(node.id)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

const defaultMarkupPointsFor = (node: MivoCanvasNode) => {
  if (node.markupKind === 'arrow' || node.markupKind === 'line') {
    return [
      { x: Math.max(2, node.markupStrokeWidth || 3), y: Math.max(2, node.height - (node.markupStrokeWidth || 3)) },
      { x: Math.max(2, node.width - (node.markupStrokeWidth || 3)), y: Math.max(2, node.markupStrokeWidth || 3) },
    ]
  }

  if (node.markupKind === 'brush') {
    return [
      { x: 8, y: node.height * 0.6 },
      { x: node.width * 0.32, y: node.height * 0.25 },
      { x: node.width * 0.56, y: node.height * 0.68 },
      { x: node.width - 8, y: node.height * 0.3 },
    ]
  }

  return []
}

const isLineMarkup = (node: MivoCanvasNode) => node.markupKind === 'arrow' || node.markupKind === 'line'

const markupTextAlignFor = (node: MivoCanvasNode) =>
  node.textAlign || (node.markupKind === 'note' ? defaultTextAlign : 'center')

const lineLabelPositionFor = (node: MivoCanvasNode, points: Array<{ x: number; y: number }>) => {
  const start = points[0] || { x: 0, y: node.height }
  const end = points[1] || { x: node.width, y: 0 }

  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  }
}

const estimatedMarkupLabelWidth = (text: string, fontSize: number) => {
  const chars = Array.from(text || ' ')
  const rawWidth = chars.reduce((width, char) => {
    if (/[\u2e80-\u9fff\uf900-\ufaff]/.test(char)) return width + fontSize
    if (char === ' ') return width + fontSize * 0.35
    if (/[A-Z0-9]/.test(char)) return width + fontSize * 0.68
    return width + fontSize * 0.56
  }, 0)

  return Math.max(54, Math.min(360, rawWidth + 18))
}

const lineSegmentsWithLabelGap = (
  node: MivoCanvasNode,
  points: Array<{ x: number; y: number }>,
  labelActive: boolean,
) => {
  const start = points[0] || { x: 0, y: node.height }
  const end = points[1] || { x: node.width, y: 0 }

  if (!labelActive) return [{ start, end, markerEnd: true }]

  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 1) return [{ start, end, markerEnd: true }]

  const labelWidth = estimatedMarkupLabelWidth(node.text || 'Label', node.fontSize || defaultTextFontSize)
  const gap = Math.min(length * 0.42, labelWidth / 2 + 10)
  const gapRatio = gap / length
  const beforeEnd = {
    x: start.x + dx * Math.max(0, 0.5 - gapRatio),
    y: start.y + dy * Math.max(0, 0.5 - gapRatio),
  }
  const afterStart = {
    x: start.x + dx * Math.min(1, 0.5 + gapRatio),
    y: start.y + dy * Math.min(1, 0.5 + gapRatio),
  }

  return [
    { start, end: beforeEnd, markerEnd: false },
    { start: afterStart, end, markerEnd: true },
  ]
}

function MarkupTextLayer({
  node,
  points,
  editing,
  onUpdateText,
  onFinishTextEdit,
}: {
  node: MivoCanvasNode
  points: Array<{ x: number; y: number }>
  editing: boolean
  onUpdateText: (nodeId: string, text: string) => void
  onFinishTextEdit: (nodeId: string) => void
}) {
  const hasText = Boolean(node.text?.trim())
  if (!hasText && !editing) return null

  const commonTextStyle: CSSProperties = {
    color: node.textColor || defaultTextColor,
    fontSize: node.fontSize || defaultTextFontSize,
    fontWeight: node.fontWeight || defaultTextWeight,
    textAlign: markupTextAlignFor(node),
  }

  if (isLineMarkup(node)) {
    const position = lineLabelPositionFor(node, points)

    return (
      <div
        className={`dom-markup-label line-label ${editing ? 'editing' : ''}`}
        style={{
          left: position.x,
          top: position.y,
          maxWidth: Math.max(120, Math.min(320, node.width + 96)),
          ...commonTextStyle,
        }}
      >
        {editing ? (
          <CanvasTextEditor
            node={node}
            onUpdateText={onUpdateText}
            onFinishTextEdit={onFinishTextEdit}
            className="dom-markup-text-editor line-label-editor"
            style={commonTextStyle}
            autoSize
          />
        ) : (
          node.text
        )}
      </div>
    )
  }

  return (
    <div
      className={`dom-markup-label shape-label kind-${node.markupKind || 'rect'} ${editing ? 'editing' : ''}`}
      style={commonTextStyle}
    >
      {editing ? (
        <CanvasTextEditor
          node={node}
          onUpdateText={onUpdateText}
          onFinishTextEdit={onFinishTextEdit}
          className="dom-markup-text-editor shape-label-editor"
          style={commonTextStyle}
          autoSize
        />
      ) : (
        node.text
      )}
    </div>
  )
}

function MarkupNodeView({
  node,
  editing,
  onUpdateText,
  onFinishTextEdit,
}: {
  node: MivoCanvasNode
  editing: boolean
  onUpdateText: (nodeId: string, text: string) => void
  onFinishTextEdit: (nodeId: string) => void
}) {
  const kind = node.markupKind || 'rect'
  const lastPlacedStampId = useCanvasStore((state) => state.lastPlacedStampId)
  const renderStyle = markupRenderStyleFor(node)
  const strokeWidth = renderStyle.strokeWidth
  const stroke = renderStyle.stroke
  const fill = renderStyle.fill
  const strokeDasharray = renderStyle.strokeStyle === 'dashed' ? `${strokeWidth * 2.2} ${strokeWidth * 1.6}` : undefined
  const points = node.markupPoints?.length ? node.markupPoints : defaultMarkupPointsFor(node)
  const markerId = `markup-arrow-${node.id}`
  const lineLabelActive = isLineMarkup(node) && (editing || Boolean(node.text?.trim()))
  const lineSegments = lineSegmentsWithLabelGap(node, points, lineLabelActive)
  const showStartArrow = Boolean(node.markupStartArrow)
  const showEndArrow = node.markupEndArrow ?? kind === 'arrow'

  if (kind === 'stamp') {
    const justPlaced = lastPlacedStampId === node.id
    return (
      <div
        className={`dom-markup-stamp dom-markup-stamp-svg${justPlaced ? ' just-placed' : ''}`}
        aria-label={node.title}
      >
        <img src={stampSrcFor(node.markupStampKind)} alt={node.title || ''} draggable={false} />
        {justPlaced ? (
          <span className="stamp-impact" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, index) => (
              <i key={index} style={{ '--impact-angle': `${index * 45}deg` } as CSSProperties} />
            ))}
          </span>
        ) : null}
      </div>
    )
  }

  if (kind === 'note') {
    return (
      <>
        <div
          className="dom-markup-note"
          style={{
            background: fill === 'transparent' ? '#fff1a8' : fill,
            borderColor: stroke,
          }}
        />
        <MarkupTextLayer
          node={node}
          points={points}
          editing={editing}
          onUpdateText={onUpdateText}
          onFinishTextEdit={onFinishTextEdit}
        />
      </>
    )
  }

  return (
    <>
      <svg
        className="dom-markup-node"
        viewBox={`0 0 ${Math.max(1, node.width)} ${Math.max(1, node.height)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <marker
            id={markerId}
            markerWidth="18"
            markerHeight="18"
            refX="15"
            refY="9"
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path
              d="M 5 3 L 15 9 L 5 15"
              fill="none"
              stroke={stroke}
              strokeWidth={Math.max(2.5, Math.min(5.5, strokeWidth))}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        </defs>
        {kind === 'rect' ? (
          <rect
            x={strokeWidth / 2}
            y={strokeWidth / 2}
            width={Math.max(1, node.width - strokeWidth)}
            height={Math.max(1, node.height - strokeWidth)}
            rx={node.markupCornerRadius ?? 4}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeOpacity={renderStyle.strokeOpacity}
            strokeDasharray={strokeDasharray}
          />
        ) : kind === 'ellipse' ? (
          <ellipse
            cx={node.width / 2}
            cy={node.height / 2}
            rx={Math.max(1, node.width / 2 - strokeWidth / 2)}
            ry={Math.max(1, node.height / 2 - strokeWidth / 2)}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeOpacity={renderStyle.strokeOpacity}
            strokeDasharray={strokeDasharray}
          />
        ) : kind === 'brush' ? (
          renderStyle.strokeStyle === 'dashed' ? (
            // Filled freehand outlines cannot express dashes; dashed brush keeps the legacy polyline.
            <polyline
              points={points.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeOpacity={renderStyle.strokeOpacity}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={strokeDasharray}
            />
          ) : (
            <path
              d={brushOutlinePathFor(points, strokeWidth, node.markupBrushKind || 'marker')}
              fill={stroke}
              fillOpacity={renderStyle.strokeOpacity}
              stroke="none"
            />
          )
        ) : (
          <>
            <line
              className="markup-hit-line"
              x1={points[0]?.x ?? 0}
              y1={points[0]?.y ?? node.height}
              x2={points[1]?.x ?? node.width}
              y2={points[1]?.y ?? 0}
              stroke="transparent"
              strokeWidth={Math.max(14, strokeWidth + 10)}
              strokeLinecap="round"
            />
            {lineSegments.map((segment, index) => {
              const hasStartMarker = index === 0 && showStartArrow
              const hasEndMarker = segment.markerEnd && showEndArrow

              return (
                <line
                  key={index}
                  className="markup-visible-line"
                  x1={segment.start.x}
                  y1={segment.start.y}
                  x2={segment.end.x}
                  y2={segment.end.y}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeOpacity={renderStyle.strokeOpacity}
                  strokeLinecap={hasStartMarker || hasEndMarker ? 'butt' : 'round'}
                  strokeDasharray={strokeDasharray}
                  markerStart={hasStartMarker ? `url(#${markerId})` : undefined}
                  markerEnd={hasEndMarker ? `url(#${markerId})` : undefined}
                />
              )
            })}
          </>
      )}
      </svg>
      <MarkupTextLayer
        node={node}
        points={points}
        editing={editing}
        onUpdateText={onUpdateText}
        onFinishTextEdit={onFinishTextEdit}
      />
    </>
  )
}

export const CanvasNodeView = memo(function CanvasNodeView({
  node,
  selected,
  selectionPreview,
  sectionDropTarget,
  connectorDropTarget,
  primarySelected,
  editing,
  effectiveLocked,
  handleSize,
  handleBorderWidth,
  selectionStrokeWidth,
  maskEditActive,
  maskEditSubmitting,
  viewportScale,
  onSelect,
  onPointerDown,
  onResizeHandlePointerDown,
  onMarkupPointPointerDown,
  onTextResizeHandlePointerDown,
  onOpenDetails,
  onOpenContextMenu,
  onEditText,
  onRenameNode,
  onUpdateText,
  onFinishTextEdit,
  onResizeNodeToContent,
  onSubmitMaskEdit,
  onCancelMaskEdit,
}: CanvasNodeViewProps) {
  const markdownDocumentRef = useRef<HTMLElement | null>(null)
  // Size is stored together with its source URL so a stale measurement simply stops
  // applying when the asset changes, instead of being reset from an effect.
  const [measuredNaturalSize, setMeasuredNaturalSize] = useState<{
    url: string
    width: number
    height: number
  }>()
  const resolvedAssetUrl = useResolvedAssetUrl(node.assetUrl)
  const naturalSize =
    measuredNaturalSize && measuredNaturalSize.url === resolvedAssetUrl ? measuredNaturalSize : undefined
  const renderKind = renderKindForNode(node)
  const textNode = renderKind === 'text' || renderKind === 'annotation'
  const frameNode = renderKind === 'section'
  const aiSlotNode = renderKind === 'ai-slot'
  const aiSlotStatus = node.aiWorkflow?.status
  const aiSlotStatusLabel =
    aiSlotStatus === 'ready'
      ? 'Ready for another result'
      : aiSlotStatus === 'generating'
        ? 'Generating...'
        : aiSlotStatus === 'failed'
          ? 'Generation failed'
          : aiSlotStatus === 'canceled'
            ? 'Generation canceled'
            : 'Drop an AI result here'
  const taskNode = renderKind === 'task'
  const annotationNode = renderKind === 'annotation'
  const markupNode = renderKind === 'markup'
  const markdownNode = renderKind === 'markdown'
  const markdownDisplayMode = markdownNode ? node.markdownDisplayMode || 'full' : undefined
  const markdownPreviewMode = markdownDisplayMode === 'preview'
  const markdownStatsLabel =
    markdownNode && node.text
      ? `${node.text.split(/\r?\n/).length} lines · ${node.text.length} chars`
      : 'Markdown document'
  const pdfNode = renderKind === 'pdf'
  const videoNode = renderKind === 'video'
  const fileNode = markdownNode || pdfNode || videoNode
  const lineMarkupNode = markupNode && (node.markupKind === 'arrow' || node.markupKind === 'line')
  const markupPointHandles = lineMarkupNode
    ? node.markupPoints && node.markupPoints.length >= 2
      ? node.markupPoints.slice(0, 2)
      : defaultMarkupPointsFor(node).slice(0, 2)
    : []
  const emptyText = textNode && !node.text?.trim()
  const imageNode = node.type === 'image'
  const transparentImage = imageNode && Boolean(node.imageHasTransparency)
  const imageCrop = imageNode ? node.imageCrop : undefined
  const imageCropStyle: CSSProperties | undefined = imageCrop
    ? {
        position: 'absolute',
        left: `${-(imageCrop.x / imageCrop.width) * 100}%`,
        top: `${-(imageCrop.y / imageCrop.height) * 100}%`,
        width: `${100 / imageCrop.width}%`,
        height: `${100 / imageCrop.height}%`,
        objectFit: 'fill',
      }
    : undefined
  const nodeStyle: CSSProperties & { '--node-selection-stroke': string } = {
    ...nodeRenderBoxFor(node),
    '--node-selection-stroke': `${selectionStrokeWidth}px`,
  }
  const nodeClassName = [
    'dom-node',
    textNode && 'text-node',
    frameNode && 'frame-node',
    aiSlotNode && 'ai-slot-node',
    annotationNode && 'annotation-node',
    markupNode && 'markup-node',
    fileNode && 'file-node',
    markdownNode && 'markdown-node',
    pdfNode && 'pdf-node',
    videoNode && 'video-node',
    emptyText && 'empty-text',
    editing && 'editing',
    effectiveLocked && 'locked-node',
    transparentImage && 'transparent-image-node',
    selected && 'selected',
    selectionPreview && 'selection-preview',
    sectionDropTarget && 'section-drop-target',
    connectorDropTarget && 'connector-drop-target',
    markdownPreviewMode && 'markdown-preview-mode',
    node.aiWorkflow?.status && `ai-${node.aiWorkflow.status}`,
    node.status,
  ]
    .filter(Boolean)
    .join(' ')

  useEffect(() => {
    if (!markdownNode || markdownPreviewMode) return undefined

    const element = markdownDocumentRef.current
    if (!element) return undefined

    let animationFrame = 0
    const measure = () => {
      animationFrame = 0
      const measuredHeight = Math.ceil(element.scrollHeight)
      if (measuredHeight <= 0 || Math.abs(measuredHeight - node.height) <= 2) return

      onResizeNodeToContent(node.id, node.width, measuredHeight)
    }
    const scheduleMeasure = () => {
      if (animationFrame) return
      animationFrame = window.requestAnimationFrame(measure)
    }

    scheduleMeasure()
    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(element)

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
    }
  }, [markdownNode, markdownPreviewMode, node.height, node.id, node.text, node.width, onResizeNodeToContent])

  return (
    <div
      data-node-id={node.id}
      data-node-type={node.type}
      data-section-id={node.sectionId}
      data-ai-kind={node.aiWorkflow?.kind}
      data-ai-operation={node.aiWorkflow?.operation}
      data-ai-source-node-ids={node.aiWorkflow?.sourceNodeIds?.join(',')}
      data-markup-kind={node.markupKind}
      data-target-node-id={node.targetNodeId}
      data-connector-start-node-id={node.connectorStart?.nodeId}
      data-connector-start-anchor={node.connectorStart?.anchor}
      data-connector-start-offset={node.connectorStart?.offset}
      data-connector-end-node-id={node.connectorEnd?.nodeId}
      data-connector-end-anchor={node.connectorEnd?.anchor}
      data-connector-end-offset={node.connectorEnd?.offset}
      className={nodeClassName}
      style={nodeStyle}
      onPointerDown={(event) => onPointerDown(node.id, event)}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!selected) onSelect(node.id)
        onOpenContextMenu(node.id, event.clientX, event.clientY)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onSelect(node.id)
        if (textNode || markupNode) {
          onEditText(node.id)
        } else if (frameNode) {
          onRenameNode(node.id)
        } else {
          onOpenDetails(node.id)
        }
      }}
    >
      {frameNode ? (
        <div
          className="dom-frame-node"
          style={frameRenderStyleFor(node)}
        >
          {node.sectionTitleVisible !== false ? <div className="dom-frame-title">{node.title}</div> : null}
        </div>
      ) : aiSlotNode ? (
        <div className="dom-ai-slot-node">
          <div>
            <strong>{node.title}</strong>
            <span>{aiSlotStatusLabel}</span>
          </div>
          <em>{node.width} x {node.height}</em>
        </div>
      ) : markupNode ? (
        <MarkupNodeView
          node={node}
          editing={editing}
          onUpdateText={onUpdateText}
          onFinishTextEdit={onFinishTextEdit}
        />
      ) : textNode ? (
        editing ? (
          <CanvasTextEditor node={node} onUpdateText={onUpdateText} onFinishTextEdit={onFinishTextEdit} />
        ) : (
          <div
            className={annotationNode ? 'dom-text-node dom-annotation-node' : 'dom-text-node'}
            style={textRenderStyleFor(node)}
          >
            {node.text}
          </div>
        )
      ) : fileNode ? (
        <div className={`dom-file-node ${node.type}`}>
          {markdownNode ? (
            <article
              className={markdownPreviewMode ? 'dom-markdown-document preview-mode' : 'dom-markdown-document'}
              ref={markdownDocumentRef}
            >
              <div className="dom-file-node-header">
                <span>MD</span>
                <strong>{node.title}</strong>
                <em>{markdownStatsLabel}</em>
              </div>
              <MarkdownPreview text={node.text} />
              {markdownPreviewMode ? (
                <div className="dom-markdown-preview-fade">
                  <span>Open details for full document</span>
                </div>
              ) : null}
            </article>
          ) : pdfNode ? (
            <>
              <div className="dom-file-node-badge">PDF</div>
              <strong>{node.title}</strong>
              <span>{node.assetMimeType || 'application/pdf'}</span>
            </>
          ) : resolvedAssetUrl ? (
            <>
              <video src={resolvedAssetUrl} preload="metadata" muted playsInline />
              <div className="dom-file-video-play" aria-hidden="true" />
              <div className="dom-file-video-label">
                <span>VIDEO</span>
                <strong>{node.title}</strong>
              </div>
            </>
          ) : (
            <>
              <div className="dom-file-node-badge">VID</div>
              <strong>{node.title}</strong>
              <span>{node.assetMimeType || 'video'}</span>
            </>
          )}
        </div>
      ) : (
        <div
          className={imageCrop ? 'dom-node-media cropped' : 'dom-node-media'}
          style={{ width: node.width, height: node.height }}
        >
          {taskNode ? (
          <div className="dom-task-node">
            <strong>{node.status === 'failed' ? 'Task failed' : 'Generating...'}</strong>
            <span>{node.generation?.prompt}</span>
            <i style={{ width: node.status === 'failed' ? '18%' : '62%' }} />
          </div>
          ) : (
          resolvedAssetUrl ? (
            <img
              className={imageCrop ? 'cropped-image' : undefined}
              src={resolvedAssetUrl}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              style={imageCropStyle}
              onLoad={(event) =>
                setMeasuredNaturalSize({
                  url: resolvedAssetUrl,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          ) : (
            <div className="dom-node-placeholder" />
          )
          )}
          {imageNode && maskEditActive && resolvedAssetUrl && naturalSize ? (
            <ImageMaskEditOverlay
              node={node}
              resolvedAssetUrl={resolvedAssetUrl}
              naturalSize={naturalSize}
              viewportScale={viewportScale}
              submitting={maskEditSubmitting}
              onCancel={onCancelMaskEdit}
              onSubmit={(payload) => onSubmitMaskEdit(node.id, resolvedAssetUrl, payload)}
            />
          ) : null}
        </div>
      )}
      {primarySelected && !editing && textNode && !effectiveLocked ? (
        <>
          {(['w', 'e'] as const).map((edge) => (
            <button
              key={edge}
              type="button"
              className={`text-resize-handle ${edge}`}
              aria-label={`Resize text ${edge}`}
              onPointerDown={(event) => onTextResizeHandlePointerDown(node.id, edge, event)}
            />
          ))}
        </>
      ) : null}
      {primarySelected && !editing && lineMarkupNode && !effectiveLocked ? (
        <>
          {markupPointHandles.map((point, index) => (
            <button
              key={index}
              type="button"
              className={`markup-point-handle ${
                (index === 0 ? node.connectorStart : node.connectorEnd) ? 'bound' : ''
              }`}
              aria-label={`Edit ${node.markupKind} point ${index + 1}`}
              style={{
                left: point.x,
                top: point.y,
                width: handleSize,
                height: handleSize,
                borderWidth: handleBorderWidth,
              }}
              onPointerDown={(event) => onMarkupPointPointerDown(node.id, index, event)}
            />
          ))}
        </>
      ) : null}
      {primarySelected && !editing && !textNode && !lineMarkupNode && !effectiveLocked ? (
        <>
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <button
              key={corner}
              type="button"
              className={`node-handle ${corner}`}
              aria-label={`Resize ${corner}`}
              style={{
                left: corner.endsWith('e') ? node.width : 0,
                top: corner.startsWith('s') ? node.height : 0,
                width: handleSize,
                height: handleSize,
                borderWidth: handleBorderWidth,
              }}
              onPointerDown={(event) => onResizeHandlePointerDown(node.id, corner, event)}
            />
          ))}
        </>
      ) : null}
    </div>
  )
})
