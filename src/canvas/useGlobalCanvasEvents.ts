import { useEffect, useRef } from 'react'
import type { RuntimeCanvasTool } from './canvasInteraction'
import type { SnapGuide } from './canvasGeometry'
import { hasActiveTextSelection, isEditingTarget } from './canvasInteraction'
import { toolForKeyboardShortcut } from './canvasToolRegistry'
import { importImageFileToCanvas } from '../lib/canvasAssetImport'
import { useCanvasStore } from '../store/canvasStore'
import { wrapMutation } from './actions/canvasSyncRuntime'
import { createArrowNudgeThrottle, type ArrowKey } from './arrowNudgeThrottle'

// #arrowflood P1(Greptile:键盘选区/画布切换未结算)— handleKeyDown 顶部通用前置 flush 的键集合。
//   ARROW_KEYS:burst 内合法 keydown(节流自身处理,不应 flush 自打断)。
//   MODIFIER_KEYS:纯修饰键;shift-arrow(10px 步长)是 burst 内合法组合,Shift 按下不应打断 burst。
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt'])

export type GlobalEventsApi = {
  maskEditNodeId: string | undefined
  onCancelMaskEdit: (() => void) | undefined
  onCloseContextMenu: () => void
  setTemporaryTool: (tool: RuntimeCanvasTool | undefined) => void
  setEditingTextNodeId: (id: string | undefined) => void
  setSnapGuides: (guides: SnapGuide[]) => void
  setActiveConnectorDropTargetId: (id: string | undefined) => void
  setZoomOutCursor: (active: boolean) => void
  zoomBy: (factor: number, center?: { clientX: number; clientY: number }) => void
  zoomTo: (scale: number, center?: { clientX: number; clientY: number }) => void
  fitAll: () => void
  fitSelection: () => void
  viewportCenter: () => { x: number; y: number }
  resetMarquee: () => void
  resetNodeTransform: () => void
  resetPan: () => void
  resetTextAnnotation: () => void
  resetBrushStamp: () => void
  resetGroupTransform: () => void
  resetZoomGesture: () => void
}

// Global window keyboard / wheel / paste / blur handling. Extracted from
// useCanvasInteractionController (F7 global-events gap). Store actions are read
// via getState() inside the handlers (same as the original, which used getState
// for cmd+a / activeTool / brushStyle to avoid re-subscribing on every node
// change). Non-store callbacks arrive via `api`.
export function useGlobalCanvasEvents(api: GlobalEventsApi) {
  const {
    maskEditNodeId,
    onCancelMaskEdit,
    onCloseContextMenu,
    setTemporaryTool,
    setEditingTextNodeId,
    setSnapGuides,
    setActiveConnectorDropTargetId,
    setZoomOutCursor,
    zoomBy,
    zoomTo,
    fitAll,
    fitSelection,
    viewportCenter,
    resetMarquee,
    resetNodeTransform,
    resetPan,
    resetTextAnnotation,
    resetBrushStamp,
    resetGroupTransform,
    resetZoomGesture,
  } = api
  const pressedTemporaryToolsRef = useRef<RuntimeCanvasTool[]>([])

  useEffect(() => {
    const pressTemporaryTool = (tool: RuntimeCanvasTool) => {
      const pressedTools = pressedTemporaryToolsRef.current.filter((item) => item !== tool)
      pressedTools.push(tool)
      pressedTemporaryToolsRef.current = pressedTools
      setTemporaryTool(tool)
    }

    const releaseTemporaryTool = (tool: RuntimeCanvasTool) => {
      const pressedTools = pressedTemporaryToolsRef.current.filter((item) => item !== tool)
      pressedTemporaryToolsRef.current = pressedTools
      setTemporaryTool(pressedTools.at(-1))
    }

    const resetTemporaryTools = () => {
      pressedTemporaryToolsRef.current = []
      setTemporaryTool(undefined)
    }

    // #arrowflood:方向键连按节流。burst 期间裸 move(即时视觉、零 submit),松键/blur/卸载
    //   settle 一次。settle = reset 回 before-burst + wrapMutation 重放累计 delta → 单次 submitChange
    //   (server);local 模式 wrapMutation 命中 local gate → 不 submit(零回归)。多键同按:全部释放才结算。
    const arrowThrottle = createArrowNudgeThrottle({
      moveBy: (dx, dy) => useCanvasStore.getState().moveSelectedNodesBy(dx, dy),
      settle: (accDx, accDy) => {
        if (accDx === 0 && accDy === 0) return
        const store = useCanvasStore.getState()
        // reset 回 before-burst(裸 move,不 submit)。moveSelectedNodesBy 是纯位置 delta,对相同选区
        //   -acc 精确回退(selection 在 burst 内由其保持,故可逆)。
        store.moveSelectedNodesBy(-accDx, -accDy)
        // 一次性重放:wrapMutation snapshot(reset 后=before-burst)→ apply +acc → final,单次 submit。
        wrapMutation(store.moveSelectedNodesBy)(accDx, accDy)
      },
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditingTarget(event.target)) return

      // #arrowflood P1 续修(Greptile:键盘选区切换未结算):非方向键、非纯修饰键的任意 keydown 先 flush
      //   pending 方向键 burst。burst 期间对 A 的裸移动零 submit;若用户在 burst 中按 Escape(清选区,见下方
      //   Escape 分支 selectNode(undefined))或 Cmd+A(扩选区)等改变选区/场景的键,不先 flush 则 settle 会
      //   作用于实时选区(空 or 扩大)→ A 的累计位移 -acc/+acc 双 no-op 或作用于错误选区,永不提交,刷新后
      //   A 回退(pointerdown capture flush 已覆盖鼠标路径 #arrowflood P1 首修,本 guard 补键盘路径,不再靠
      //   逐键枚举跟维护)。排除纯修饰键(Shift/Meta/Control/Alt):shift-arrow(10px 步长)是 burst 内合法
      //   组合,Shift 按下不应打断 burst。flush 的 acc=0 idempotent guard 保证普通打键零开销。不动
      //   arrowNudgeThrottle.ts 纯模块(flush 语义已正确)。
      if (!ARROW_KEYS.has(event.key) && !MODIFIER_KEYS.has(event.key)) {
        arrowThrottle.flush()
      }

      const store = useCanvasStore.getState()
      const modifier = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      setZoomOutCursor(event.altKey || event.key === 'Alt')

      if (event.code === 'Space') {
        event.preventDefault()
        if (!event.repeat) pressTemporaryTool('hand')
        return
      }

      if (event.code === 'KeyZ' && !modifier && !event.repeat) {
        event.preventDefault()
        pressTemporaryTool('zoom')
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        if (maskEditNodeId) {
          onCancelMaskEdit?.()
          return
        }
        onCloseContextMenu()
        resetMarquee()
        resetNodeTransform()
        resetGroupTransform()
        resetTextAnnotation()
        resetBrushStamp()
        resetZoomGesture()
        setEditingTextNodeId(undefined)
        setSnapGuides([])
        setActiveConnectorDropTargetId(undefined)
        store.selectNode(undefined)
        if (store.activeTool !== 'select') store.setActiveTool('select')
        return
      }

      if (modifier && (event.key === '=' || event.key === '+' || event.code === 'Equal')) {
        event.preventDefault()
        zoomBy(1.12)
        return
      }

      if (modifier && (event.key === '-' || event.code === 'Minus')) {
        event.preventDefault()
        zoomBy(1 / 1.12)
        return
      }

      if (modifier && event.code === 'Digit0') {
        event.preventDefault()
        zoomTo(1)
        return
      }

      if (!modifier && !event.altKey && (event.key === '=' || event.key === '+' || event.code === 'Equal' || event.code === 'NumpadAdd')) {
        event.preventDefault()
        zoomBy(1.12)
        return
      }

      if (!modifier && !event.altKey && (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract')) {
        event.preventDefault()
        zoomBy(1 / 1.12)
        return
      }

      if (!modifier && event.shiftKey && event.code === 'Digit1') {
        event.preventDefault()
        fitAll()
        return
      }

      if (!modifier && event.shiftKey && event.code === 'Digit2') {
        event.preventDefault()
        fitSelection()
        return
      }

      if (modifier && key === 'z') {
        event.preventDefault()
        // A2 SC:undo/redo 是 document mutation(documentSlice),经 wrapMutation 包(snapshot-diff →
        //   inverse-diff change flow,server 收 inverse DomainOp 对齐;无需特殊 undo command)。
        if (event.shiftKey) wrapMutation(store.redo)()
        else wrapMutation(store.undo)()
        return
      }

      if (modifier && key === 'a') {
        event.preventDefault()
        // Read nodes via getState so this effect does not re-subscribe on every node change.
        const allNodes = store.nodes
        store.selectNodes(allNodes.filter((node) => !node.hidden).map((node) => node.id))
        return
      }

      if (modifier && key === 'c') {
        // 有活动文字选区(chat 气泡等)→ 放行系统复制;preventDefault 会吞掉它。
        if (hasActiveTextSelection()) return
        event.preventDefault()
        store.copySelectedNodes()
        return
      }

      if (modifier && key === 'x') {
        if (hasActiveTextSelection()) return
        event.preventDefault()
        // A2 SC:cut = copy + delete(document mutation),经 wrapMutation 包(delete 部分落 submitChange)。
        wrapMutation(store.cutSelectedNodes)()
        return
      }

      if (modifier && key === 'g') {
        event.preventDefault()
        // A2 SC:group/ungroup 改 parentIds(document mutation),经 wrapMutation 包。
        if (event.shiftKey) wrapMutation(store.ungroupSelectedNodes)()
        else wrapMutation(store.groupSelectedNodes)()
        return
      }

      if (modifier && key === 'd') {
        event.preventDefault()
        wrapMutation(store.duplicateSelectedNodes)()
        return
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        wrapMutation(store.deleteSelectedNodes)()
        return
      }

      if (event.key === '[') {
        event.preventDefault()
        // A2 SC:moveSelectedLayer 改 orderKey(document mutation),经 wrapMutation 包(取参包)。
        wrapMutation(store.moveSelectedLayer)(event.shiftKey ? 'back' : 'backward')
        return
      }

      if (event.key === ']') {
        event.preventDefault()
        wrapMutation(store.moveSelectedLayer)(event.shiftKey ? 'front' : 'forward')
        return
      }

      if (!modifier && key === 'e') {
        event.preventDefault()
        store.setActiveTool('markup-brush')
        if (store.brushStyle.kind !== 'eraser') store.setBrushStyle({ kind: 'eraser' })
        return
      }

      const shortcutTool = modifier ? undefined : toolForKeyboardShortcut(key)
      if (shortcutTool) {
        event.preventDefault()
        store.setActiveTool(shortcutTool)
        if (shortcutTool === 'markup-brush') {
          // P always means "draw": leaving eraser mode goes back to the marker.
          if (store.brushStyle.kind === 'eraser') store.setBrushStyle({ kind: 'marker' })
        }
        return
      }

      // 方向键:经 arrowThrottle 节流(#arrowflood)。原逐 keydown wrapMutation 路径已下线 ——
      //   防按住方向键 OS key-repeat ~30Hz 走 wrapMutation = 全画布 snapshot×2 + diff × repeat +
      //   ~30Hz submitChange 队列(server 模式 #256 后成现实体验问题)。burst 期间裸 move(即时视觉、
      //   零 submit),松键/blur/卸载时 throttle 内部 settle 一次(单次 submitChange)。
      if (ARROW_KEYS.has(event.key)) {
        event.preventDefault()
        arrowThrottle.onKeyDown(event.key as ArrowKey, event.shiftKey)
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      setZoomOutCursor(event.altKey && event.key !== 'Alt')

      if (event.code === 'Space') {
        event.preventDefault()
        releaseTemporaryTool('hand')
      }

      if (event.code === 'KeyZ') {
        event.preventDefault()
        releaseTemporaryTool('zoom')
      }

      // 方向键 keyup:移出按住集合,全部释放时结算 burst(单次 submitChange;#arrowflood)。
      if (ARROW_KEYS.has(event.key)) {
        arrowThrottle.onKeyUp(event.key as ArrowKey)
      }
    }

    const handleWindowBlur = () => {
      // 焦点丢失:结算任何 pending 方向键 burst(防丢最终位置;#arrowflood)。
      arrowThrottle.onBlur()
      resetTemporaryTools()
      setZoomOutCursor(false)
      resetPan()
      resetMarquee()
      resetNodeTransform()
      resetGroupTransform()
      resetTextAnnotation()
      resetBrushStamp()
      resetZoomGesture()
      setEditingTextNodeId(undefined)
      setActiveConnectorDropTargetId(undefined)
    }

    // #arrowflood P1(Greptile:结算目标随实时选区漂移):pointerdown 在 capture 阶段(先于画布/选区/
    //   侧栏 click→selectNode/openCanvas 的 bubble handler)先 flush pending 方向键 burst。burst 期间对 A
    //   的裸移动零 submit;若用户在 burst 中点击换选区到 B 或切画布,不先 flush 则 settle 会作用于实时选区
    //   (已是 B)→ A 的累计位移永不提交,刷新/重连后 A 回退(节流引入的新回归窗口)。pointerdown 先行使
    //   settle 仍落在 A(选区/场景未变),server 收到 A 的正确位移。flush 内 idempotent guard:无 pending
    //   burst时 acc=0 no-op,不误伤普通点击。键盘/程序化切选区/画布路径当前不存在(grep 无键盘切画布入口),
    //   若未来引入需在 store 层补「按 ids move」(超出本 fix boundary)。
    const handlePointerDown = () => {
      arrowThrottle.flush()
    }

    const handlePaste = async (event: ClipboardEvent) => {
      if (isEditingTarget(event.target)) return

      const store = useCanvasStore.getState()
      if (store.clipboardAssets.length) {
        event.preventDefault()
        // A2 SC:pasteClipboardAssets 创建 image nodes(document mutation),经 wrapMutation 包
        //   (lambda 包保 viewportCenter() 落点,同 #244 pasteClipboardNodes 模式)。
        wrapMutation(() => store.pasteClipboardAssets(viewportCenter()))()
        return
      }

      const items = Array.from(event.clipboardData?.items || [])
      const imageItem = items.find((item) => item.type.startsWith('image/'))

      if (imageItem) {
        const file = imageItem.getAsFile()
        if (!file) return

        event.preventDefault()
        const namedFile = file.name
          ? file
          : new File([file], `clipboard-${Date.now()}.png`, { type: file.type || 'image/png' })
        const center = viewportCenter()
        await importImageFileToCanvas({
          file: namedFile,
          position: center,
          addImportedImage: store.addImportedImage,
        })
        return
      }

      if (store.clipboardNodes.length) {
        event.preventDefault()
        wrapMutation(() => store.pasteClipboardNodes())()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    // capture:先于 bubble 阶段的 click→selectNode/openCanvas,保证 flush 在选区/场景切换前发生(#arrowflood P1)。
    window.addEventListener('pointerdown', handlePointerDown, { capture: true })
    window.addEventListener('paste', handlePaste)

    return () => {
      // 组件卸载 / effect 重跑:结算 pending 方向键 burst,保证不丢最终位置(#arrowflood)。
      arrowThrottle.flush()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
      // capture 标志须与 add 一致,确保能正确移除 listener(#arrowflood P1)。
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true })
      window.removeEventListener('paste', handlePaste)
    }
  }, [
    fitAll,
    fitSelection,
    maskEditNodeId,
    onCancelMaskEdit,
    onCloseContextMenu,
    resetBrushStamp,
    resetGroupTransform,
    resetMarquee,
    resetNodeTransform,
    resetPan,
    resetTextAnnotation,
    resetZoomGesture,
    setActiveConnectorDropTargetId,
    setEditingTextNodeId,
    setSnapGuides,
    setTemporaryTool,
    setZoomOutCursor,
    viewportCenter,
    zoomBy,
    zoomTo,
  ])
}
