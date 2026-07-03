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
  }
}
