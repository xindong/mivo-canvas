// persistMode — 三态持久化模式开关(G1-a 非画布域接线;v4 §1 三态 local/shadow/server)。
//
// 解析 `?persist=` 查询参数 + `VITE_MIVO_PERSIST` 构建期 env 覆盖,决定客户端持久化形态。
// 与 kernelMode(?kernel=) 同构(项目藏身开关惯例):模块加载时一次性解析,页面生命周期内不变。
//
// 三态(v4 §1):
//  - `local`(默认):现状不变 —— IDB-only,zustand persist 走 idbStateStorage,
//    ServerPersistAdapter = unwired(全 reject),writeRetryQueue 不 start。生产零感知。
//  - `shadow`:IDB + 服务端双写(IDB 仍为读源)+ shadow compare。用于灰度比对,非生产默认。
//  - `server`:服务端权威 —— hydrate 从 BFF 拉,增量写经 ServerPersistAdapter + writeRetryQueue
//    落 PG。非画布域(project/canvas-meta/user-state/asset)接线;画布域(node/edge/anchor)写
//    仍 reject(G1-c 挂 N2-0);chat 仍 reject(DP-6R 另一 worker)。
//
// 优先级:env(VITE_MIVO_PERSIST) > URL(?persist=) > 默认 local。env 用于 CI/构建期强制模式
// 而不污染 URL;URL 用于本地手切。非法值回退 local 并 warn(与 kernelMode 一致)。
//
// 解析在模块加载时执行一次(persist 在页面生命周期内不变,与 kernelMode/rendererMode 同构)。
// `getPersistMode()` 返回该一次性解析结果,供 store 初始化 / adapter 选择 / queue start 单点读取。
//
// **默认 local = 生产零变化**:无 ?persist= / 无 env 时,所有代码路径与 main 一致
// (adapter 仍 unwired、queue 仍 inert、syncToServer 仍 no-op)。server/shadow 是藏身开关,
// 在 G1-c/N2-0 落地前不进生产默认。本任务只建开关 + 非画布域接线,不改契约语义。

import { debugLogger } from '../store/debugLogStore'

export type PersistMode = 'local' | 'shadow' | 'server'

const DEFAULT_MODE: PersistMode = 'local'

const VALID_MODES: ReadonlySet<string> = new Set(['local', 'shadow', 'server'])

const PERSIST_ENV_KEY = 'VITE_MIVO_PERSIST'

const normalize = (raw: string): string => raw.trim().toLowerCase()

// import.meta.env 经 Vite(vite/client)注入;SSR/纯 Node 不可用时为 undefined。
// 动态索引 env[PERSIST_ENV_KEY] 避免 Vite 构建期静态替换,保证 vi.stubEnv 在单测生效。
const readEnvPersist = (): string | null => {
  const env = import.meta.env as unknown as Record<string, unknown> | undefined
  const raw = env?.[PERSIST_ENV_KEY]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null
}

const resolvePersist = (raw: string, source: 'env' | 'url'): PersistMode => {
  const normalized = normalize(raw)
  if (!VALID_MODES.has(normalized)) {
    debugLogger.warn('Persist', `未知 persist mode "${raw}"(来源 ${source}),回退默认 ${DEFAULT_MODE}`)
    return DEFAULT_MODE
  }
  if (normalized !== 'local') {
    debugLogger.log(
      'Persist',
      `${normalized} persist requested(来源 ${source};三态 local/shadow/server 见 v4 §1;非画布域接线 G1-a)`,
    )
    return normalized as PersistMode
  }
  // 显式 local 与缺省等价,同记一条身份 log。
  debugLogger.log('Persist', `persist identity: local (${source} explicit)`)
  return 'local'
}

const parsePersistModeFromUrlOrEnv = (): PersistMode => {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    // 非浏览器环境(SSR/单测/Node)→ 默认 local,不打身份 log(与 kernelMode 同:此路径在
    // module-load 时执行,Node/SSR 无 persist 场景无需身份日志,且避免污染未 mock debugLogger 的测试)。
    return DEFAULT_MODE
  }

  // env 覆盖(最高优先级):CI/构建期通过 VITE_MIVO_PERSIST 强制模式,无需 URL。
  const envRaw = readEnvPersist()
  if (envRaw) {
    return resolvePersist(envRaw, 'env')
  }

  const raw = new URLSearchParams(window.location.search).get('persist')
  if (!raw) {
    // 缺省(无 ?persist=)启动记一条持久化身份 Debug Log,便于运行时确认默认轨。
    debugLogger.log('Persist', `persist identity: ${DEFAULT_MODE} (default)`)
    return DEFAULT_MODE
  }

  return resolvePersist(raw, 'url')
}

export const persistMode: PersistMode = parsePersistModeFromUrlOrEnv()

// G1-a 显式要求的可调用出口:返回一次性解析结果(persist 在页面生命周期内不变)。
export function getPersistMode(): PersistMode {
  return persistMode
}

export const isLocalPersist = persistMode === 'local'
export const isShadowPersist = persistMode === 'shadow'
export const isServerPersist = persistMode === 'server'
