import { debugLogger } from '../store/debugLogStore'

/**
 * Phase 5 静态文本 spike flag(`?textPaint=`)。
 *
 * 默认 `dom`:text 节点(type='text',不含 annotation 类型)一律走 DOM 渲染,
 * 与 Phase 4 收官后的生产行为完全一致。`leafer` 仅供 Phase 5 golden fixture
 * spike 采集对照——leafer 模式下把 text 节点交给 Leafer Text 以 DOM 等价 props
 * 绘制,用 visual-diff `--fixture=text` 量化 CJK/断行/字重/对齐的像素差,
 * 判定文本去向(上 Leafer or 永久留 DOM)。
 *
 * 非法值回退 dom + warn;dom 模式(`?renderer=dom`)下本 flag 无效果。
 */

export type TextPaintMode = 'dom' | 'leafer'

const VALID_MODES: ReadonlySet<string> = new Set(['dom', 'leafer'])

const parseTextPaintModeFromUrl = (): TextPaintMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return 'dom'

  const raw = new URLSearchParams(window.location.search).get('textPaint')
  if (!raw) return 'dom'

  const normalized = raw.trim().toLowerCase()
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Renderer', `未知 textPaint mode "${raw}",回退 dom`)
    return 'dom'
  }

  if (normalized === 'leafer') {
    debugLogger.log('Renderer', 'Phase 5 text spike active: text 节点由 Leafer Text 绘制(golden fixture 对照用)')
    return 'leafer'
  }

  return 'dom'
}

export const textPaintMode: TextPaintMode = parseTextPaintModeFromUrl()
export const isLeaferTextPaintRequested = textPaintMode === 'leafer'
