// server/__tests__/owner.test.ts
// T1.4 owner.ts 纯函数 + 配置校验单测(SSO trust flag + 网关密钥 + 生产告警)。
import { describe, it, expect } from 'vitest'
import { isSsoHeaderTrusted, validateSsoConfig, validateDebugLogsOriginConfig, ssoHeaderSecretOk, SSO_TRUSTED_USER_HEADER, GATEWAY_SECRET_HEADER } from '../lib/owner'

describe('T1.4 isSsoHeaderTrusted(opt-in,默认关)', () => {
  it('默认关(未设 flag)', () => {
    expect(isSsoHeaderTrusted({})).toBe(false)
  })
  it("=1 才开", () => {
    expect(isSsoHeaderTrusted({ MIVO_TRUST_SSO_HEADER: '1' })).toBe(true)
    expect(isSsoHeaderTrusted({ MIVO_TRUST_SSO_HEADER: '0' })).toBe(false)
    expect(isSsoHeaderTrusted({ MIVO_TRUST_SSO_HEADER: 'true' })).toBe(false) // 严格 '1'
  })
})

describe('T1.4 validateSsoConfig(生产告警,Greptile finding 2 防静默共享指纹)', () => {
  it('非生产 → 无告警', () => {
    expect(validateSsoConfig({})).toEqual([])
    expect(validateSsoConfig({ NODE_ENV: 'development' })).toEqual([])
  })
  it('生产 + SSO 开但缺网关密钥 → 告警(可伪造)', () => {
    const w = validateSsoConfig({ NODE_ENV: 'production', MIVO_TRUST_SSO_HEADER: '1' })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('MIVO_GATEWAY_SECRET')
  })
  it('生产 + SSO 开 + 有网关密钥 → 无告警', () => {
    expect(validateSsoConfig({ NODE_ENV: 'production', MIVO_TRUST_SSO_HEADER: '1', MIVO_GATEWAY_SECRET: 's3cr3t' })).toEqual([])
  })
  it('生产 + SSO 未开 → 告警(指纹共享风险)', () => {
    const w = validateSsoConfig({ NODE_ENV: 'production' })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('fingerprint')
  })
})

describe('P2 validateDebugLogsOriginConfig(debug-logs origin 启动期 fail-visible 守卫;#253-1/#253-2 修复)', () => {
  it('SC-4 非生产 → 一律无告警(MIVO_PUBLIC 未设 / NODE_ENV 非 production)', () => {
    expect(validateDebugLogsOriginConfig({})).toEqual([])
    expect(validateDebugLogsOriginConfig({ NODE_ENV: 'development' })).toEqual([])
    // 非生产即使乱配 MIVO_PUBLIC_ORIGIN 也不告警(语法校验仅生产边界触发)
    expect(
      validateDebugLogsOriginConfig({ NODE_ENV: 'development', MIVO_PUBLIC_ORIGIN: 'garbage' }),
    ).toEqual([])
  })
  it('SC-1(D1 反转)生产 + 仅配 MIVO_DEBUG_ALLOWED_ORIGINS → 告警(allowlist 不覆盖同源 POST)', () => {
    // D1 修复(#253-1):原"仅 allowlist → 无告警"用例反转。allowlist 只放行跨域命中,
    // 同源 POST 仍因 isSameOrigin 无 trusted origin 而 403 → 守卫须告警。
    const w = validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_DEBUG_ALLOWED_ORIGINS: 'https://app.example' })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('403')
    expect(w[0]).toContain('does NOT cover same-origin') // 点明 allowlist 不覆盖同源
    expect(w[0]).toContain('MIVO_PUBLIC_ORIGIN') // 指明解法
  })
  it('生产 + 三个 origin env 全空 → 告警(D1 基线;指明 403 + MIVO_PUBLIC_ORIGIN)', () => {
    const w = validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1' })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('403')
    expect(w[0]).toContain('MIVO_PUBLIC_ORIGIN')
    // NODE_ENV=production 同样触发(两种生产边界入口)
    const w2 = validateDebugLogsOriginConfig({ NODE_ENV: 'production' })
    expect(w2.length).toBe(1)
    expect(w2[0]).toContain('403')
  })
  it('SC-2 生产 + MIVO_PUBLIC_ORIGIN=合法值 → 无告警;+ MIVO_DEBUG_TRUST_XFF=1 → 无告警', () => {
    // 合法 origin(可解析)→ 无告警
    expect(
      validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_PUBLIC_ORIGIN: 'https://app.example' }),
    ).toEqual([])
    // 合法 origin + 带端口
    expect(
      validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_PUBLIC_ORIGIN: 'http://127.0.0.1:6276' }),
    ).toEqual([])
    // XFF=1 → 无告警
    expect(validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_DEBUG_TRUST_XFF: '1' })).toEqual([])
    // 合法 origin + allowlist 同配 → 无告警(两者都不触发)
    expect(
      validateDebugLogsOriginConfig({
        MIVO_PUBLIC: '1',
        MIVO_PUBLIC_ORIGIN: 'https://app.example',
        MIVO_DEBUG_ALLOWED_ORIGINS: 'https://other.example',
      }),
    ).toEqual([])
  })
  it('SC-2 边界:MIVO_DEBUG_TRUST_XFF 非 "1" 仍告警(与 debug-logs gate 的 ==="1" 判定一致)', () => {
    // 'true' / '0' 不等于 '1' → 仍告警(D1 触发)
    expect(validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_DEBUG_TRUST_XFF: 'true' }).length).toBe(1)
    expect(validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_DEBUG_TRUST_XFF: '0' }).length).toBe(1)
  })
  it('SC-3(D2)生产 + MIVO_PUBLIC_ORIGIN=garbage(不可解析)→ 独立语法告警', () => {
    // 无 scheme → new URL 抛 → parseSerializedOrigin 返 null
    const w = validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_PUBLIC_ORIGIN: 'not-a-valid-origin' })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('403')
    expect(w[0]).toContain('not a parseable serialized origin')
    // 带 path 的 origin(可被 new URL 解析但 pathname!=='/')→ 仍不可解析
    const w2 = validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_PUBLIC_ORIGIN: 'https://app.example/path' })
    expect(w2.length).toBe(1)
    expect(w2[0]).toContain('not a parseable serialized origin')
    // 非 http(s) scheme → 不可解析
    const w3 = validateDebugLogsOriginConfig({ MIVO_PUBLIC: '1', MIVO_PUBLIC_ORIGIN: 'ftp://app.example' })
    expect(w3.length).toBe(1)
    expect(w3[0]).toContain('not a parseable serialized origin')
  })
  it('SC-3/SC-1 互斥:garbage origin + allowlist → 仅 D2 语法告警(D1 不叠加)', () => {
    // publicOrigin 非空(垃圾)→ D1 不触发(需 publicOrigin 空),D2 触发;至多一条告警
    const w = validateDebugLogsOriginConfig({
      MIVO_PUBLIC: '1',
      MIVO_PUBLIC_ORIGIN: 'garbage',
      MIVO_DEBUG_ALLOWED_ORIGINS: 'https://app.example',
    })
    expect(w.length).toBe(1)
    expect(w[0]).toContain('not a parseable serialized origin')
  })
})

describe('T1.4 header 常量', () => {
  it('SSO + 网关密钥 header 名', () => {
    expect(SSO_TRUSTED_USER_HEADER).toBe('x-mivo-auth-user')
    expect(GATEWAY_SECRET_HEADER).toBe('x-mivo-gateway-secret')
  })
})

describe('T1.4 ssoHeaderSecretOk(P1-2 fail-closed:无密钥任何模式都不信任 SSO header)', () => {
  it('配置了密钥 → 须匹配', () => {
    expect(ssoHeaderSecretOk({ MIVO_GATEWAY_SECRET: 's3cr3t' }, 's3cr3t')).toBe(true)
    expect(ssoHeaderSecretOk({ MIVO_GATEWAY_SECRET: 's3cr3t' }, 'wrong')).toBe(false)
    expect(ssoHeaderSecretOk({ MIVO_GATEWAY_SECRET: 's3cr3t' }, undefined)).toBe(false)
  })
  it('未配置密钥 → 任何模式都 false(防伪造;dev/test 须显式设密钥)', () => {
    expect(ssoHeaderSecretOk({}, undefined)).toBe(false)
    expect(ssoHeaderSecretOk({ NODE_ENV: 'development' }, undefined)).toBe(false)
    expect(ssoHeaderSecretOk({ NODE_ENV: 'production' }, undefined)).toBe(false)
    expect(ssoHeaderSecretOk({ NODE_ENV: 'production' }, 'anything')).toBe(false)
  })
})
