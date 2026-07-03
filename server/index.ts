// server/index.ts
// BFF entrypoint. Constructs nothing — the app lives in ./app (imported by tests
// too). This file owns startup-only concerns: bind address, public-mode guard,
// and serve(). Run with `npm run start:server` (tsx server/index.ts).
import { serve } from '@hono/node-server'
import { app } from './app'

const PORT = Number(process.env.MIVO_PORT) || 8080
const PUBLIC_MODE = process.env.MIVO_PUBLIC === '1'
const BFF_TOKEN = process.env.MIVO_BFF_TOKEN?.trim() ?? ''
const HOSTNAME = PUBLIC_MODE ? '0.0.0.0' : '127.0.0.1'

// Public exposure requires an access gate; refuse to start otherwise.
if (PUBLIC_MODE && !BFF_TOKEN) {
  console.error(
    '[mivo-bff] FATAL: MIVO_PUBLIC=1 requires MIVO_BFF_TOKEN to be set. ' +
      'Refusing to bind on 0.0.0.0 without an access gate. ' +
      'Either set MIVO_BFF_TOKEN, or unset MIVO_PUBLIC to stay on 127.0.0.1.',
  )
  process.exit(1)
}

serve({ fetch: app.fetch, hostname: HOSTNAME, port: PORT }, (info) => {
  const bound = `${info.address}:${info.port}`
  const mode = PUBLIC_MODE ? 'public 0.0.0.0' : 'local 127.0.0.1'
  const gate = BFF_TOKEN ? 'token-gated' : 'open (no MIVO_BFF_TOKEN)'
  console.log(`[mivo-bff] listening on http://${bound} [${mode}, ${gate}]`)
})
