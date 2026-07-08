// server/index.ts
// BFF entrypoint. Constructs nothing — the app lives in ./app (imported by tests
// too). This file owns startup-only concerns: bind address, auth startup guard,
// and serve(). Run with `npm run start:server` (tsx server/index.ts).
import { serve } from '@hono/node-server'
import { app } from './app'
import { resolveFeatureFlags } from './lib/env'
import { getAuthConfig, startupAuthError } from './lib/authConfig'

const PORT = Number(process.env.MIVO_PORT) || 8080
const PUBLIC_MODE = process.env.MIVO_PUBLIC === '1'
const BFF_TOKEN = process.env.MIVO_BFF_TOKEN?.trim() ?? ''
const HOSTNAME = PUBLIC_MODE ? '0.0.0.0' : '127.0.0.1'

const featureFlags = resolveFeatureFlags()
const authCfg = getAuthConfig()

// A-1 startup fail-closed guard (any mode, not just public):
//   1. JWT_SECRET set but invalid base64 / decodes empty → abort (silent no-op would
//      treat 「configured but broken」 as 「not configured」 and open the gate).
//   2. MIVO_PUBLIC=1 with neither MIVO_BFF_TOKEN nor valid JWT_SECRET → abort
//      (public bind with no gate = naked exposure).
// Pure check lives in startupAuthError() so tests can exercise it without a subprocess.
const startupErr = startupAuthError(authCfg, process.env)
if (startupErr) {
  console.error(startupErr)
  process.exit(1)
}
serve({ fetch: app.fetch, hostname: HOSTNAME, port: PORT }, (info) => {
  const bound = `${info.address}:${info.port}`
  const mode = PUBLIC_MODE ? 'public 0.0.0.0' : 'local 127.0.0.1'
  const gate = BFF_TOKEN
    ? 'token-gated'
    : authCfg.jwtSecretBytes
      ? 'jwt-gated (feat/auth-feishu-login)'
      : 'open (no MIVO_BFF_TOKEN / JWT_SECRET)'
  const assets = featureFlags.localAssetsEnabled ? 'on' : 'off'
  const eagle = featureFlags.eagleProxyEnabled ? 'on' : 'off'
  console.log(
    `[mivo-bff] listening on http://${bound} [${mode}, ${gate}] local-assets=${assets} eagle=${eagle}`
  )
})
