import { Eraser, Highlighter, Pencil } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import type { BrushToolMode } from '../types/mivoCanvas'
import { markupColorPresets } from './actions/canvasActionModel'
import { brushWidthPresets } from '../model/brushGeometry'

const brushKinds: Array<{ kind: BrushToolMode; label: string; icon: typeof Pencil }> = [
  { kind: 'marker', label: 'Marker', icon: Pencil },
  { kind: 'highlighter', label: 'Highlighter', icon: Highlighter },
  { kind: 'eraser', label: 'Eraser', icon: Eraser },
]

export function BrushOptionsBar() {
  const brushStyle = useCanvasStore((state) => state.brushStyle)
  const setBrushStyle = useCanvasStore((state) => state.setBrushStyle)
  const strokeOptionsDisabled = brushStyle.kind === 'eraser'

  return (
    <div className="brush-options-bar" aria-label="Brush options" data-canvas-ui="true">
      <div className="brush-options-group" role="radiogroup" aria-label="Brush kind">
        {brushKinds.map(({ kind, label, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={brushStyle.kind === kind}
            className={brushStyle.kind === kind ? 'active' : ''}
            onClick={() => setBrushStyle({ kind })}
            aria-label={label}
            title={label}
          >
            <Icon size={17} />
          </button>
        ))}
      </div>
      <span className="brush-options-divider" />
      <div className="brush-options-group" role="radiogroup" aria-label="Brush width">
        {brushWidthPresets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={brushStyle.width === preset.width}
            className={brushStyle.width === preset.width ? 'active' : ''}
            onClick={() => setBrushStyle({ width: preset.width })}
            aria-label={`Brush width ${preset.label}`}
            title={`${preset.label} (${preset.width}px)`}
            disabled={strokeOptionsDisabled}
          >
            <span
              className="brush-width-preview"
              style={{ height: Math.max(2, Math.min(10, preset.width)) }}
            />
          </button>
        ))}
      </div>
      <span className="brush-options-divider" />
      <div className="brush-options-group" role="radiogroup" aria-label="Brush color">
        {markupColorPresets.map((preset) => (
          <button
            key={preset.value}
            type="button"
            role="radio"
            aria-checked={brushStyle.color === preset.value}
            className={`brush-color-button ${brushStyle.color === preset.value ? 'active' : ''}`}
            onClick={() => setBrushStyle({ color: preset.value })}
            aria-label={`Brush color ${preset.label}`}
            title={preset.label}
            disabled={strokeOptionsDisabled}
          >
            <span className="brush-color-swatch" style={{ background: preset.value }} />
          </button>
        ))}
      </div>
    </div>
  )
}
