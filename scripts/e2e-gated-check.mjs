// scripts/e2e-gated-check.mjs
// SSO 网关方案(feat/auth-sso)下的 HTTP-可验安全属性门控检查。
//
// 旧 BFF token gate 已删(app 无 auth gate,身份由公司统一 SSO 网关 auth.dsworks.cn
// 提供,不在本仓改动范围)。本检查不再断言"裸 /api/mivo/* → 401"或"带 token → 200
// 链",改为验新模型下仍 HTTP-可验的真实属性:
//   --mode=public (默认):MIVO_PUBLIC=1 → dev 桩硬关(/api/auth/me 401,即便误设
//     MIVO_DEV_AUTH_STUB=1 也仍关)+ feature flag 收紧(local-assets/eagle 404、
//     debug-logs GET 403)。
//   --mode=local:非 public + MIVO_DEV_AUTH_STUB=1 → dev 桩开(/api/auth/me 200 +
//     网关契约 shape),测 P1-b opt-in 真生效。
//
// 纯 fetch(无 browser / eagle mock / upstream mock / fixture),CI 无需 Playwright 或
// 构建产物(BFF 由 tsx 直跑,只命中 /api/*)。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForServer } from './e2e-helpers.mjs'
import {
  assertLocalDevStubActive,
  assertPublicModeSecurity,
} from './e2e/prod-auth-assertions.mjs'
import { createBaseUrl, startSmokeBffServer, stopSmokeDevServer } from './e2e/harness.mjs'

const parseMode = (argv) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      const value = argv[index + 1]
      if (value === 'public' || value === 'local') return value
      throw new Error('--mode requires public or local')
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length)
      if (value === 'public' || value === 'local') return value
      throw new Error(`Unknown --mode value: ${value}`)
    }
  }
  return 'public'
}

const mode = parseMode(process.argv.slice(2))
const isPublic = mode === 'public'
const port = Number(process.env.MIVO_E2E_PORT ?? 7174)
const baseUrl = createBaseUrl(port)
// public 模式不配 debug view token → debug-logs GET 403 fail-closed;
// local 模式也用空(只测 /api/auth/me,不读 debug-logs)。
const debugViewToken = ''
const localAssetFixtureDir = mkdtempSync(join(tmpdir(), 'mivo-gated-'))

let server

try {
  server = startSmokeBffServer({
    port,
    localAssetFixtureDir,
    eagleMockPort: 65530, // 未启动 eagle mock;public 模式 eagle 404,local 模式不命中
    upstreamBaseUrl: null, // 不测 generate/edit/enhance,无需上游 mock
    debugViewToken,
    enableLocalAssets: false,
    enableEagleProxy: false,
    isPublic,
  })
  await waitForServer(`${baseUrl}/healthz`)

  if (isPublic) {
    // authedFetch = 普通 fetch(BFF 无 gate,无需任何鉴权 header;debug-logs 不带
    // view token → 403,正是要验的 fail-closed)。
    const authedFetch = async (input, init = {}) => fetch(input, { ...init })
    await assertPublicModeSecurity({ baseUrl, authedFetch })
  } else {
    await assertLocalDevStubActive({ baseUrl })
  }

  console.log(`[e2e-gated-check] mode=${mode} passed`)
} finally {
  await stopSmokeDevServer(server)
}
