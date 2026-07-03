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

const argv = process.argv.slice(2)
const topology = parseTopology(argv)
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

const runScenarioAttempt = (scenarioName, index, attempt) =>
  new Promise((resolve, reject) => {
    const scenarioPort = String((topology === 'prod' ? 6174 : 5174) + index * 10 + attempt)
    console.log(`[e2e-runner] topology=${topology} scenario=${scenarioName} attempt=${attempt} port=${scenarioPort}`)
    const child = spawn(
      process.execPath,
      [smokeScript, '--topology', topology, '--scenario', scenarioName],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          MIVO_E2E_PORT: scenarioPort,
        },
      },
    )

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Scenario failed: ${scenarioName} (exit ${code ?? 'unknown'})`))
    })
  })

const maxAttempts = 2

for (const [index, scenarioName] of selectedScenarios.entries()) {
  let succeeded = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runScenarioAttempt(scenarioName, index, attempt)
      succeeded = true
      break
    } catch (error) {
      if (attempt === maxAttempts) throw error
      console.warn(
        `[e2e-runner] retrying scenario=${scenarioName} after attempt=${attempt} failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  if (!succeeded) {
    throw new Error(`Scenario failed after ${maxAttempts} attempts: ${scenarioName}`)
  }
}

console.log(`[e2e-runner] topology=${topology} passed ${selectedScenarios.length} scenario(s)`)
