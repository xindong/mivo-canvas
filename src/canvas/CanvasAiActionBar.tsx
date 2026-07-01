import { Brush, MousePointer2, Sparkles } from 'lucide-react'
import { useCanvasStore } from '../store/canvasStore'
import type { MivoCanvasNode } from '../types/mivoCanvas'

type CanvasAiActionBarProps = {
  selectedNode?: MivoCanvasNode
  maskEditActive?: boolean
  onOpenGeneratePanel: () => void
  onStartMaskEdit?: (nodeId: string) => void
  onCancelMaskEdit?: () => void
}

export function CanvasAiActionBar({
  selectedNode,
  maskEditActive = false,
  onOpenGeneratePanel,
  onStartMaskEdit,
  onCancelMaskEdit,
}: CanvasAiActionBarProps) {
  const activeTool = useCanvasStore((state) => state.activeTool)
  const setActiveTool = useCanvasStore((state) => state.setActiveTool)
  const canStartMaskEdit = selectedNode?.type === 'image' && !selectedNode.hidden

  return (
    <div
      className="canvas-ai-action-bar"
      data-canvas-ui="true"
      aria-label="AI canvas actions"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={activeTool === 'select' && !maskEditActive ? 'active' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (maskEditActive) onCancelMaskEdit?.()
          setActiveTool('select')
        }}
        aria-label="选择/移动"
        title="选择/移动"
      >
        <MousePointer2 size={18} />
        <span>选择</span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setActiveTool('select')
          onOpenGeneratePanel()
        }}
        aria-label="生成"
        title="生成"
      >
        <Sparkles size={18} />
        <span>生成</span>
      </button>
      <button
        type="button"
        className={maskEditActive ? 'active' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          if (!canStartMaskEdit || !selectedNode) return
          setActiveTool('select')
          onStartMaskEdit?.(selectedNode.id)
        }}
        disabled={!canStartMaskEdit}
        aria-label="局部重绘"
        title={canStartMaskEdit ? '局部重绘' : '先选择一张图片'}
      >
        <Brush size={18} />
        <span>局部重绘</span>
      </button>
      {!canStartMaskEdit ? <span className="canvas-ai-action-hint">先选择图片</span> : null}
    </div>
  )
}
