import { runAiSlotPlaceholderScenario } from './ai-slot-placeholder.mjs'
import { runAnchorMvpScenario } from './anchor-mvp.mjs'
import { runArchiveAssetsScenario } from './archive-assets.mjs'
import { runMaskReflowScenario } from './mask-reflow.mjs'
import { runCanvasInteractionsScenario } from './canvas-interactions.mjs'
import { runChatGenerationScenario } from './chat-generation.mjs'
import { runDebugScenario } from './debug.mjs'
import { runMaskScenario } from './mask.mjs'
import { runMaskPointScenario } from './mask-point.mjs'
import { runMigrationScenario } from './migration.mjs'
import { runShellSidebarScenario } from './shell-sidebar.mjs'
import { runVariationsAnnotationScenario } from './variations-annotation.mjs'
import { runZoomToolScenario } from './zoom-tool.mjs'

export const scenarioOrder = [
  'debug',
  'shell-sidebar',
  'archive-assets',
  'canvas-interactions',
  'zoom-tool',
  'chat-generation',
  'mask',
  'migration',
  'anchor-mvp',
  'variations-annotation',
  'ai-slot-placeholder',
  'mask-reflow',
  'mask-point',
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
  'chat-generation': runChatGenerationScenario,
  debug: runDebugScenario,
  mask: runMaskScenario,
  'mask-point': runMaskPointScenario,
  migration: runMigrationScenario,
  'shell-sidebar': runShellSidebarScenario,
  'variations-annotation': runVariationsAnnotationScenario,
  'zoom-tool': runZoomToolScenario,
}
