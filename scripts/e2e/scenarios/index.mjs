import { runArchiveAssetsScenario } from './archive-assets.mjs'
import { runCanvasInteractionsScenario } from './canvas-interactions.mjs'
import { runChatGenerationScenario } from './chat-generation.mjs'
import { runDebugScenario } from './debug.mjs'
import { runMaskScenario } from './mask.mjs'
import { runMigrationScenario } from './migration.mjs'
import { runShellSidebarScenario } from './shell-sidebar.mjs'

export const scenarioOrder = [
  'debug',
  'shell-sidebar',
  'archive-assets',
  'canvas-interactions',
  'chat-generation',
  'mask',
  'migration',
] 

export const scenarioBootstrapPredecessor = {
  'archive-assets': 'shell-sidebar',
  'canvas-interactions': 'archive-assets',
  'chat-generation': 'canvas-interactions',
  mask: 'chat-generation',
}

export const scenarioRunners = {
  'archive-assets': runArchiveAssetsScenario,
  'canvas-interactions': runCanvasInteractionsScenario,
  'chat-generation': runChatGenerationScenario,
  debug: runDebugScenario,
  mask: runMaskScenario,
  migration: runMigrationScenario,
  'shell-sidebar': runShellSidebarScenario,
}
