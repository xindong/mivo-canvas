// server/__tests__/owner.test.ts
// T1.4 owner.ts 纯函数 + 配置校验单测(SSO trust flag + 网关密钥 + 生产告警)。
import { describe, it, expect } from 'vitest'
import { isSsoHeaderTrusted, validateSsoConfig, SSO_TRUSTED_USER_HEADER, GATEWAY_SECRET_HEADER } from '../lib/owner'

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

describe('T1.4 header 常量', () => {
  it('SSO + 网关密钥 header 名', () => {
    expect(SSO_TRUSTED_USER_HEADER).toBe('x-mivo-auth-user')
    expect(GATEWAY_SECRET_HEADER).toBe('x-mivo-gateway-secret')
  })
})
