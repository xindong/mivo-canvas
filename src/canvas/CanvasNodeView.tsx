import { memo, useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { MarkdownPreview } from '../lib/MarkdownPreview'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import { useImageNaturalSize } from '../lib/useImageNaturalSize'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { useCanvasStore } from '../store/canvasStore'
import { brushOutlinePathFor } from '../model/brushGeometry'
import {
  frameRenderStyleFor,
  markupRenderStyleFor,
  nodeRenderBoxFor,
  textRenderStyleFor,
} from './canvasRenderAdapter'
import type { ResizeCorner } from './canvasGeometry'
import {
  defaultMarkupPointsFor,
  isLineMarkup,
  lineLabelPositionFor,
  lineSegmentsWithLabelGap,
  markupTextAlignFor,
} from './markupTextGeometry'
import { renderKindForNode } from '../model/canvasNodeRegistry'
import { stampSrcFor } from './stampDefs'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from './textGeometry'
import type { TextResizeEdge } from './useCanvasInteractionController'
import { isLeaferSpikePainted } from '../render/leaferSpikeFilter'
import { rendererMode } from '../render/rendererMode'

export type CanvasNodeViewProps = {
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
  onUpdateText: (nodeId: string, text: string) => void
  onFinishTextEdit: (nodeId: string) => void
  onResizeNodeToContent: (nodeId: string, width: number, height: number) => void
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
  onResizeHandlePointerDown,
  onMarkupPointPointerDown,
  onTextResizeHandlePointerDown,
  onUpdateText,
  onFinishTextEdit,
  onResizeNodeToContent,
}: CanvasNodeViewProps) {
  const markdownDocumentRef = useRef<HTMLElement | null>(null)
  const resolvedAssetUrl = useResolvedAssetUrl(node.assetUrl)
  const { onLoad: onImageLoad } = useImageNaturalSize(
    node.assetUrl,
    node.assetSourceDimensions,
  )
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
  // FU-11/12: leafer 模式下被 Leafer 真画的节点,DOM 侧只保留"纯文字壳"——
  // markup 的 MarkupTextLayer / frame 的 dom-frame-title。能走到这里说明
  // leaferSpikeFilter 已判定该节点需要文字层(有文字或编辑中/标题可见)。
  const leaferPaintedNode = rendererMode === 'leafer' && isLeaferSpikePainted(node)
  const markupTextOverlayOnly = markupNode && node.markupKind !== 'stamp' && leaferPaintedNode
  const stampSelectionShellOnly = markupNode && node.markupKind === 'stamp' && leaferPaintedNode
  const frameTitleOverlayOnly = frameNode && rendererMode === 'leafer' && isLeaferSpikePainted(node)
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
    markupNode && node.markupKind === 'stamp' && 'stamp-node',
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

  if (frameTitleOverlayOnly) {
    // 壳只承载标题药丸:dom-frame-title 相对节点盒绝对定位(top:-38px 悬于上沿),
    // 壳与整节点同一 nodeRenderBoxFor 定位链;盒体(dom-frame-node 底/虚线框)
    // 由 Leafer 真画。改名(双击 → window.prompt)走画布 hit-test,不依赖本壳。
    return (
      <div
        data-node-id={node.id}
        data-node-type={node.type}
        data-section-id={node.sectionId}
        className="dom-node frame-node frame-title-overlay"
        style={nodeStyle}
      >
        <div className="dom-frame-title">{node.title}</div>
      </div>
    )
  }

  if (markupTextOverlayOnly) {
    // 壳只承载 MarkupTextLayer:定位/transform 链与整节点一致(nodeRenderBoxFor),
    // 双击编辑/失焦提交沿用 canvas hit-test → editing prop 的既有链路;本体
    // (SVG/note 背景)跳过,由 Leafer 真画。选中态视觉/handle 不在壳上渲染,
    // 与 leafer 模式下无文字 markup 的现状保持一口径。
    return (
      <div
        data-node-id={node.id}
        data-node-type={node.type}
        data-markup-kind={node.markupKind}
        className={`dom-node markup-node markup-text-overlay${editing ? ' editing' : ''}`}
        style={nodeStyle}
      >
        <MarkupTextLayer
          node={node}
          points={node.markupPoints?.length ? node.markupPoints : defaultMarkupPointsFor(node)}
          editing={editing}
          onUpdateText={onUpdateText}
          onFinishTextEdit={onFinishTextEdit}
        />
      </div>
    )
  }

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
          {aiSlotStatus === 'generating' ? (
            // 规格(2026-07-05 用户):生成中占位符只留 mivo logo——标题/状态文案/
            // 进度行/右下角尺寸角标全部不渲染,保持干净的 loading 视觉。
            <span className="mivo-logo ai-slot-mivo-logo" aria-hidden="true" />
          ) : (
            <>
              <div className="ai-slot-copy">
                <strong>{node.title}</strong>
                <span>{aiSlotStatusLabel}</span>
              </div>
              <em>{node.width} x {node.height}</em>
            </>
          )}
        </div>
      ) : stampSelectionShellOnly ? (
        // leafer 模式下 stamp 本体由 leaferBrushStampPaint 的 Group/sticker 真画。
        // filter 仅在选中 stamp 时放行到这里,DOM 壳只承载 selected 外框和 4 角 handle。
        null
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
      ) : imageNode && rendererMode === 'leafer' && isLeaferSpikePainted(node) ? (
        // leafer 模式下 image 本体由 leaferImagePaint 真画，DOM 壳不画 <img>
        // （filter 仅对选中 image 放行至此，故此处壳承载 .dom-node.selected
        // 外框 + primarySelected 的 4 角 handle；未选中 image 不进 DOM 列表）。
        null
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
              onLoad={onImageLoad}
            />
          ) : (
            <div className="dom-node-placeholder" />
          )
          )}
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
