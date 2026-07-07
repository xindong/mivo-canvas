// 局部重绘「坐标 pin」图标(自绘变体,非 Lovart 复刻):头部圆更小、内点占比更大
// (r 2.75/6 vs 常见 3/8)、尾部收窄带内凹、顶部加一截定位刻线(pin + 坐标混合)。
// 几何常量共享给两处消费方 —— CanvasToolDock 的线框按钮版与 mask overlay 的
// 实心锚点版,保证两处形状一字不差。pin 尖端固定在 (12, 22),锚点定位以它为准。

const PIN_BODY_D = 'M12 22C10.4 18.9 6 14.8 6 10a6 6 0 1 1 12 0C18 14.8 13.6 18.9 12 22Z'
const PIN_DOT = { cx: 12, cy: 10, r: 2.75 }
const PIN_TICK = { x: 12, y1: 0.75, y2: 3 }
const PIN_TIP = { x: 12, y: 22 }
const PIN_VIEWBOX = 24

type MaskPointIconProps = {
  size?: number
  className?: string
}

// 工具条按钮版:线框风格对齐 lucide(currentColor / strokeWidth 2 / round cap)。
export function MaskPointIcon({ size = 20, className }: MaskPointIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${PIN_VIEWBOX} ${PIN_VIEWBOX}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PIN_BODY_D} />
      <circle cx={PIN_DOT.cx} cy={PIN_DOT.cy} r={PIN_DOT.r} fill="currentColor" stroke="none" />
      <line x1={PIN_TICK.x} y1={PIN_TICK.y1} x2={PIN_TICK.x} y2={PIN_TICK.y2} />
    </svg>
  )
}

type MaskPointMarkerProps = {
  tipX: number
  tipY: number
  viewportScale: number
  screenSize?: number
  /** Multi-anchor: 1-based number shown in the pin head, matching its input chip. */
  badge?: number
}

// mask overlay 锚点版:实心紫填充(配色走 App.css 的 .image-mask-edit-point-pin*),
// 按 viewportScale 反缩放 → 固定屏幕视觉大小,pin 尖端精确落在 (tipX, tipY)。
// 只负责视觉表达;重绘区域几何(pointMaskRadiusFor / maskBounds)与此无关。
// 多锚点:传 badge 时头部显示序号(与输入框标签块序号一一对应),替代内点圆。
export function MaskPointMarker({ tipX, tipY, viewportScale, screenSize = 26, badge }: MaskPointMarkerProps) {
  const scale = screenSize / PIN_VIEWBOX / Math.max(0.1, viewportScale)
  return (
    <g transform={`translate(${tipX - PIN_TIP.x * scale}, ${tipY - PIN_TIP.y * scale}) scale(${scale})`}>
      <path className="image-mask-edit-point-pin" d={PIN_BODY_D} />
      {typeof badge === 'number' ? (
        <text
          className="image-mask-edit-point-pin-badge"
          x={PIN_DOT.cx}
          y={PIN_DOT.cy}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {badge}
        </text>
      ) : (
        <circle className="image-mask-edit-point-pin-dot" cx={PIN_DOT.cx} cy={PIN_DOT.cy} r={PIN_DOT.r} />
      )}
      <line
        className="image-mask-edit-point-pin-tick"
        x1={PIN_TICK.x}
        y1={PIN_TICK.y1}
        x2={PIN_TICK.x}
        y2={PIN_TICK.y2}
      />
    </g>
  )
}
