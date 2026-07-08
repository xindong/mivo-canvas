import { readFile } from 'node:fs/promises'

const checks = []

const read = (file) => readFile(file, 'utf8')

const requireIncludes = (source, needle, label) => {
  if (!source.includes(needle)) {
    throw new Error(`${label} should include ${needle}`)
  }
}

const requireLoggerLevels = (source, label) => {
  for (const call of ['debugLogger.log', 'debugLogger.warn', 'debugLogger.error']) {
    requireIncludes(source, call, label)
  }
}

checks.push(async () => {
  const packageJson = JSON.parse(await read('package.json'))
  if (packageJson.scripts?.['verify:logging'] !== 'node scripts/verify-debug-logging.mjs') {
    throw new Error('package.json should expose npm run verify:logging')
  }
})

checks.push(async () => {
  const docs = await read('docs/development-logging.md')
  for (const phrase of [
    'User-facing feature flows that change app state',
    'Actions that need immediate user acknowledgement must use the global toast feedback API',
    'can be toast-only',
    'debugLogger.log',
    'debugLogger.warn',
    'debugLogger.error',
    'toastFeedback.success',
    'toastFeedback.info',
    'toastFeedback.warn',
    'toastFeedback.error',
    'npm run verify:logging',
  ]) {
    requireIncludes(docs, phrase, 'Development logging documentation')
  }
})

checks.push(async () => {
  // The detailed rule text lives in docs/product-notes.md; the README keeps a link to the rule doc.
  const readme = await read('README.md')
  requireIncludes(readme, 'docs/development-logging.md', 'README')

  const productNotes = await read('docs/product-notes.md')
  requireIncludes(productNotes, 'Development Feedback Rule', 'Product notes')
  requireIncludes(productNotes, 'development-logging.md', 'Product notes')
  requireIncludes(productNotes, 'toastFeedback', 'Product notes')
})

checks.push(async () => {
  const store = await read('src/store/debugLogStore.ts')
  for (const level of ["'log'", "'warning'", "'error'"]) {
    requireIncludes(store, level, 'Debug Log store')
  }
  requireLoggerLevels(store, 'Debug Log store')
})

checks.push(async () => {
  const store = await read('src/store/toastStore.ts')
  for (const level of ["'success'", "'info'", "'warning'", "'error'"]) {
    requireIncludes(store, level, 'Toast feedback store')
  }
  for (const call of ['success:', 'info:', 'warn:', 'error:']) {
    requireIncludes(store, call, 'Toast feedback store')
  }
})

checks.push(async () => {
  requireLoggerLevels(await read('src/store/canvasStore.ts'), 'Canvas store')
  requireLoggerLevels(await read('src/app/LibraryWorkspace.tsx'), 'Library workspace')
})

// E2: settings UI = UserChip (sidebar bottom) + SettingsPanel / GatewayKeyDialog /
// MivoKeySection. The old settingsMenuItems stub menu + handleSettingsMenuItem
// warn-only handler were deleted (replaced by the user chip). Each new user-
// triggered action is logged through debugLogger: login / open-settings / logout /
// disconnect / gateway test(fail warn, ok log, error) / mivo+gateway save (in slice).
checks.push(async () => {
  const sidebar = await read('src/app/ProjectSidebar.tsx')
  requireIncludes(sidebar, 'UserChip', 'Project sidebar user chip mount')

  const userChip = await read('src/app/settings/UserChip.tsx')
  requireIncludes(userChip, "debugLogger.log('Auth'", 'UserChip login action log')
  requireIncludes(userChip, "debugLogger.log('Settings'", 'UserChip open-settings action log')

  const panel = await read('src/app/settings/SettingsPanel.tsx')
  requireIncludes(panel, "debugLogger.log('Auth'", 'SettingsPanel logout action log')
  requireIncludes(panel, "debugLogger.log('Settings'", 'SettingsPanel disconnect action log')

  const gateway = await read('src/app/settings/GatewayKeyDialog.tsx')
  requireIncludes(gateway, "debugLogger.warn('Settings'", 'GatewayKeyDialog test-failed warn')
  requireIncludes(gateway, "debugLogger.log('Settings'", 'GatewayKeyDialog saved log')
  requireIncludes(gateway, "debugLogger.error('Settings'", 'GatewayKeyDialog probe error log')

  const slice = await read('src/store/settingsSlice.ts')
  requireIncludes(slice, 'mivo key saved', 'settingsSlice mivo save log')
  requireIncludes(slice, 'gateway key saved', 'settingsSlice gateway save log')
})

// Phase 5 (B12·C14): pin specific operation strings for the sidebar management
// flows. Do NOT require a mechanical log/warn/error triple on projectsSlice —
// delete/rename have no failure path, only success log + skip warn. The UI rows
// pin toastFeedback for user-acknowledged outcomes; no fake catch branches are
// fabricated (the store actions are synchronous and don't throw).
checks.push(async () => {
  const slice = await read('src/store/projectsSlice.ts')
  requireIncludes(slice, 'Created project', 'projectsSlice create success log')
  requireIncludes(slice, 'Renamed project', 'projectsSlice rename success log')
  requireIncludes(slice, 'Rename project skipped: empty name', 'projectsSlice rename skip warn')
  requireIncludes(slice, 'Rename project skipped: missing project', 'projectsSlice rename skip warn')
  requireIncludes(slice, 'Deleted project', 'projectsSlice delete success log')
  requireIncludes(slice, 'Delete project skipped: missing project', 'projectsSlice delete skip warn')
  requireIncludes(slice, 'canvas(es) returned to standalone', 'projectsSlice delete cascade log')
})

checks.push(async () => {
  const move = await read('src/store/documentSlice.ts')
  requireIncludes(move, 'Moved canvas', 'documentSlice move success log')
  requireIncludes(move, 'Move canvas skipped: missing canvas', 'documentSlice move skip warn')
  requireIncludes(move, 'Move canvas skipped: target project', 'documentSlice move skip warn')
})

checks.push(async () => {
  const canvasRow = await read('src/app/sidebar/CanvasRow.tsx')
  requireIncludes(canvasRow, 'toastFeedback.success', 'CanvasRow success toast (duplicate/delete/move)')
  requireIncludes(canvasRow, 'toastFeedback.error', 'CanvasRow error toast (move failure)')
  requireIncludes(canvasRow, 'toastFeedback.warn', 'CanvasRow warn toast (delete guard)')
})

checks.push(async () => {
  const projectRow = await read('src/app/sidebar/ProjectRow.tsx')
  requireIncludes(projectRow, 'toastFeedback.success', 'ProjectRow success toast (new canvas/delete)')
})

for (const check of checks) {
  await check()
}

console.log('Debug logging rule verified')
