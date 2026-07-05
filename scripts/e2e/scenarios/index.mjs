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
  migration: runMigrationScenario,
  'shell-sidebar': runShellSidebarScenario,
  'variations-annotation': runVariationsAnnotationScenario,
  'zoom-tool': runZoomToolScenario,
}
