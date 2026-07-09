// Runs the visual-diff harness once per shell (outer-UI) fixture, in series.
// Each invocation spawns its own Vite dev server + BFF (dual-process topology),
// captures a baseline + candidate (dom-vs-dom self-diff = 0% proves the baseline
// is stable / non-jittery), and writes artifacts to test-artifacts/visual-diff-shell-<name>/.
//
// Series (not parallel) because each run binds the dev server (4179) + BFF (8089)
// on fixed ports — parallel would collide. Servers are torn down by each run's
// finally block before the next starts.
//
// Usage:
//   node scripts/visual-shell-baselines.mjs              # run all 11 shell fixtures
//   node scripts/visual-shell-baselines.mjs --only=sidebar   # run just shell-sidebar
import { spawn } from 'node:child_process'
import process from 'node:process'
import { projectRoot } from './bench/fixture-lib.mjs'

const FIXTURES = [
  'shell-sidebar',
  'shell-sidebar-collapsed',
  'shell-canvas-context-menu',
  'shell-canvas-context-submenu',
  'shell-confirm-dialog',
  'shell-canvas-rename',
  'shell-chat-empty',
  'shell-chat-task-cards',
  'shell-settings-panel',
  'shell-changelog-panel',
  'shell-asset-library',
]

const runOne = (fixture) =>
  new Promise((resolve) => {
    const child = spawn('node', ['scripts/visual-diff.mjs', `--fixture=${fixture}`], {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    child.on('error', (error) => resolve({ fixture, code: -1, error }))
    child.on('close', (code) => resolve({ fixture, code }))
  })

const main = async () => {
  const onlyArg = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice('--only='.length)
  const fixtures = onlyArg ? FIXTURES.filter((f) => f.includes(onlyArg)) : FIXTURES

  const results = []
  for (const fixture of fixtures) {
    console.log(`\n[visual-shell-baselines] === ${fixture} ===`)
    results.push(await runOne(fixture))
  }

  console.log('\n[visual-shell-baselines] summary:')
  for (const { fixture, code } of results) {
    console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${fixture}`)
  }
  const failed = results.filter((r) => r.code !== 0)
  if (failed.length) {
    console.error(`\n[visual-shell-baselines] ${failed.length}/${results.length} fixture(s) failed`)
    process.exitCode = 1
  } else {
    console.log(`\n[visual-shell-baselines] all ${results.length} fixtures passed`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
