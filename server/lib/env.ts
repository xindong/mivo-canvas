// SC1.4 production safety model (roadmap §6.1 "生产安全模型(默认收紧)").
//
// local-assets and eagle/* read files on the BFF host. In public deployments
// (MIVO_PUBLIC=1, bound on 0.0.0.0) exposing them is a file-disclosure surface,
// so they default OFF (endpoints 404). In local mode (bound on 127.0.0.1) they
// default ON for dev parity. An explicit MIVO_ENABLE_* env always wins.
//
// Resolution order per flag:
//   1. MIVO_ENABLE_LOCAL_ASSETS / MIVO_ENABLE_EAGLE_PROXY = '1' → ON
//   2. MIVO_ENABLE_LOCAL_ASSETS / MIVO_ENABLE_EAGLE_PROXY = '0' → OFF
//   3. otherwise → ON in local mode, OFF in public mode

export type FeatureFlags = {
  isPublic: boolean
  localAssetsEnabled: boolean
  eagleProxyEnabled: boolean
  // P1.4: the content-addressed asset service (POST/GET /api/assets) is DEFAULT
  // OFF — it only mounts when MIVO_ENABLE_ASSET_SERVICE=1. Unlike local-assets /
  // eagle (which auto-enable in local mode), the asset store writes user blobs to
  // disk, so it requires an explicit opt-in even on a local dev bind. The client
  // gate (?assets=server) controls usage; this flag controls whether the BFF serves
  // the routes at all. Flag off → /api/assets 404.
  assetServiceEnabled: boolean
  // B3: SSE 透传诊断 probe (GET /api/diag/sse-probe) is DEFAULT OFF — only mounts
  // when MIVO_ENABLE_SSE_PROBE=1. Purpose: lead 生产实测公司网关对 text/event-stream
  // 的 buffering/超时/Streaming 行为 (N2-0 Gate5 "条件式 GO" 留测项,见
  // docs/decisions/n20-truth-source-decision.md §12). 纯 heartbeat,无业务数据;
  // 鉴权复用 resolveActor (strict → 401). Flag off → 路由不挂载 + 404 stub,
  // SSE 代码路径完全不可达 (默认构建零暴露). 生产实测时才开,测完即关.
  sseProbeEnabled: boolean
}

const resolveFlag = (explicit: string | undefined, isPublic: boolean): boolean => {
  if (explicit === '1') return true
  if (explicit === '0') return false
  return !isPublic
}

export const resolveFeatureFlags = (env: NodeJS.ProcessEnv = process.env): FeatureFlags => {
  const isPublic = env.MIVO_PUBLIC === '1'
  return {
    isPublic,
    localAssetsEnabled: resolveFlag(env.MIVO_ENABLE_LOCAL_ASSETS, isPublic),
    eagleProxyEnabled: resolveFlag(env.MIVO_ENABLE_EAGLE_PROXY, isPublic),
    // P1.4: default OFF regardless of bind mode; only '1' enables.
    assetServiceEnabled: env.MIVO_ENABLE_ASSET_SERVICE === '1',
    // B3: default OFF regardless of bind mode; only '1' enables (生产实测时才开).
    sseProbeEnabled: env.MIVO_ENABLE_SSE_PROBE === '1',
  }
}
