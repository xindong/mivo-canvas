import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

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

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
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
