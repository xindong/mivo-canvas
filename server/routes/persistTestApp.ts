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
import { encodeChildPayload } from '../../shared/persist-contract.ts'
import type { AnchorRecord, EdgeRecord, NodeRecord } from '../../src/kernel/records'

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

// 通用 fetch helper(对齐 c1a.test req();supertest 式全链路——驱动真实 Hono route)。
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

// ── 返修 N1:canonical fixtures(真实 NodeRecord/EdgeRecord/AnchorRecord,非手写残缺 JSON)──
// 用真实 kernel 类型构造,经 encoder(encodeChildPayload 剥 id+revision)→ wire payload 驱动真实 route。
const solidFill = { id: 'f1', kind: 'solid' as const, color: '#ffffff', opacity: 1, visible: true }

/** canonical NodeRecord(必填:type/title/transform/fills/strokes/effects/relations 全齐)。 */
export const canonicalNode = (id = 'n-fix'): NodeRecord => ({
  id,
  type: 'image',
  title: 'fixture-node',
  revision: 0,
  transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
  fills: [solidFill],
  strokes: [],
  effects: [],
  relations: {},
})

/** canonical EdgeRecord(含 createdAt 域字段——验证 N1:domain createdAt 保留不镜像校验)。 */
export const canonicalEdge = (id = 'e-fix'): EdgeRecord => ({
  id,
  from: 'n-from',
  to: 'n-to',
  type: 'generate',
  prompt: 'gen-prompt',
  createdAt: 12345,
  revision: 0,
})

/** canonical AnchorRecord(含 createdAt 域字段)。 */
export const canonicalAnchor = (id = 'a-fix'): AnchorRecord => ({
  id,
  type: 'point',
  targetNodeId: 'n-tgt',
  x: 10,
  y: 20,
  instruction: 'redraw here',
  createdAt: 6789,
  revision: 0,
})

/** N1 encoder:canonical Record → wire payload(剥 id+revision);PATCH body = {payload: wirePayload(record)}。 */
export const wirePayload = <T extends { id?: unknown; revision?: unknown }>(record: T): Omit<T, 'id' | 'revision'> =>
  encodeChildPayload(record)

/** PATCH child helper:用 canonical fixture(经 encoder)驱动真实 PATCH route;If-Match 可选。 */
export const patchChildWithFixture = async (
  app: Hono<AppEnv>,
  canvasId: string,
  type: 'node' | 'edge' | 'anchor',
  childId: string,
  payload: unknown,
  ifMatch?: string,
): Promise<{ status: number; body: unknown }> => {
  const suffix = type === 'node' ? 'nodes' : type === 'edge' ? 'edges' : 'anchors'
  return req(app, `/api/canvas/${canvasId}/${suffix}/${childId}`, {
    method: 'PATCH',
    headers: { ...hdr(KEY_A), ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}) },
    body: JSON.stringify({ payload }),
  })
}
