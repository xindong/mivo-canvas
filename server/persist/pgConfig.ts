// server/persist/pgConfig.ts
// T1.3 PG backend 连接配置 + backend 选择开关。env 驱动,不写死任何密码(.env 不入 git)。
//
// 后端选择(与项目一贯 ?kernel= 旗下切换 风格一致):
//  - MIVO_PERSIST_BACKEND=pg|memory,默认 **memory**(生产零变化),PG 后端灰度启用。
//  - PG 启用时,连接参数从 MIVO_PG_* env 读;缺密码 → 构造抛错(fail visibly,不静默降级)。
//
// 生产端口 55442(MIVO_PG_HOST_PORT,见 ops/postgres/docker-compose.yml);本地开发/测试用
// ops/postgres/docker-compose.test.yml 起本地 PG(MIVO_PG_HOST_PORT 默认 55443,避开生产口)。

export type PersistBackendKind = 'memory' | 'pg'

export type PgConnectionConfig = {
  host: string
  port: number
  database: string
  user: string
  password: string
  // 连接池上限(单实例 BFF;灰度保守值,env 可调)。
  maxConnections: number
  // 连接 idle 超时(ms),0=不超时。
  idleTimeoutMs: number
}

export type PersistBackendConfig = {
  kind: PersistBackendKind
  pg: PgConnectionConfig | null
}

const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * resolvePersistBackendConfig:读 env 决定 backend kind + PG 连接参数。
 * kind=pg 但缺 MIVO_PG_PASSWORD → 抛错(不静默回退 memory;PG 启用即承诺真持久)。
 */
export const resolvePersistBackendConfig = (env: NodeJS.ProcessEnv = process.env): PersistBackendConfig => {
  const kind: PersistBackendKind = env.MIVO_PERSIST_BACKEND === 'pg' ? 'pg' : 'memory'
  if (kind !== 'pg') return { kind, pg: null }
  const password = env.MIVO_PG_PASSWORD
  if (!password) {
    // fail visibly:PG 启用但无密码 → 启动即停,不静默降级到 memory(那会让"原样在"假绿)。
    throw new Error(
      'MIVO_PERSIST_BACKEND=pg 但 MIVO_PG_PASSWORD 未设置。PG backend 需 MIVO_PG_HOST/PORT/DB/USER/PASSWORD(.env,不入 git);见 ops/postgres/.env.example。',
    )
  }
  return {
    kind,
    pg: {
      host: env.MIVO_PG_HOST || '127.0.0.1',
      port: num(env.MIVO_PG_PORT ?? env.MIVO_PG_HOST_PORT, 5432),
      database: env.MIVO_PG_DB || 'mivocanvas',
      user: env.MIVO_PG_USER || 'mivo',
      password,
      maxConnections: num(env.MIVO_PG_MAX_CONNECTIONS, 10),
      idleTimeoutMs: num(env.MIVO_PG_IDLE_TIMEOUT_MS, 30_000),
    },
  }
}
