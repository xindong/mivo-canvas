// 从 ImageMaskEditOverlay 机械抽离(structure guard >900),行为不变。
// 浮层定位:测量 stage/shell/toolbar/prompt 真实尺寸,算浮层左/宽/工具条顶/
// prompt 顶,避开抽屉侧栏,夹在画布内。refs 以参数传入(不改创建位置与身份);
// 调用点时序不动(overlay 保留 useCallback 薄包装,effect deps 与 raf/observer
// 回调不变)。
import type { Dispatch, RefObject, SetStateAction } from 'react'

export type FloatingControlsLayout = {
  left: number
  width: number
  toolbarTop: number
  promptTop: number
}

const floatingControlsMargin = 12
const floatingControlsGap = 10
const floatingToolbarHeight = 114
// 加宽（用户 2026-07-07）：4 个工具按钮 + 关闭要能在一排放下，不换行；顺带让
// prompt 描述少折行。竖图时浮层宽度以前只有 ~320，「点选」会被挤到第二行。
const floatingControlsMinWidth = 400
const floatingControlsMaxWidth = 480

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function computeFloatingControls({
  stageRef,
  toolbarRef,
  promptRef,
  setFloatingHost,
  setFloatingLayout,
}: {
  stageRef: RefObject<HTMLDivElement | null>
  toolbarRef: RefObject<HTMLDivElement | null>
  promptRef: RefObject<HTMLDivElement | null>
  setFloatingHost: Dispatch<SetStateAction<HTMLElement | null>>
  setFloatingLayout: Dispatch<SetStateAction<FloatingControlsLayout | undefined>>
}) {
  const stage = stageRef.current
  const shell = stage?.closest('.canvas-shell') as HTMLElement | null
  if (!stage || !shell) return

  const stageRect = stage.getBoundingClientRect()
  const shellRect = shell.getBoundingClientRect()
  // 抽屉侧栏(position:fixed, z-index 80)浮在画布之上,会盖住浮层左半。测出它的
  // 右边界,把浮层左界推到抽屉右侧,避免工具条钻到栏后无法操作。
  let leftBound = floatingControlsMargin
  const drawer = shell.ownerDocument.querySelector('.project-sidebar.drawer:not(.closed)') as HTMLElement | null
  if (drawer) {
    const drawerRect = drawer.getBoundingClientRect()
    if (drawerRect.width > 0 && drawerRect.right > shellRect.left) {
      leftBound = Math.max(leftBound, drawerRect.right - shellRect.left + floatingControlsGap)
    }
  }
  const maxWidth = Math.max(floatingControlsMinWidth, shellRect.width - leftBound - floatingControlsMargin)
  const width = Math.min(floatingControlsMaxWidth, maxWidth, Math.max(floatingControlsMinWidth, stageRect.width))
  const stageLeft = stageRect.left - shellRect.left
  const stageTop = stageRect.top - shellRect.top
  const stageBottom = stageTop + stageRect.height
  const left = clamp(
    stageLeft + stageRect.width / 2 - width / 2,
    leftBound,
    Math.max(leftBound, shellRect.width - width - floatingControlsMargin),
  )
  // 真实测量高度优先（挂载后可得），首帧回退到常量估算。prompt 面板仅在有锚点时
  // 渲染（promptRef 为 null），此时不预留它的高度，工具条独立定位。
  const toolbarHeight = toolbarRef.current?.offsetHeight || floatingToolbarHeight
  const promptEl = promptRef.current
  const promptHeight = promptEl ? promptEl.offsetHeight : 0
  const promptGap = promptEl ? floatingControlsGap : 0
  const stackHeight = toolbarHeight + promptGap + promptHeight
  const minStackTop = floatingControlsMargin
  const maxStackTop = Math.max(floatingControlsMargin, shellRect.height - stackHeight - floatingControlsMargin)
  const belowStackTop = stageBottom + floatingControlsGap
  const aboveStackTop = stageTop - stackHeight - floatingControlsGap
  const stackTop =
    belowStackTop <= maxStackTop
      ? belowStackTop
      : aboveStackTop >= minStackTop
        ? aboveStackTop
        : clamp(belowStackTop, minStackTop, maxStackTop)
  const toolbarTop = stackTop
  const promptTop = stackTop + toolbarHeight + promptGap

  setFloatingHost(shell)
  setFloatingLayout((current) => {
    const nextLayout = {
      left: Math.round(left),
      width: Math.round(width),
      toolbarTop: Math.round(toolbarTop),
      promptTop: Math.round(promptTop),
    }
    return current &&
      current.left === nextLayout.left &&
      current.width === nextLayout.width &&
      current.toolbarTop === nextLayout.toolbarTop &&
      current.promptTop === nextLayout.promptTop
      ? current
      : nextLayout
  })
}
