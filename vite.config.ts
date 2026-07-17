import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFileSync } from 'node:child_process'

// Build-time app version injected as import.meta.env.VITE_MIVO_VERSION
// (consumed by src/store/remoteDebugReporter.ts for debug-log appVersion).
// Format: <git short sha>-<yyyymmdd>. Falls back to VITE_MIVO_VERSION from
// the environment, then 'dev', so builds outside a git checkout still work.
const resolveAppVersion = (): string => {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (sha) {
      const now = new Date()
      const yyyymmdd = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('')
      return `${sha}-${yyyymmdd}`
    }
  } catch {
    // git unavailable or not a repository — fall through to env/default
  }
  return process.env.VITE_MIVO_VERSION || 'dev'
}

// SC1.3 (P1-d 收尾): the mivo dev middleware is RETIRED. All mivo API traffic
// is proxied to the standalone BFF (`npm run start:server`, see server/)
// via server.proxy. MIVO_API_MODE is retired — bff is the only mode.
//
// The BFF target defaults to http://127.0.0.1:$MIVO_PORT (or 8080). Override
// with MIVO_BFF_DEV_URL for non-default targets.
const resolveDevBffTarget = (env: Record<string, string>): string => {
  const explicit = env.MIVO_BFF_DEV_URL || process.env.MIVO_BFF_DEV_URL || ''
  if (explicit.trim()) return explicit.replace(/\/$/, '')
  const port = env.MIVO_PORT || process.env.MIVO_PORT || '8080'
  return `http://127.0.0.1:${port}`
}

// visual-diff token probe (env-gated): only when MIVO_VD_TOKEN is set, register a
// middleware at /__vd_probe returning the token. Lets scripts/visual-diff.mjs's
// waitForServer confirm THIS vite instance is responding (not a stale process holding
// the port — strictPort makes the new vite exit on EADDRINUSE, but an old process could
// still serve 200 on `/`). Normal dev/prod has no MIVO_VD_TOKEN → no middleware → 404.
const visualDiffProbePlugin: Plugin = {
  name: 'mivo-visual-diff-probe',
  configureServer(server) {
    const token = process.env.MIVO_VD_TOKEN
    if (!token) return
    server.middlewares.use('/__vd_probe', (_req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end(token)
    })
  },
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), visualDiffProbePlugin],
    define: {
      'import.meta.env.VITE_MIVO_VERSION': JSON.stringify(resolveAppVersion()),
    },
    server: {
      proxy: {
        // ALL /api/* traffic goes to the BFF. Use a single catch-all rather than
        // per-prefix entries: enumerating (/api/mivo, /api/auth, /api/keys, …) has
        // twice silently dropped a route to the Vite SPA fallback (browser gets
        // HTML, res.json() throws, misreported as "网络连接失败"). The SPA serves
        // no /api paths itself, so proxying all of /api is correct.
        '/api': {
          target: resolveDevBffTarget(env),
          changeOrigin: false,
          secure: false,
        },
      },
    },
  }
})
