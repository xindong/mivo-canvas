import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scenarioOrder } from './e2e/scenarios/index.mjs'

const parseTopology = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--topology') {
      const value = argv[index + 1]
      if (value === 'dev' || value === 'prod') return value
      throw new Error('--topology requires dev or prod')
    }
    if (arg.startsWith('--topology=')) {
      const value = arg.slice('--topology='.length)
      if (value === 'dev' || value === 'prod') return value
      throw new Error(`Unknown --topology value: ${value}`)
    }
  }
  return 'dev'
}

const parseRenderer = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--renderer') {
      const value = argv[index + 1]
      if (value === 'dom' || value === 'leafer' || value === 'both') return value
      throw new Error('--renderer requires dom, leafer, or both')
    }
    if (arg.startsWith('--renderer=')) {
      const value = arg.slice('--renderer='.length)
      if (value === 'dom' || value === 'leafer' || value === 'both') return value
      throw new Error(`Unknown --renderer value: ${value}`)
    }
  }
  return 'dom'
}

const parseScenarios = (argv) => {
  const values = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--scenario') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error('--scenario requires a value')
      }
      values.push(value)
      index += 1
      continue
    }

    if (arg.startsWith('--scenario=')) {
      values.push(arg.slice('--scenario='.length))
    }
  }

  return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
}

// 端口 base:默认 dev=5174 / prod=6174。多 worker(或多个 worktree)并行跑 e2e 时,
// 每个 worker 必须设不同的 MIVO_E2E_PORT_BASE(例如 5174 / 6274 / 7374 ...),否则同一
// scenario 在 selectedScenarios 中的 index 相同 → 端口撞车 → vite --strictPort 启动失败
// 或 killStaleDevServer 互杀对方的 dev server。base 间隔 ≥ 100 即可避免(单次 run 端口
// 跨度 ≤ 14*10+2=142,但同 worker 串行,实际只用当前 scenario 的 base+index*10+attempt)。
const argv = process.argv.slice(2)
const topology = parseTopology(argv)
const portBase = Number(process.env.MIVO_E2E_PORT_BASE ?? (topology === 'prod' ? 6174 : 5174))
const renderer = parseRenderer(argv)
const requestedScenarios = parseScenarios(argv)
const selectedScenarios = requestedScenarios.length === 0
  ? scenarioOrder
  : scenarioOrder.filter((name) => requestedScenarios.includes(name))

const unknownScenarios = requestedScenarios.filter((name, index) =>
  requestedScenarios.indexOf(name) === index && !scenarioOrder.includes(name),
)
if (unknownScenarios.length > 0) {
  throw new Error(`Unknown --scenario value(s): ${unknownScenarios.join(', ')}. Expected one of: ${scenarioOrder.join(', ')}`)
}

const smokeScript = fileURLToPath(new URL('./e2e-smoke.mjs', import.meta.url))

const rendererModes = renderer === 'both' ? ['dom', 'leafer'] : [renderer]

const runScenarioAttempt = (scenarioName, index, attempt, rendererMode) =>
  new Promise((resolve, reject) => {
    const scenarioPort = String(portBase + index * 10 + attempt)
    console.log(`[e2e-runner] topology=${topology} scenario=${scenarioName} renderer=${rendererMode} attempt=${attempt} port=${scenarioPort} base=${portBase}`)
    const child = spawn(
      process.execPath,
      [smokeScript, '--topology', topology, '--scenario', scenarioName, '--renderer', rendererMode],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          MIVO_E2E_PORT: scenarioPort,
          MIVO_E2E_PORT_BASE: String(portBase),
        },
      },
    )

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Scenario failed: ${scenarioName} renderer=${rendererMode} (exit ${code ?? 'unknown'})`))
    })
  })

const maxAttempts = 2

for (const rendererMode of rendererModes) {
  for (const [index, scenarioName] of selectedScenarios.entries()) {
    let succeeded = false

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await runScenarioAttempt(scenarioName, index, attempt, rendererMode)
        succeeded = true
        break
      } catch (error) {
        if (attempt === maxAttempts) throw error
        console.warn(
          `[e2e-runner] retrying scenario=${scenarioName} renderer=${rendererMode} after attempt=${attempt} failure: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    if (!succeeded) {
      throw new Error(`Scenario failed after ${maxAttempts} attempts: ${scenarioName} renderer=${rendererMode}`)
    }
  }
}

console.log(`[e2e-runner] topology=${topology} renderer=${renderer} passed ${selectedScenarios.length} scenario(s) across ${rendererModes.length} renderer mode(s)`)
