import { useCanvasStore } from '../store/canvasStore'
import { stampDefinitions } from './stampDefs'

export function StampOptionsBar() {
  const activeStampKind = useCanvasStore((state) => state.activeStampKind)
  const setActiveStampKind = useCanvasStore((state) => state.setActiveStampKind)

  return (
    <div className="stamp-options-bar" aria-label="Stamp options" data-canvas-ui="true">
      <div className="brush-options-group" role="radiogroup" aria-label="Stamp">
        {stampDefinitions.map((definition) => (
          <button
            key={definition.kind}
            type="button"
            role="radio"
            aria-checked={activeStampKind === definition.kind}
            className={activeStampKind === definition.kind ? 'active' : ''}
            onClick={() => setActiveStampKind(definition.kind)}
            aria-label={`Stamp ${definition.label}`}
            title={definition.label}
          >
            <span className="stamp-option-emoji">{definition.emoji}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
