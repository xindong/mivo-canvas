// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEnvConfig, resolveEditUpstreamTimeoutMs, resolveMivoPlatformPollDeadlineMs } from './config'

const deadlineEnvKeys = [
  'MIVO_PLATFORM_POLL_DEADLINE_MS',
  'MIVO_PLATFORM_POLL_DEADLINE_1K_MS',
  'MIVO_PLATFORM_POLL_DEADLINE_2K_MS',
  'MIVO_EDIT_UPSTREAM_TIMEOUT_MS',
] as const

const savedEnv: Partial<Record<(typeof deadlineEnvKeys)[number], string>> = {}

describe('platform poll deadline config', () => {
  beforeEach(() => {
    for (const key of deadlineEnvKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of deadlineEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('defaults to 240s for 1K and 300s for 2K', () => {
    const config = getEnvConfig()
    expect(config.platformPollDeadlineByResolutionMs).toEqual({ '1K': 240_000, '2K': 300_000 })
    expect(resolveMivoPlatformPollDeadlineMs('1K', config)).toBe(240_000)
    expect(resolveMivoPlatformPollDeadlineMs('2K', config)).toBe(300_000)
    expect(resolveMivoPlatformPollDeadlineMs('unknown', config)).toBe(240_000)
  })

  it('uses MIVO_PLATFORM_POLL_DEADLINE_MS as a global override for both tiers', () => {
    process.env.MIVO_PLATFORM_POLL_DEADLINE_MS = '1234'
    const config = getEnvConfig()
    expect(config.platformPollDeadlineByResolutionMs).toEqual({ '1K': 1234, '2K': 1234 })
    expect(config.platformPollDeadlineMs).toBe(1234)
  })

  it('allows independent tier overrides', () => {
    process.env.MIVO_PLATFORM_POLL_DEADLINE_1K_MS = '2401'
    process.env.MIVO_PLATFORM_POLL_DEADLINE_2K_MS = '3002'
    const config = getEnvConfig()
    expect(config.platformPollDeadlineByResolutionMs).toEqual({ '1K': 2401, '2K': 3002 })
    expect(config.platformPollDeadlineMs).toBe(3002)
  })
})

describe('edit upstream timeout tiering (edit-timeout-batch)', () => {
  beforeEach(() => {
    delete process.env.MIVO_EDIT_UPSTREAM_TIMEOUT_MS
  })
  afterEach(() => {
    delete process.env.MIVO_EDIT_UPSTREAM_TIMEOUT_MS
  })

  it('low/medium → 180s; high → 300s (对齐 platform 2K)', () => {
    const config = getEnvConfig()
    expect(resolveEditUpstreamTimeoutMs({ quality: 'low' }, config)).toBe(180_000)
    expect(resolveEditUpstreamTimeoutMs({ quality: 'medium' }, config)).toBe(180_000)
    expect(resolveEditUpstreamTimeoutMs({ quality: 'high' }, config)).toBe(300_000)
  })

  it('大尺寸 imgRatio (16:9 / 9:16) → 300s，与 quality 无关', () => {
    const config = getEnvConfig()
    expect(resolveEditUpstreamTimeoutMs({ quality: 'medium', imgRatio: '16:9' }, config)).toBe(300_000)
    expect(resolveEditUpstreamTimeoutMs({ quality: 'low', imgRatio: '9:16' }, config)).toBe(300_000)
    expect(resolveEditUpstreamTimeoutMs({ quality: 'medium', imgRatio: '1:1' }, config)).toBe(180_000)
    expect(resolveEditUpstreamTimeoutMs({ quality: 'medium', imgRatio: '3:2' }, config)).toBe(180_000)
  })

  it('quality/ratio 缺省 → 180s（保守低档）', () => {
    const config = getEnvConfig()
    expect(resolveEditUpstreamTimeoutMs({}, config)).toBe(180_000)
    expect(resolveEditUpstreamTimeoutMs({ imgRatio: '1:1' }, config)).toBe(180_000)
  })

  it('MIVO_EDIT_UPSTREAM_TIMEOUT_MS 整体覆盖（优先级最高，不分档）', () => {
    process.env.MIVO_EDIT_UPSTREAM_TIMEOUT_MS = '99999'
    const config = getEnvConfig()
    expect(resolveEditUpstreamTimeoutMs({ quality: 'high', imgRatio: '16:9' }, config)).toBe(99999)
    expect(resolveEditUpstreamTimeoutMs({ quality: 'low' }, config)).toBe(99999)
  })
})
