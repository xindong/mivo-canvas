import { waitForServer } from './e2e-helpers.mjs'
import { startEagleMockServer } from './e2e/eagle-mock-server.mjs'
import { prepareSmokeFixtures } from './e2e/fixtures.mjs'
import {
  assertProdAuthorizedChain,
  assertProdPublicRestrictions,
  assertProdUnauthorizedGate,
} from './e2e/prod-auth-assertions.mjs'
import { startUpstreamMockServer } from './e2e/upstream-mock-server.mjs'
import {
  createBaseUrl,
  createSmokePage,
  prepareSmokeArtifacts,
  startSmokeBffServer,
  stopSmokeDevServer,
} from './e2e/harness.mjs'

const parseMode = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      const value = argv[index + 1]
      if (value === 'authorized' || value === 'unauthorized') return value
      throw new Error('--mode requires authorized or unauthorized')
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length)
      if (value === 'authorized' || value === 'unauthorized') return value
      throw new Error(`Unknown --mode value: ${value}`)
    }
  }
  return 'authorized'
}

const mode = parseMode(process.argv.slice(2))
const useRealUpstream = process.env.MIVO_E2E_USE_REAL_UPSTREAM === '1'
const port = Number(process.env.MIVO_E2E_PORT ?? 7174)
const baseUrl = createBaseUrl(port)
const bffToken = 'e2e-token'
const debugViewToken = 'test-token'
const {
  eagleMockDir,
  eagleMockItem,
  eagleMockItemDir,
  generatedImageB64,
  localAssetFixtureDir,
  localAssetFixtureSvg,
} = prepareSmokeFixtures()

const eagleMockHandle = await startEagleMockServer({ eagleMockDir, eagleMockItem, eagleMockItemDir })
const upstreamMockHandle = useRealUpstream ? null : await startUpstreamMockServer({ generatedImageB64 })

let server
let smokePage

try {
  await prepareSmokeArtifacts()
  server = startSmokeBffServer({
    port,
    localAssetFixtureDir,
    eagleMockPort: eagleMockHandle.port,
    upstreamBaseUrl: upstreamMockHandle?.url,
    bffToken,
    debugViewToken: mode === 'authorized' ? debugViewToken : '',
    enableLocalAssets: mode === 'authorized',
    enableEagleProxy: mode === 'authorized',
  })
  await waitForServer(`${baseUrl}/healthz`)

  if (mode === 'unauthorized') {
    const authedFetch = async (input, init = {}) =>
      fetch(input, {
        ...init,
        headers: {
          'x-mivo-bff-token': bffToken,
          ...(init.headers || {}),
        },
      })

    await assertProdPublicRestrictions({ baseUrl, authedFetch })

    smokePage = await createSmokePage({
      baseUrl,
      generatedImageB64,
      enableApiRouteMocks: false,
    })
    await assertProdUnauthorizedGate({ requestContext: smokePage.page.request, baseUrl })
  } else {
    smokePage = await createSmokePage({
      baseUrl,
      generatedImageB64,
      enableApiRouteMocks: false,
      extraHTTPHeaders: {
        'x-mivo-bff-token': bffToken,
        'x-mivo-debug-token': debugViewToken,
      },
    })
    await assertProdAuthorizedChain({
      requestContext: smokePage.context.request,
      baseUrl,
      localAssetFixtureSvg,
    })
  }

  console.log(`[e2e-gated-check] mode=${mode} passed`)
} finally {
  if (smokePage) await smokePage.browser.close()
  await stopSmokeDevServer(server)
  if (upstreamMockHandle) await upstreamMockHandle.close()
  await eagleMockHandle.close()
}
