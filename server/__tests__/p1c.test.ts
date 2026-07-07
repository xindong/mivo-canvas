// @vitest-environment node
// server/__tests__/p1c.test.ts
// P1-c generate-group mock tests. Drives the real BFF (app + @hono/node-server)
// against a local mock upstream (platform + llm-proxy). Covers code-derived
// scenarios that cannot hit real upstreams: platform chain, 401 retry-once,
// token/chatSession single-flight, poll timeout, 4xx/5xx passthrough, 413 (D1),
// upstream timeout 504, enhance no-key/degraded/generate/chat, edit upload 502.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { serve } from '@hono/node-server'
import type { Server } from 'node:http'
import { Buffer } from 'node:buffer'
import { app } from '../app'
import { resetPlatformState, mivoPlatformEnsureToken, mivoPlatformEnsureChatSession } from '../platform/state'
import { defaultMockState, startMockUpstream, type MockState } from './mockUpstream'

const BASE_ENV: Record<string, string> = {
  MIVO_PLATFORM_KEY: 'mivo_test',
  MIVO_IMAGE_API_KEY: 'sk_test',
  MIVO_LLM_API_KEY: 'sk_test',
  MIVO_UPSTREAM_TIMEOUT_MS: '200',
  MIVO_EDIT_UPSTREAM_TIMEOUT_MS: '200',
  MIVO_ENHANCE_PRIMARY_TIMEOUT_MS: '200',
  MIVO_ENHANCE_FALLBACK_TIMEOUT_MS: '200',
  MIVO_PLATFORM_POLL_DEADLINE_MS: '300',
  MIVO_PLATFORM_POLL_INTERVAL_MS: '10',
}

let bffServer: Server
let bffBase = ''
let mockState: MockState
let mockUrl = ''
let mockServer: Server

const applyEnv = (overrides: Record<string, string> = {}): void => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v
  process.env.MIVO_PLATFORM_ENDPOINT = mockUrl
  process.env.MIVO_IMAGE_API_BASE = `${mockUrl}/v1/images`
  process.env.MIVO_LLM_API_BASE = `${mockUrl}/v1`
  delete process.env.MIVO_BFF_TOKEN
  delete process.env.MIVO_LLM_API_KEY_OVERRIDE
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v
}

const req = async (
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> => {
  const res = await fetch(bffBase + path, init)
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })
  return { status: res.status, body, headers }
}

const jsonReq = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

beforeAll(async () => {
  mockState = defaultMockState()
  const up = await startMockUpstream(mockState)
  mockServer = up.server
  mockUrl = up.url
  mockState.downloadUrl = mockUrl
  applyEnv()
  await new Promise<void>((resolve) => {
    bffServer = serve(
      { fetch: app.fetch, port: 0, hostname: '127.0.0.1' },
      (info) => {
        bffBase = `http://${info.address}:${info.port}`
        resolve()
      },
    ) as unknown as Server
  })
})

afterAll(async () => {
  await new Promise<void>((r) => bffServer.close(() => r()))
  await new Promise<void>((r) => mockServer.close(() => r()))
})

beforeEach(() => {
  Object.assign(mockState, defaultMockState())
  mockState.downloadUrl = mockUrl
  resetPlatformState()
  applyEnv()
})

describe('platform channel — helpers (single-flight, 401 retry)', () => {
  it('token single-flight: 2 concurrent ensureToken → exactly 1 token call', async () => {
    const ctx = { platformKey: 'mivo_test', platformEndpoint: mockUrl }
    await Promise.all([mivoPlatformEnsureToken(ctx), mivoPlatformEnsureToken(ctx)])
    expect(mockState.tokenCalls).toBe(1)
  })

  it('chatSession single-flight: 2 concurrent ensureChatSession → exactly 1 chat call', async () => {
    const ctx = { platformKey: 'mivo_test', platformEndpoint: mockUrl }
    await Promise.all([mivoPlatformEnsureChatSession(ctx), mivoPlatformEnsureChatSession(ctx)])
    expect(mockState.chatCalls).toBe(1)
    expect(mockState.tokenCalls).toBe(1)
  })

  it('401 → refresh token → retry ONCE → success (exactly 2 fetches)', async () => {
    mockState.chat401Once = true
    const ctx = { platformKey: 'mivo_test', platformEndpoint: mockUrl }
    await mivoPlatformEnsureChatSession(ctx)
    expect(mockState.tokenCalls).toBe(2) // initial + refresh
    expect(mockState.chatCalls).toBe(2) // 401 + 200
  })

  it('401 twice → error, no third fetch, no llm-proxy fallback', async () => {
    mockState.pollFailMode = '401-always'
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect(mockState.pollCalls).toBe(2) // exactly 2, no third
    expect(mockState.generateCalls).toBe(0) // no llm-proxy fallback
  })
})

describe('platform channel — generate/edit job', () => {
  it('generate: submit→poll→download → 200 {images:[{b64}]}', async () => {
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(200)
    expect(Array.isArray((r.body as { images: unknown[] }).images)).toBe(true)
    const b64 = (r.body as { images: Array<{ b64: string }> }).images[0].b64
    expect(b64).toBe(mockState.downloadBody.toString('base64'))
    expect(mockState.tokenCalls).toBe(1)
    expect(mockState.chatCalls).toBe(1)
    expect(mockState.submitCalls).toBe(1)
    expect(mockState.pollCalls).toBe(2) // pending then completed
    expect(mockState.signUrlCalls).toBe(1)
    expect(mockState.downloadCalls).toBe(1)
  })

  it('transient submit 5xx → retries once → success', async () => {
    mockState.submitStatusSequence = [500, 200]
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(200)
    expect(mockState.submitCalls).toBe(2)
    expect(mockState.generateCalls).toBe(0)
  })

  it('platform safety-style 400 is not retried', async () => {
    mockState.submitStatus = 400
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect(mockState.submitCalls).toBe(1)
    expect(mockState.generateCalls).toBe(0)
  })

  it('platform HTTP 504 is not retried', async () => {
    mockState.submitStatus = 504
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect(mockState.submitCalls).toBe(1)
    expect(mockState.generateCalls).toBe(0)
  })

  it('ClosedChannelException poll failure → retries once → success', async () => {
    mockState.pollSequence = ['failed', 'completed']
    mockState.pollError = 'java.nio.channels.ClosedChannelException'
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(200)
    expect(mockState.submitCalls).toBe(2)
    expect(mockState.pollCalls).toBe(2)
    expect(mockState.generateCalls).toBe(0)
  })

  it('generic terminated poll failure is not treated as transient', async () => {
    mockState.pollSequence = ['failed']
    mockState.pollError = 'Image generation terminated by safety filter'
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect(mockState.submitCalls).toBe(1)
    expect(mockState.pollCalls).toBe(1)
    expect((r.body as { error: string }).error).toContain('terminated by safety filter')
  })

  it('download transient 5xx retries download only, not the full platform job', async () => {
    mockState.downloadStatusSequence = [500, 200]
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(200)
    expect(mockState.submitCalls).toBe(1)
    expect(mockState.pollCalls).toBe(2)
    expect(mockState.signUrlCalls).toBe(2)
    expect(mockState.downloadCalls).toBe(2)
  })

  it('download network retry exhaustion does not resubmit the full platform job', async () => {
    mockState.downloadResetSequence = [true, true]
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'a cat', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('platform download retry exhausted')
    expect(mockState.submitCalls).toBe(1)
    expect(mockState.pollCalls).toBe(2)
    expect(mockState.signUrlCalls).toBe(2)
    expect(mockState.downloadCalls).toBe(2)
  })

  it('platform poll failed → 502 sanitized', async () => {
    mockState.pollSequence = ['failed']
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('platform boom')
  })

  it('platform poll deadline exceeded → 504', async () => {
    mockState.pollSequence = ['pending']
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'gpt-image-2', quality: 'medium' }))
    expect(r.status).toBe(504)
    expect((r.body as { error: string }).error).toContain('上游生成超时')
    expect(mockState.submitCalls).toBe(1)
  })

  it('platform download empty → 502 结果为空', async () => {
    mockState.pollImages = []
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'gpt-image-2' }))
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('生成失败：结果为空')
  })

  it('edit (no mask, platform model) → 200 {images}, main image uploaded first', async () => {
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'main.png')
    fd.append('prompt', 'edit this')
    fd.append('model', 'gpt-image-2')
    const r = await req('/api/mivo/edit', { method: 'POST', body: fd })
    expect(r.status).toBe(200)
    expect(Array.isArray((r.body as { images: unknown[] }).images)).toBe(true)
    expect(mockState.uploadCalls).toBe(1)
    expect(mockState.submitCalls).toBe(1)
  })

  it('edit platform upload failure → 502 desensitized (no outer 500)', async () => {
    mockState.uploadStatus = 500
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from('png')], { type: 'image/png' }), 'i.png')
    fd.append('prompt', 'edit this')
    fd.append('model', 'gpt-image-2')
    const r = await req('/api/mivo/edit', { method: 'POST', body: fd })
    expect(r.status).toBe(502)
    expect((r.body as { error: string }).error).toBe('参考图上传失败，请重试或移除参考图')
  })

  it('edit (mask present) → llm-proxy path, no platform upload', async () => {
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from('png')], { type: 'image/png' }), 'i.png')
    fd.append('mask', new Blob([Buffer.from('mask')], { type: 'image/png' }), 'm.png')
    fd.append('prompt', 'edit this')
    fd.append('model', 'gpt-image-2')
    const r = await req('/api/mivo/edit', { method: 'POST', body: fd })
    expect(r.status).toBe(200)
    expect(mockState.editCalls).toBe(1)
    expect(mockState.uploadCalls).toBe(0)
  })

  // Mask-edit dual-model: gemini + mask → platform instruction-based edit (mask
  // file dropped, region clause folded into the prompt; generic clause when no bounds).
  it('edit (mask + gemini) dispatches to platform with region clause in prompt', async () => {
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from('png')], { type: 'image/png' }), 'i.png')
    fd.append('mask', new Blob([Buffer.from('mask')], { type: 'image/png' }), 'm.png')
    fd.append('prompt', 'edit this')
    fd.append('model', 'gemini-3-pro-image')
    const r = await req('/api/mivo/edit', { method: 'POST', body: fd })
    expect(r.status).toBe(200)
    expect(mockState.editCalls).toBe(0)
    expect(mockState.uploadCalls).toBe(1) // main image only — the mask file is NOT uploaded
    expect(mockState.lastSubmitBodyText).toContain('edit this')
    // 无 bounds/subject 时的通用回退 clause（已中文化）。
    expect(mockState.lastSubmitBodyText).toContain('只修改用户选中的区域')
  })

  // Non-mask-capable models still fall back to gpt-image-2 on the llm-proxy path.
  it('edit (mask + non-mask-capable model) falls back to gpt-image-2 llm-proxy', async () => {
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from('png')], { type: 'image/png' }), 'i.png')
    fd.append('mask', new Blob([Buffer.from('mask')], { type: 'image/png' }), 'm.png')
    fd.append('prompt', 'edit this')
    fd.append('model', 'doubao-seedance-2-0-260128')
    const r = await req('/api/mivo/edit', { method: 'POST', body: fd })
    expect(r.status).toBe(200)
    expect(mockState.editCalls).toBe(1)
    expect(mockState.uploadCalls).toBe(0)
    expect(mockState.lastEditBodyText).toMatch(/name="model"[\s\S]*gpt-image-2/)
  })
})

describe('llm-proxy path — generate', () => {
  it('non-platform model → llm-proxy 200 {images}', async () => {
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }))
    expect(r.status).toBe(200)
    expect(Array.isArray((r.body as { images: unknown[] }).images)).toBe(true)
    expect(mockState.generateCalls).toBe(1)
  })

  it('upstream 4xx/5xx passthrough (status verbatim + {error})', async () => {
    mockState.generateStatus = 401
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }))
    expect(r.status).toBe(401)
    expect((r.body as { error: string }).error).toBe('generate failed')
  })

  it('upstream timeout → 504 {error:"Image API request timed out"}', async () => {
    mockState.generateDelayMs = 1000
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }))
    expect(r.status).toBe(504)
    expect((r.body as { error: string }).error).toBe('Image API request timed out')
  })
})

describe('enhance', () => {
  it('no LLM key → 200 {enhanced:false, degradedReason:"no-key"}', async () => {
    delete process.env.MIVO_LLM_API_KEY
    delete process.env.MIVO_IMAGE_API_KEY
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'a cat' }))
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ enhanced: false, degradedReason: 'no-key' })
    expect(mockState.enhanceCalls).toBe(0)
  })

  it('W4 both models fail (http) → 200 degraded {degradedReason:upstream-http, stage:fallback}', async () => {
    mockState.enhanceStatus = 500
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'a cat' }))
    expect(r.status).toBe(200)
    expect((r.body as { enhanced: boolean }).enhanced).toBe(false)
    expect((r.body as { degradedReason: string }).degradedReason).toBe('upstream-http')
    expect((r.body as { stage: string }).stage).toBe('fallback')
    expect(mockState.enhanceCalls).toBe(2) // primary + fallback
  })

  it('W4 upstream timeout → 200 degraded {degradedReason:timeout, stage:fallback}', async () => {
    mockState.enhanceDelayMs = 1000
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'a cat' }))
    expect(r.status).toBe(200)
    expect((r.body as { degradedReason: string }).degradedReason).toBe('timeout')
    expect((r.body as { stage: string }).stage).toBe('fallback')
  })

  it('W4 bad-json (LLM returns non-agreed content) → 200 degraded {degradedReason:bad-json, stage:fallback}', async () => {
    mockState.enhanceBody = { choices: [{ message: { content: 'this is not json' } }] }
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'a cat' }))
    expect(r.status).toBe(200)
    expect((r.body as { enhanced: boolean }).enhanced).toBe(false)
    expect((r.body as { degradedReason: string }).degradedReason).toBe('bad-json')
    expect((r.body as { stage: string }).stage).toBe('fallback')
    expect(mockState.enhanceCalls).toBe(2) // primary bad-json + fallback bad-json
  })

  it('W4 upstream-network (LLM endpoint unreachable) → 200 degraded {degradedReason:upstream-network, stage:fallback}', async () => {
    applyEnv({ MIVO_LLM_API_BASE: 'http://127.0.0.1:1' })
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'a cat' }))
    expect(r.status).toBe(200)
    expect((r.body as { enhanced: boolean }).enhanced).toBe(false)
    expect((r.body as { degradedReason: string }).degradedReason).toBe('upstream-network')
    expect((r.body as { stage: string }).stage).toBe('fallback')
    expect(mockState.enhanceCalls).toBe(0) // never reached the mock
  })

  it('200 generate mode (ratio/quality clamped)', async () => {
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'a cat', modelId: 'gpt-image-2' }))
    expect(r.status).toBe(200)
    const body = r.body as { mode: string; scene: string; imgRatio: string; quality: string; enhanced: boolean }
    expect(body.mode).toBe('generate')
    expect(body.scene).toBe('scene')
    expect(body.imgRatio).toBe('1:1')
    expect(body.quality).toBe('medium')
    expect(body.enhanced).toBe(true)
  })

  it('system prompt blocks real-person likeness and brand/IP names in richPrompt', async () => {
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: 'Mario celebrates like Ronaldo on a Switch', modelId: 'gpt-image-2' }))
    expect(r.status).toBe(200)
    expect(mockState.lastEnhanceBodyText).toContain('must not output real person')
    expect(mockState.lastEnhanceBodyText).toContain('a fictional footballer performing an iconic celebratory jump')
    expect(mockState.lastEnhanceBodyText).toContain('must not output brand, IP, or product names')
    expect(mockState.lastEnhanceBodyText).toContain('bright family-friendly 3D platformer aesthetic')
  })

  it('W4 IP 泛化：刺客信条奥德赛/Mario/C罗/奥德赛 → enhanced:true + system prompt 含 IP 泛化规则', async () => {
    // mock LLM 不打真上游；验证 enhance 路由对含 IP/真名的输入正常返 enhanced:true，
    // 且发给 LLM 的 system prompt 一致携带 IP 泛化规则（不因输入不同而漏注入）。
    for (const prompt of ['刺客信条奥德赛的主角', 'Mario 跳跃', 'C罗庆祝动作', '奥德赛']) {
      mockState.enhanceCalls = 0
      const r = await req('/api/mivo/enhance', jsonReq({ prompt, modelId: 'gpt-image-2' }))
      expect(r.status).toBe(200)
      expect((r.body as { enhanced: boolean }).enhanced).toBe(true)
      expect(mockState.enhanceCalls).toBe(1) // primary 成功，不调 fallback
      expect(mockState.lastEnhanceBodyText).toContain('must not output real person')
      expect(mockState.lastEnhanceBodyText).toContain('must not output brand, IP, or product names')
    }
  })

  it('200 chat mode (replyText normalized, no markdown)', async () => {
    mockState.enhanceBody = {
      choices: [{ message: { content: '{"mode":"chat","replyText":"**bold** 你好，画一只猫"}' } }],
    }
    const r = await req('/api/mivo/enhance', jsonReq({ prompt: '画一只猫' }))
    expect(r.status).toBe(200)
    const body = r.body as { mode: string; replyText: string; enhanced: boolean }
    expect(body.mode).toBe('chat')
    expect(body.replyText).not.toContain('**')
    expect(body.replyText).toContain('猫')
    expect(body.enhanced).toBe(true)
  })

  it('edit intent: edit-specific system prompt + px user content + generate mode response', async () => {
    // mask-chat-card Step 2: intent='edit' routes through edit system prompt
    // (preserve/unmasked) and edit user content (source pixel space, "px",
    // never "normalized"). Response shape unchanged — still mode/richPrompt.
    const r = await req(
      '/api/mivo/enhance',
      jsonReq({
        prompt: 'change the cape to red',
        intent: 'edit',
        editContext: {
          sourceTitle: 'hero-001',
          hasMask: true,
          maskKind: 'bounds',
          maskBoundsPx: { x: 720, y: 0, width: 160, height: 200 },
          sourceSize: { width: 1024, height: 1024 },
        },
        modelId: 'gpt-image-2',
      }),
    )
    expect(r.status).toBe(200)
    const body = r.body as { mode: string; richPrompt: string; enhanced: boolean }
    expect(body.mode).toBe('generate')
    expect(body.richPrompt).toBe('rich')
    expect(body.enhanced).toBe(true)
    expect(mockState.enhanceCalls).toBe(1) // primary succeeds, no fallback
    // edit-specific system prompt rules
    expect(mockState.lastEnhanceBodyText).toContain('preserve')
    expect(mockState.lastEnhanceBodyText).toContain('unmasked')
    // user content carries source pixel space marker, never "normalized"
    expect(mockState.lastEnhanceBodyText).toContain('px')
    expect(mockState.lastEnhanceBodyText).not.toContain('normalized')
    // edit user content structure
    expect(mockState.lastEnhanceBodyText).toContain('Edit instruction: change the cape to red')
    expect(mockState.lastEnhanceBodyText).toContain('Source title: hero-001')
    expect(mockState.lastEnhanceBodyText).toContain('Mask: bounds')
    expect(mockState.lastEnhanceBodyText).toContain('Mask bounds (px, in source image space): 720,0,160,200')
    expect(mockState.lastEnhanceBodyText).toContain('Source size: 1024x1024 px')
  })

  it('edit intent without maskBoundsPx/sourceSize omits those lines (no fabrication)', async () => {
    const r = await req(
      '/api/mivo/enhance',
      jsonReq({
        prompt: 'brighten the whole image',
        intent: 'edit',
        editContext: { sourceTitle: 'scene-042', hasMask: false },
        modelId: 'gpt-image-2',
      }),
    )
    expect(r.status).toBe(200)
    expect(mockState.enhanceCalls).toBe(1)
    expect(mockState.lastEnhanceBodyText).toContain('Mask: none')
    expect(mockState.lastEnhanceBodyText).not.toContain('Mask bounds')
    expect(mockState.lastEnhanceBodyText).not.toContain('Source size')
    expect(mockState.lastEnhanceBodyText).not.toContain('normalized')
  })

  it('edit intent with non-conforming editContext shape drops fields silently (no 400)', async () => {
    // junk fields + wrong types must be dropped, not rejected.
    const r = await req(
      '/api/mivo/enhance',
      jsonReq({
        prompt: 'fix the eyes',
        intent: 'edit',
        editContext: {
          sourceTitle: 42,
          hasMask: 'yes',
          maskKind: 'polygon',
          maskBoundsPx: { x: 'a', y: 0, width: 10, height: 10 },
          sourceSize: { width: 'big', height: 1024 },
          extraUnknownField: 'drop me',
        },
        modelId: 'gpt-image-2',
      }),
    )
    expect(r.status).toBe(200)
    expect(mockState.enhanceCalls).toBe(1)
    // all non-conforming fields dropped → falls back to untitled / none
    expect(mockState.lastEnhanceBodyText).toContain('Source title: untitled')
    expect(mockState.lastEnhanceBodyText).toContain('Mask: none')
    expect(mockState.lastEnhanceBodyText).not.toContain('Mask bounds')
    expect(mockState.lastEnhanceBodyText).not.toContain('Source size')
    expect(mockState.lastEnhanceBodyText).not.toContain('drop me')
  })

  it('intent other than "edit" falls back to generate path (generate system prompt, no edit user content)', async () => {
    // 'generate' / unknown intent values must NOT trigger edit prompt.
    const r = await req(
      '/api/mivo/enhance',
      jsonReq({
        prompt: 'a castle',
        intent: 'generate',
        editContext: { sourceTitle: 'ignored', hasMask: true, maskKind: 'bounds' },
        modelId: 'gpt-image-2',
      }),
    )
    expect(r.status).toBe(200)
    expect(mockState.enhanceCalls).toBe(1)
    // generate system prompt marker (Persona line is generate-only)
    expect(mockState.lastEnhanceBodyText).toContain('Persona: you help create')
    // edit-specific markers absent
    expect(mockState.lastEnhanceBodyText).not.toContain('Edit instruction')
    expect(mockState.lastEnhanceBodyText).not.toContain('preserve unmasked')
    // editContext ignored on generate path
    expect(mockState.lastEnhanceBodyText).not.toContain('Source title: ignored')
  })
})

describe('method / validation / 413 (D1 clean)', () => {
  it('generate GET → 405 {error:"Method not allowed"}', async () => {
    const r = await req('/api/mivo/generate', { method: 'GET' })
    expect(r.status).toBe(405)
    expect((r.body as { error: string }).error).toBe('Method not allowed')
  })

  it('generate missing prompt → 400', async () => {
    const r = await req('/api/mivo/generate', jsonReq({}))
    expect(r.status).toBe(400)
    expect((r.body as { error: string }).error).toBe('prompt is required')
  })

  it('generate platform model, no MIVO_PLATFORM_KEY → 500 (D9 unchanged)', async () => {
    process.env.MIVO_PLATFORM_KEY = ''
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'gpt-image-2' }))
    expect(r.status).toBe(500)
    expect((r.body as { error: string }).error).toContain('MIVO_PLATFORM_KEY')
  })

  it('generate JSON >1MB → clean 413 (D1: observable 413, not ECONNRESET)', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10)
    const r = await req('/api/mivo/generate', jsonReq({ prompt: big, model: 'doubao-seedance-2-0-260128' }))
    expect(r.status).toBe(413)
    expect((r.body as { error: string }).error).toBe('Request body is too large')
  })

  it('edit multipart over limit → clean 413 (D1)', async () => {
    process.env.MIVO_IMAGE_REQUEST_MAX_BYTES = '64'
    const fd = new FormData()
    fd.append('image', new Blob([Buffer.from('x'.repeat(200))], { type: 'image/png' }), 'big.png')
    fd.append('prompt', 'edit')
    fd.append('model', 'doubao-seedance-2-0-260128')
    const r = await req('/api/mivo/edit', { method: 'POST', body: fd })
    expect(r.status).toBe(413)
    expect((r.body as { error: string }).error).toBe('Request body is too large')
  })

  it('enhance GET → 405; missing prompt (with key) → 400', async () => {
    const r1 = await req('/api/mivo/enhance', { method: 'GET' })
    expect(r1.status).toBe(405)
    const r2 = await req('/api/mivo/enhance', jsonReq({}))
    expect(r2.status).toBe(400)
    expect((r2.body as { error: string }).error).toBe('prompt is required')
  })
})

describe('compose-mask-edit — 结构化整理逐条编辑要求', () => {
  it('条数与红圈一致时返回 requirements', async () => {
    mockState.enhanceBody = {
      choices: [
        {
          message: {
            content:
              '{"requirements":["1.务必只去除图2中1号红圈（最左侧）范围内的蓝色烟雾。画面中其他蓝色烟雾一律保留，不要误删其他蓝色烟雾。","2.将图2中2号红圈范围内的左眼改成红色。红圈范围内除左眼以外的内容保持不变，其他相似内容不要误改。"]}',
          },
        },
      ],
    }
    const r = await req(
      '/api/mivo/compose-mask-edit',
      jsonReq({
        instruction: '去除蓝色烟雾，左眼改成红色',
        anchors: [
          { n: 1, label: '蓝色烟雾', position: '最左侧' },
          { n: 2, label: '左眼' },
        ],
      }),
    )
    expect(r.status).toBe(200)
    const body = r.body as { requirements: string[] }
    expect(body.requirements).toHaveLength(2)
    expect(body.requirements[0]).toContain('1号红圈（最左侧）范围内的蓝色烟雾')
    expect(body.requirements[1]).toContain('左眼改成红色')
  })

  it('条数与红圈不符 → 判定映射不可靠，requirements 空（前端回退）', async () => {
    mockState.enhanceBody = {
      choices: [{ message: { content: '{"requirements":["1.只有一条但有两个圈"]}' } }],
    }
    const r = await req(
      '/api/mivo/compose-mask-edit',
      jsonReq({
        instruction: '随便改',
        anchors: [
          { n: 1, label: 'a' },
          { n: 2, label: 'b' },
        ],
      }),
    )
    expect(r.status).toBe(200)
    const body = r.body as { requirements: string[]; degradedReason?: string }
    expect(body.requirements).toHaveLength(0)
    expect(body.degradedReason).toBe('upstream')
  })

  it('空 instruction 或无 anchors → noop', async () => {
    const r = await req('/api/mivo/compose-mask-edit', jsonReq({ instruction: '', anchors: [] }))
    expect(r.status).toBe(200)
    expect((r.body as { requirements: string[] }).requirements).toHaveLength(0)
  })
})

describe('requestId + shape', () => {
  it('response carries X-Request-Id header (uuid)', async () => {
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }))
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('generate 200 body shape is {images:[{b64:string}]}', async () => {
    const r = await req('/api/mivo/generate', jsonReq({ prompt: 'x', model: 'doubao-seedance-2-0-260128' }))
    expect(r.status).toBe(200)
    const body = r.body as { images: Array<{ b64: string }> }
    expect(body.images).toHaveLength(1)
    expect(typeof body.images[0].b64).toBe('string')
  })
})
