import { AlignCenter, AlignLeft, AlignRight, Bold, Minus, Plus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import {
  defaultTextAlign,
  defaultTextColor,
  defaultTextFontSize,
  defaultTextWeight,
  textGeometryFor,
  type TextAlignment,
} from './textGeometry'

type TextFormatToolbarProps = {
  node: MivoCanvasNode
  scale: number
}

const textColors = ['#232323', '#6957e8', '#b9473a', '#557463']
const alignOptions: Array<[TextAlignment, LucideIcon]> = [
  ['left', AlignLeft],
  ['center', AlignCenter],
  ['right', AlignRight],
]

export function TextFormatToolbar({ node, scale }: TextFormatToolbarProps) {
  const updateTextStyle = useCanvasStore((state) => state.updateTextStyle)
  const fontSize = node.fontSize || defaultTextFontSize
  const fontWeight = node.fontWeight || defaultTextWeight
  const textColor = node.textColor || defaultTextColor
  const textAlign = node.textAlign || defaultTextAlign

  const updateStyle = (
    style: Pick<Partial<MivoCanvasNode>, 'fontSize' | 'textColor' | 'fontWeight' | 'textAlign'>,
  ) => {
    const nextFontSize = style.fontSize || fontSize
    const nextFontWeight = style.fontWeight || fontWeight
    const geometry = textGeometryFor(
      node.text || '',
      nextFontSize,
      node.textAutoWidth === false ? node.width : undefined,
      nextFontWeight,
    )
    updateTextStyle(node.id, style, geometry)
  }

  const setAlignment = (alignment: TextAlignment) => updateStyle({ textAlign: alignment })

  return (
    <div
      className="text-format-toolbar"
      data-canvas-ui="true"
      style={{
        left: node.x + node.width / 2,
        top: node.y - 12,
        transform: `translate(-50%, -100%) scale(${1 / scale})`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" aria-label="Decrease text size" onClick={() => updateStyle({ fontSize: Math.max(12, fontSize - 2) })}>
        <Minus size={14} />
      </button>
      <span className="text-size-readout">{fontSize}</span>
      <button type="button" aria-label="Increase text size" onClick={() => updateStyle({ fontSize: Math.min(72, fontSize + 2) })}>
        <Plus size={14} />
      </button>
      <span className="text-format-divider" />
      <button
        type="button"
        className={fontWeight >= 700 ? 'active' : ''}
        aria-label="Toggle bold"
        onClick={() => updateStyle({ fontWeight: fontWeight >= 700 ? 500 : 700 })}
      >
        <Bold size={15} />
      </button>
      <span className="text-format-divider" />
      {alignOptions.map(([alignment, Icon]) => (
        <button
          key={alignment}
          type="button"
          className={textAlign === alignment ? 'active' : ''}
          aria-label={`Align text ${alignment}`}
          onClick={() => setAlignment(alignment)}
        >
          <Icon size={15} />
        </button>
      ))}
      <span className="text-format-divider" />
      {textColors.map((color) => (
        <button
          key={color}
          type="button"
          className={textColor.toLowerCase() === color ? 'active color' : 'color'}
          aria-label={`Set text color ${color}`}
          onClick={() => updateStyle({ textColor: color })}
        >
          <span style={{ background: color }} />
        </button>
      ))}
    </div>
  )
}
