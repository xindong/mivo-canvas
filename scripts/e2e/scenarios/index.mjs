import { runAiSlotPlaceholderScenario } from './ai-slot-placeholder.mjs'
import { runAnchorMvpScenario } from './anchor-mvp.mjs'
import { runArchiveAssetsScenario } from './archive-assets.mjs'
import { runMaskReflowScenario } from './mask-reflow.mjs'
import { runCanvasInteractionsScenario } from './canvas-interactions.mjs'
import { runChangelogScenario } from './changelog.mjs'
import { runChatGenerationScenario } from './chat-generation.mjs'
import { runChatCopyScenario } from './chat-copy.mjs'
import { runCoordinateProbeScenario } from './coordinate-probe.mjs'
import { runDebugScenario } from './debug.mjs'
import { runMaskScenario } from './mask.mjs'
import { runMaskBlackblockScenario } from './mask-blackblock.mjs'
import { runMaskConcurrentScenario } from './mask-concurrent.mjs'
import { runMaskCrossSceneScenario } from './mask-cross-scene.mjs'
import { runMaskHydrationScenario } from './mask-hydration.mjs'
import { runMaskPointScenario } from './mask-point.mjs'
import { runMaskSourceDeleteScenario } from './mask-source-delete.mjs'
import { runMarkupTextOverlayScenario } from './markup-text-overlay.mjs'
import { runMaskTimeoutRetryScenario } from './mask-timeout-retry.mjs'
import { runMigrationScenario } from './migration.mjs'
import { runShellSidebarScenario } from './shell-sidebar.mjs'
import { runVariationsAnnotationScenario } from './variations-annotation.mjs'
import { runZoomToolScenario } from './zoom-tool.mjs'

export const scenarioOrder = [
  'debug',
  'shell-sidebar',
  'changelog',
  'archive-assets',
  'canvas-interactions',
  'markup-text-overlay',
  'zoom-tool',
  'chat-generation',
  'chat-copy',
  'mask',
  'migration',
  'anchor-mvp',
  'variations-annotation',
  'ai-slot-placeholder',
  'mask-reflow',
  'mask-point',
  'mask-blackblock',
  'mask-cross-scene',
  'mask-concurrent',
  'mask-source-delete',
  'mask-timeout-retry',
  'mask-hydration',
  'coordinate-probe',
]

// leafer 模式显式 skip 名单(带理由,e2e-smoke 读取)。原则:只有当场景的断言
// 主体是"dom 渲染器的 DOM 结构契约"(选择框/句柄/类名/布局几何全靠 .dom-node
// 表达)、且等价交互证据已由其他 leafer 场景覆盖时,才允许 skip;凡是能用
// store 状态 / data-leafer-* 观测属性 / 坐标点击表达的,一律改造不 skip。
export const leaferSkippedScenarios = {
  'canvas-interactions':
    'DOM 渲染器结构契约场景:~180 处断言直接校验 .dom-node 的类名/布局/选择态/拖拽句柄 DOM 结构,是 dom 渲染路径自身的回归契约;leafer 模式下 image/frame/markup 无 DOM 表达,该契约不适用。leafer 侧等价交互证据:选中/点击(mask 系列+chat-generation)、双击编辑(markup-text-overlay)、几何投影(coordinate-probe/zoom-tool)、节点增删(variations-annotation/anchor-mvp)。',
}

export const scenarioBootstrapPredecessor = {
  'archive-assets': 'shell-sidebar',
  'canvas-interactions': 'archive-assets',
  'chat-generation': 'canvas-interactions',
  mask: 'chat-generation',
}

export const scenarioRunners = {
  'ai-slot-placeholder': runAiSlotPlaceholderScenario,
  'anchor-mvp': runAnchorMvpScenario,
  'archive-assets': runArchiveAssetsScenario,
  'mask-reflow': runMaskReflowScenario,
  'canvas-interactions': runCanvasInteractionsScenario,
  changelog: runChangelogScenario,
  'chat-generation': runChatGenerationScenario,
  'chat-copy': runChatCopyScenario,
  'coordinate-probe': runCoordinateProbeScenario,
  debug: runDebugScenario,
  mask: runMaskScenario,
  'mask-blackblock': runMaskBlackblockScenario,
  'mask-concurrent': runMaskConcurrentScenario,
  'mask-cross-scene': runMaskCrossSceneScenario,
  'mask-point': runMaskPointScenario,
  'mask-source-delete': runMaskSourceDeleteScenario,
  'mask-timeout-retry': runMaskTimeoutRetryScenario,
  'mask-hydration': runMaskHydrationScenario,
  'markup-text-overlay': runMarkupTextOverlayScenario,
  migration: runMigrationScenario,
  'shell-sidebar': runShellSidebarScenario,
  'variations-annotation': runVariationsAnnotationScenario,
  'zoom-tool': runZoomToolScenario,
}
