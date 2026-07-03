import process from 'node:process'
import { DEFAULT_FIXTURE_SEED, SUPPORTED_NODE_COUNTS, writeFixtureFiles } from './fixture-lib.mjs'

const parseNodeCounts = (rawValue) => {
  if (!rawValue) return SUPPORTED_NODE_COUNTS
  const counts = rawValue
    .split(',')
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value))

  if (!counts.length) {
    throw new Error(`Invalid --nodes value: ${rawValue}`)
  }

  for (const count of counts) {
    if (!SUPPORTED_NODE_COUNTS.includes(count)) {
      throw new Error(`Unsupported node count: ${count}`)
    }
  }

  return Array.from(new Set(counts))
}

const parseArgs = (argv) => {
  const args = { nodes: SUPPORTED_NODE_COUNTS, seed: DEFAULT_FIXTURE_SEED }

  for (const entry of argv) {
    if (entry.startsWith('--nodes=')) {
      args.nodes = parseNodeCounts(entry.slice('--nodes='.length))
      continue
    }

    if (entry.startsWith('--seed=')) {
      const seed = Number.parseInt(entry.slice('--seed='.length), 10)
      if (!Number.isFinite(seed)) {
        throw new Error(`Invalid --seed value: ${entry}`)
      }
      args.seed = seed
      continue
    }
  }

  return args
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const outputs = await writeFixtureFiles({
    nodeCounts: args.nodes,
    seed: args.seed,
  })

  for (const item of outputs) {
    console.log(
      `${item.nodeCount} nodes -> ${item.path} (scene=${item.sceneId}, bounds=${item.bounds.width}x${item.bounds.height})`,
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
