import { useCanvasStore } from '../store/canvasStore'
import { stampDefinitions } from './stampDefs'

// Inline horizontal sticker picker shown while the stamp tool is active.
export function StampOptionsBar() {
  const activeStampKind = useCanvasStore((state) => state.activeStampKind)
  const setActiveStampKind = useCanvasStore((state) => state.setActiveStampKind)

  return (
    <div className="stamp-options-bar" aria-label="Sticker options" data-canvas-ui="true">
      <div className="stamp-options-group" role="radiogroup" aria-label="Stickers">
        {stampDefinitions.map((definition) => (
          <button
            key={definition.kind}
            type="button"
            role="radio"
            aria-checked={activeStampKind === definition.kind}
            className={`stamp-option${activeStampKind === definition.kind ? ' active' : ''}`}
            onClick={() => setActiveStampKind(definition.kind)}
            aria-label={`Sticker ${definition.label}`}
            title={definition.label}
          >
            <img src={definition.src} alt="" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  )
}
