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
  // 连接池上限(单实例 BFF;灰度保守值,env 可调)。P0.3 连接预算:与 PG compose 的
  // resources.limits.memory=2g 配套,单实例保守 10;多实例协作时按实例数 × max ≤ PG
  // max_connections 的 70%(留余量给备份/运维查询,见 runbook §容量预算)。
  maxConnections: number
  // 连接 idle 超时(ms),0=不超时。空闲连接在池内停留多久后关闭。
  idleTimeoutMs: number
  // P0.3 连接预算:从池里获取一条连接的排队等待超时(ms)。池满时新请求等该时长仍拿不到连接
  // → 抛错(而非无限排队把 BFF 拖死)。可选——resolvePersistBackendConfig 从 env 总填(生产取
  // MIVO_PG_CONNECTION_TIMEOUT_MS,默认 5000);测试构造 config 字面量可省(pgBackend 构造兜底 5000)。
  connectionTimeoutMs?: number
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
 * F9 返修 + R2-7 对抗完备:idle 超时专用解析器。
 * `.env.example` 文档声明 `MIVO_PG_IDLE_TIMEOUT_MS=0` = 不超时(匹配 pg Pool
 * `idleTimeoutMillis: 0` 语义:空闲连接永不关闭),但旧实现复用 `num()`(只收 >0),
 * `0` 被静默回落到 30000 → 文档与实现冲突,配置写 0 无人察觉。
 *
 * R2-7:旧 `Math.trunc(n)` 把小数静默截断 → `0.5` 变 `0`(意外禁用超时)、`1.9` 变 `1`。
 * 对抗负例:运维写 `0.5`(想 500μs?实则禁用)被静默吞 → 现改 `Number.isInteger` 拒绝非整数。
 *
 * 本解析器:
 *  - 未设 / 空串 → fallback(默认 30000,向后兼容)。
 *  - `0` → 0(不超时,与文档一致)。
 *  - 正整数 → 该值(ms)。
 *  - 负数 / 非整数(0.5/1.9)/ 非数字 / NaN → **抛错 fail visibly**(不静默回落/截断;
 *    否则配置写错无人察觉,与"fail visibly,不静默降级"一致,见 resolvePersistBackendConfig 缺密码抛错)。
 */
const parseIdleTimeout = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(
      `MIVO_PG_IDLE_TIMEOUT_MS 非法值 "${value}":须为 ≥ 0 的整数(0=不超时;正整数=ms)。小数会被静默截断故直接拒绝(fail visibly,不静默回落/截断)。`,
    )
  }
  return n
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
      idleTimeoutMs: parseIdleTimeout(env.MIVO_PG_IDLE_TIMEOUT_MS, 30_000),
      // P0.3:默认 5000ms(fail fast,池满不无限排队)。env MIVO_PG_CONNECTION_TIMEOUT_MS 可调。
      connectionTimeoutMs: num(env.MIVO_PG_CONNECTION_TIMEOUT_MS, 5_000),
    },
  }
}
