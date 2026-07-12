// serverPersistHydrate — G1-a hydrate 读取原语(server 模式 store boot 用)。
//
// hydrate 范围(非画布域,server 模式):
//   project     → adapter.listProjects()                 (GET /api/projects)
//   canvas-meta → adapter.listCanvas(projectId?)          (GET /api/canvas)
//   canvas 全量 → adapter.fetchCanvas(canvasId)           (GET /api/canvas/:id,hydrate 读路径)
//   user-state  → adapter.getUserState(key) 逐 key / 本模块 hydrateUserStateMap()(GET /api/user-state 全量)
//
// 上述 canvas/project/canvas-meta 的 hydrate 已在 ServerPersistAdapter 接口内(fetchCanvas/
// listCanvas/listProjects wired),store boot 直接调 adapter 读方法即可——本模块不重复实现 fetch,
// 只补接口未暴露的 **user-state 全量 list**(GET /api/user-state → Record<key, UserStateEntry>),
// 因 ServerPersistAdapter 只暴露逐 key 的 getUserState,boot 拉全量需要 list 端点。
//
// store boot 接入是后续工作(G1-c/N2-0 后;canvas hydrate 无 canvas 写尚不完整,当前 local 默认
// 不调用本模块)。本模块提供原语 + 契约测试验证往返一致(server 模式 CRUD 经 BFF 落 PG)。
//
// 复用 requestJson(serverPersistAdapter 的 fetch 底座),不重复实现 fetch。404 在各方法内吃掉返
// 空(无 canvas → null;user-state 无 key → {})。

import type { ListUserStateResponse, UserStateEntry } from '../../shared/persist-contract.ts'
import { requestJson, type FetchAdapterOptions, type FetchLike, type GetAuthHeaders } from './serverPersistAdapter'

const defaultFetch: FetchLike = (input, init) => fetch(input, init)

const resolveOpts = (opts: FetchAdapterOptions): { fetch: FetchLike; baseUrl: string; getAuthHeaders: GetAuthHeaders } => ({
  fetch: opts.fetch ?? defaultFetch,
  baseUrl: opts.baseUrl ?? '',
  getAuthHeaders: opts.getAuthHeaders,
})

/**
 * GET /api/user-state → 全量 KV map(owner-scoped,未软删)。server 模式 boot 拉取用户全部
 * user-state(selection / camera / pref / panel 等)灌入对应 store。空 owner / 无 key → {}。
 * 非画布域,不受合并模型影响。
 */
export const hydrateUserStateMap = async (opts: FetchAdapterOptions): Promise<Record<string, UserStateEntry>> => {
  const base = resolveOpts(opts)
  const res = await requestJson<ListUserStateResponse>({
    ...base,
    method: 'GET',
    path: '/api/user-state',
  })
  return res?.entries ?? {}
}
