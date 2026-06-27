import { useEffect, useRef, type CSSProperties } from 'react'
import { useResolvedAssetUrl } from '../lib/useResolvedAssetUrl'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import type { ResizeCorner } from './canvasGeometry'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from './textGeometry'
import type { TextResizeEdge } from './useCanvasInteractionController'

type CanvasNodeViewProps = {
  node: MivoCanvasNode
  selected: boolean
  selectionPreview: boolean
  sectionDropTarget: boolean
  primarySelected: boolean
  editing: boolean
  effectiveLocked: boolean
  handleSize: number
  handleBorderWidth: number
  selectionStrokeWidth: number
  onSelect: (nodeId: string, options?: { additive?: boolean }) => void
  onPointerDown: (nodeId: string, event: React.PointerEvent<HTMLDivElement>) => void
  onResizeHandlePointerDown: (
    nodeId: string,
    corner: ResizeCorner,
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
}

const isTaskNode = (node: MivoCanvasNode) => node.type === 'task-placeholder'
const isTextNode = (node: MivoCanvasNode) => node.type === 'text' || node.type === 'annotation'
const isFrameNode = (node: MivoCanvasNode) => node.type === 'frame'
const isAiSlotNode = (node: MivoCanvasNode) => node.type === 'ai-slot'

function CanvasTextEditor({
  node,
  onUpdateText,
  onFinishTextEdit,
}: {
  node: MivoCanvasNode
  onUpdateText: (nodeId: string, text: string) => void
  onFinishTextEdit: (nodeId: string) => void
}) {
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const textArea = textAreaRef.current
    if (!textArea) return

    textArea.focus()
    const textLength = textArea.value.length
    textArea.setSelectionRange(textLength, textLength)
  }, [node.id])

  return (
    <textarea
      ref={textAreaRef}
      className="dom-text-editor"
      value={node.text || ''}
      style={{
        fontSize: node.fontSize || defaultTextFontSize,
        color: node.textColor || defaultTextColor,
        fontWeight: node.fontWeight || defaultTextWeight,
        textAlign: node.textAlign || defaultTextAlign,
      }}
      onChange={(event) => onUpdateText(node.id, event.currentTarget.value)}
      onBlur={() => onFinishTextEdit(node.id)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export function CanvasNodeView({
  node,
  selected,
  selectionPreview,
  sectionDropTarget,
  primarySelected,
  editing,
  effectiveLocked,
  handleSize,
  handleBorderWidth,
  selectionStrokeWidth,
  onSelect,
  onPointerDown,
  onResizeHandlePointerDown,
  onTextResizeHandlePointerDown,
  onOpenDetails,
  onOpenContextMenu,
  onEditText,
  onRenameNode,
  onUpdateText,
  onFinishTextEdit,
}: CanvasNodeViewProps) {
  const resolvedAssetUrl = useResolvedAssetUrl(node.assetUrl)
  const textNode = isTextNode(node)
  const frameNode = isFrameNode(node)
  const aiSlotNode = isAiSlotNode(node)
  const annotationNode = node.type === 'annotation'
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
    width: node.width,
    height: node.height,
    transform: `translate(${node.x}px, ${node.y}px)`,
    '--node-selection-stroke': `${selectionStrokeWidth}px`,
  }
  const nodeClassName = [
    'dom-node',
    textNode && 'text-node',
    frameNode && 'frame-node',
    aiSlotNode && 'ai-slot-node',
    annotationNode && 'annotation-node',
    emptyText && 'empty-text',
    editing && 'editing',
    effectiveLocked && 'locked-node',
    transparentImage && 'transparent-image-node',
    selected && 'selected',
    selectionPreview && 'selection-preview',
    sectionDropTarget && 'section-drop-target',
    node.status,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      data-node-id={node.id}
      data-section-id={node.sectionId}
      data-ai-kind={node.aiWorkflow?.kind}
      data-ai-operation={node.aiWorkflow?.operation}
      data-ai-source-node-ids={node.aiWorkflow?.sourceNodeIds?.join(',')}
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
        if (textNode) {
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
          style={
            {
              '--section-fill-color': node.sectionFillColor || '#ffffff',
              '--section-border-color': node.sectionBorderColor || node.frameColor || '#ff8a00',
              '--section-border-width': `${node.sectionBorderWidth ?? 2}px`,
              '--section-border-style': node.sectionBorderStyle || 'dashed',
            } as CSSProperties
          }
        >
          {node.sectionTitleVisible !== false ? <div className="dom-frame-title">{node.title}</div> : null}
        </div>
      ) : aiSlotNode ? (
        <div className="dom-ai-slot-node">
          <div>
            <strong>{node.title}</strong>
            <span>{node.aiWorkflow?.status === 'ready' ? 'Ready for another result' : 'Drop an AI result here'}</span>
          </div>
          <em>{node.width} x {node.height}</em>
        </div>
      ) : textNode ? (
        editing ? (
          <CanvasTextEditor node={node} onUpdateText={onUpdateText} onFinishTextEdit={onFinishTextEdit} />
        ) : (
          <div
            className={annotationNode ? 'dom-text-node dom-annotation-node' : 'dom-text-node'}
            style={{
              fontSize: node.fontSize || defaultTextFontSize,
              color: node.textColor || defaultTextColor,
              fontWeight: node.fontWeight || defaultTextWeight,
              textAlign: node.textAlign || defaultTextAlign,
            }}
          >
            {node.text}
          </div>
        )
      ) : (
        <div
          className={imageCrop ? 'dom-node-media cropped' : 'dom-node-media'}
          style={{ width: node.width, height: node.height }}
        >
          {isTaskNode(node) ? (
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
              draggable={false}
              style={imageCropStyle}
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
      {primarySelected && !editing && !textNode && !effectiveLocked ? (
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
}
