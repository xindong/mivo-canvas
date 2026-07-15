// server/lib/origin-parse.ts
// R5 Web Origin 三元组解析的单一真相源(single truth source)。
//
// 本模块是纯函数集合,无任何 process.env / 副作用 / 状态。抽自 server/routes/debug-logs.ts
// (原内联于 gate 文件),供两处共享,避免复制粘贴第二份解析逻辑:
//  - server/routes/debug-logs.ts:debug-logs origin gate(isSameOrigin / getTrustedExternalOrigin /
//    getAllowedOrigins)运行期校验请求 Origin / Host / allowlist。
//  - server/lib/owner.ts:validateDebugLogsOriginConfig 启动期守卫校验 MIVO_PUBLIC_ORIGIN 语法。
//
// 迁移为纯搬迁:逻辑零变化(逐字移自 debug-logs.ts 原 R5 实现);既有 debug-logs 全量路由测试
// (server/routes/debug-logs.route.test.ts)证明 gate 行为不变。新增文件不属 structure-guard
// 扫描范围(rule ① 仅 src/store + src/canvas;rule ④ server 分层方向:本模块无 import,不反向依赖 routes)。

// R5:Web Origin 三元组 scheme 默认端口(http=80 / https=443;归一比较用)。
export const DEFAULT_ORIGIN_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 }

// R5:严格解析序列化 Origin(RFC 6454 + WHATWG Origin 语法)。
// 只接受 http/https scheme;拒绝 userinfo / path / query / fragment / "null" / 非法序列化(如 //host 无 scheme)。
// new URL 会解析成功并剥离 path/query,但 Origin 头规范不含这些字段 → 主动检测其存在并拒(防畸形 Origin 冒充同源)。
// 返回归一三元组:scheme 保留冒号形式、host 小写、port 按 scheme 归一(默认端口转成数字)。
export const parseSerializedOrigin = (
  origin: string,
): { scheme: string; host: string; port: number } | null => {
  if (!origin || origin === 'null') return null
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/') return null
  if (parsed.search) return null
  if (parsed.hash) return null
  const scheme = parsed.protocol
  if (scheme !== 'http:' && scheme !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  if (!host) return null
  const port = parsed.port ? Number(parsed.port) : (DEFAULT_ORIGIN_PORT[scheme] ?? 0)
  if (!Number.isFinite(port) || port <= 0) return null
  return { scheme, host, port }
}

// R5:Host 头归一 — host 小写 + 默认端口按给定 scheme 归一。Host 头无 scheme,用可信外部 scheme
// 构造完整 URL 复用 parseSerializedOrigin 的字段校验(Host 头不应含 userinfo/path/query/fragment)。
export const parseHostHeader = (
  hostHeader: string | undefined,
  scheme: string,
): { scheme: string; host: string; port: number } | null => {
  if (!hostHeader) return null
  return parseSerializedOrigin(`${scheme}//${hostHeader}`)
}

// R5:归一三元组 → 规范字符串(默认端口省略;host 小写)。用于同源三元组比较 + allowlist 归一匹配
// (大小写/默认端口对称:https://app.example == https://app.example:443 == https://APP.EXAMPLE:443)。
export const serializeOriginTuple = (t: { scheme: string; host: string; port: number }): string => {
  const defaultPort = DEFAULT_ORIGIN_PORT[t.scheme]
  const portSuffix = t.port === defaultPort ? '' : `:${t.port}`
  return `${t.scheme}//${t.host}${portSuffix}`
}
