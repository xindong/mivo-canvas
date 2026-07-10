// server/routes/persistTestApp.ts
// T1.3 测试 helper:构建挂载 projects+canvas+userState 三路由的最小 app + fresh 内存 backend。
// 镜像 local-assets.test.ts buildApp 模式;route 级契约测试用它(不驱动主 app,避免 singleton 状态)。
// 主 app wiring 烟测见 server/__tests__/t1.3-wiring.test.ts(驱动主 app + reset sharedPersistBackend)。
import { Hono } from 'hono'
import type { AppEnv } from '../lib/types'
import { createProjectsRoutes } from './projects'
import { createCanvasRoutes } from './canvas'
import { createUserStateRoutes } from './userState'
import { InMemoryPersistBackend } from '../persist/backend'

export const buildPersistApp = (): { app: Hono<AppEnv>; backend: InMemoryPersistBackend } => {
  const backend = new InMemoryPersistBackend()
  const app = new Hono<AppEnv>()
  app.route('/api/projects', createProjectsRoutes({ backend }))
  app.route('/api/canvas', createCanvasRoutes({ backend }))
  app.route('/api/user-state', createUserStateRoutes({ backend }))
  return { app, backend }
}

// 两个不同 owner(同 FX-2 tasks-per-user.test:不同 X-Mivo-Api-Key → 不同指纹)。
export const KEY_A = 'mivo_aaa_user_a'
export const KEY_B = 'mivo_bbb_user_b'
export const hdr = (key: string): Record<string, string> => ({ 'x-mivo-api-key': key })

// 通用 fetch helper(对齐 c1a.test req())。
export const req = async (
  app: Hono<AppEnv>,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> => {
  const res = await app.request(path, init)
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body }
}
