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

// T0.7: --kernel passthrough (mirrors --renderer; contract §7 of
// docs/decisions/kernel-dualtrack-contract.md). Accepts new|legacy|both; both →
// each scenario runs twice (legacy then new), assertion count unchanged. Default
// legacy = zero behaviour change vs. pre-T0.7.
const parseKernel = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--kernel') {
      const value = argv[index + 1]
      if (value === 'new' || value === 'legacy' || value === 'both') return value
      throw new Error('--kernel requires new, legacy, or both')
    }
    if (arg.startsWith('--kernel=')) {
      const value = arg.slice('--kernel='.length)
      if (value === 'new' || value === 'legacy' || value === 'both') return value
      throw new Error(`Unknown --kernel value: ${value}`)
    }
  }
  return 'legacy'
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
// kernel 维度是外层串行循环,不增加并发,故不另占端口段。
const argv = process.argv.slice(2)
const topology = parseTopology(argv)
const portBase = Number(process.env.MIVO_E2E_PORT_BASE ?? (topology === 'prod' ? 6174 : 5174))
const renderer = parseRenderer(argv)
const kernel = parseKernel(argv)
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
// both → 先 legacy 后 new(contract §7);单值 → [该值]。kernel 维度在最外层串行。
const kernelModes = kernel === 'both' ? ['legacy', 'new'] : [kernel]

const runScenarioAttempt = (scenarioName, index, attempt, rendererMode, kernelMode) =>
  new Promise((resolve, reject) => {
    const scenarioPort = String(portBase + index * 10 + attempt)
    console.log(`[e2e-runner] topology=${topology} scenario=${scenarioName} kernel=${kernelMode} renderer=${rendererMode} attempt=${attempt} port=${scenarioPort} base=${portBase}`)
    const child = spawn(
      process.execPath,
      [smokeScript, '--topology', topology, '--scenario', scenarioName, '--renderer', rendererMode, '--kernel', kernelMode],
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
      reject(new Error(`Scenario failed: ${scenarioName} kernel=${kernelMode} renderer=${rendererMode} (exit ${code ?? 'unknown'})`))
    })
  })

const maxAttempts = 2

// 每 kernel 维度通过数追踪(--kernel=both 报告分维度输出)。
const perKernelPassed = Object.fromEntries(kernelModes.map((mode) => [mode, 0]))

// 笛卡尔积 (kernel × renderer × scenario),kernel 最外层串行 → 与 --renderer=both 同构,
// 只是多一层维度。renderer 在内层,保证同一 kernel 下 dom/leafer 连续跑完。
for (const kernelMode of kernelModes) {
  for (const rendererMode of rendererModes) {
    for (const [index, scenarioName] of selectedScenarios.entries()) {
      let succeeded = false

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await runScenarioAttempt(scenarioName, index, attempt, rendererMode, kernelMode)
          succeeded = true
          break
        } catch (error) {
          if (attempt === maxAttempts) throw error
          console.warn(
            `[e2e-runner] retrying scenario=${scenarioName} kernel=${kernelMode} renderer=${rendererMode} after attempt=${attempt} failure: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }

      if (!succeeded) {
        throw new Error(`Scenario failed after ${maxAttempts} attempts: ${scenarioName} kernel=${kernelMode} renderer=${rendererMode}`)
      }
    }
  }
  // 跑到这里 = 该 kernel 下所有 renderer×scenario 全过(失败已 throw)。
  perKernelPassed[kernelMode] = selectedScenarios.length * rendererModes.length
}

const kernelBreakdown = kernelModes.map((mode) => `kernel=${mode}:${perKernelPassed[mode]}`).join(' ')
console.log(
  `[e2e-runner] topology=${topology} kernel=${kernel} renderer=${renderer} passed ${selectedScenarios.length} scenario(s) across ${kernelModes.length} kernel mode(s) x ${rendererModes.length} renderer mode(s) [${kernelBreakdown}]`,
)
