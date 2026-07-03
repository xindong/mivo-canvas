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

checks.push(async () => {
  const sidebar = await read('src/app/ProjectSidebar.tsx')
  requireIncludes(sidebar, 'settingsMenuItems', 'Project sidebar settings menu')
  requireIncludes(sidebar, 'handleSettingsMenuItem', 'Project sidebar settings menu')
  requireIncludes(sidebar, "debugLogger.warn('Settings'", 'Project sidebar settings menu')

  for (const label of ['Preferences', 'Appearance', 'Keyboard shortcuts', 'Theme', 'Help and feedback']) {
    requireIncludes(sidebar, `label: '${label}'`, 'Project sidebar settings menu')
  }
})

for (const check of checks) {
  await check()
}

console.log('Debug logging rule verified')
