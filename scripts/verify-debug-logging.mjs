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
    'Every user-facing feature must emit Debug Log entries',
    'debugLogger.log',
    'debugLogger.warn',
    'debugLogger.error',
    'npm run verify:logging',
  ]) {
    requireIncludes(docs, phrase, 'Development logging documentation')
  }
})

checks.push(async () => {
  const readme = await read('README.md')
  requireIncludes(readme, 'Development Logging Rule', 'README')
  requireIncludes(readme, 'docs/development-logging.md', 'README')
})

checks.push(async () => {
  const store = await read('src/store/debugLogStore.ts')
  for (const level of ["'log'", "'warning'", "'error'"]) {
    requireIncludes(store, level, 'Debug Log store')
  }
  requireLoggerLevels(store, 'Debug Log store')
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
