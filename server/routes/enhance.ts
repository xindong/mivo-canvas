// server/routes/enhance.ts
// POST /api/mivo/enhance — ported from vite.config.ts proxyMivoEnhance L1301-L1401 +
// helpers (buildEnhanceSystemPrompt / normalizeChatReplyText / parseEnhanceJson / callEnhanceLlm).
// Degraded chain: primary claude-haiku-4-5 (8s) → fallback gpt-5.4-mini (8s).
// Never 5xx for upstream failures (graceful degrade to 200 {enhanced:false, degradedReason}).
import type { Handler } from 'hono'
import type { HttpBindings } from '@hono/node-server'
import {
  getEnvConfig,
  mivoEnhanceFallbackModel,
  mivoEnhancePrimaryModel,
  mivoModelDefaultRatio,
  mivoModelRatioMap,
} from '../lib/config'
import { RequestBodyTooLargeError, UpstreamRequestTimeoutError, fetchUpstreamWithTimeout } from '../lib/upstream'
import { logRequest, newRequestId, readJsonBody } from '../lib/request'

const buildEnhanceSystemPrompt = (allowedRatios: string[]): string =>
  `You are Mivo, a game art creative design assistant. Return ONLY one JSON object.
Modes:
- Use "chat" for questions, discussion, advice, capability questions, casual talk, or ambiguous intent. Return {"mode":"chat","replyText":"中文纯文本，简洁自然，200字以内；歧义时追问澄清"}.
- Chat replyText must not use markdown, bullets, headings, bold markers, or asterisks.
- Use "generate" only when the user clearly asks to generate/draw/modify/outpaint/restyle/create a set. Return mode, scene, reasoning, richPrompt, imgRatio, quality.
Persona: you help create game characters, scenes, UI, props, logos, style transfer, outpainting, element separation, sprite/action/VFX assets, design advice, and visual optimization.
Generate rules:
- richPrompt must be vivid English, faithful to user intent; do not add unmentioned entities or pile words like masterpiece/8k/cinematic/high quality.
- For image prompts, avoid negative safety disclaimers such as "no blood or violence" and avoid unnecessary weapon emphasis; describe the intended peaceful or neutral visual outcome in affirmative terms.
- imgRatio must be one of: ${allowedRatios.join(', ')}.
- quality is low, medium, or high. Default medium; high only for explicit print-grade, fine detail, or preserving small text.
- Chinese or short generate requests should become specific English prompts.
- With history, treat it as refinement and evolve the previous direction.`

type EnhanceLlmResponse = {
  choices?: Array<{ message?: { content?: string } }>
}
type EnhanceParsed = {
  mode: 'chat' | 'generate'
  replyText?: string
  scene?: string
  reasoning?: string
  richPrompt?: string
  imgRatio?: string
  quality?: string
}

const normalizeChatReplyText = (value: string): string => {
  const text = value
    .replace(/\*\*/g, '')
    .replace(/[`#]/g, '')
    .replace(/^[\s>*•-]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

const parseEnhanceJson = (raw: string): EnhanceParsed | null => {
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const parsed = JSON.parse(stripped) as Record<string, unknown>
    const mode = parsed.mode === 'chat' ? 'chat' : 'generate'
    if (mode === 'chat' && typeof parsed.replyText === 'string' && parsed.replyText.trim()) {
      return { mode, replyText: normalizeChatReplyText(parsed.replyText) }
    }
    if (
      typeof parsed.scene === 'string' &&
      typeof parsed.reasoning === 'string' &&
      typeof parsed.richPrompt === 'string' &&
      typeof parsed.imgRatio === 'string' &&
      typeof parsed.quality === 'string'
    ) {
      return {
        mode: 'generate',
        scene: parsed.scene,
        reasoning: parsed.reasoning,
        richPrompt: parsed.richPrompt,
        imgRatio: parsed.imgRatio,
        quality: parsed.quality,
      }
    }
    return null
  } catch {
    return null
  }
}

const callEnhanceLlm = async (
  model: string,
  messages: Array<{ role: string; content: string }>,
  llmApiKey: string,
  timeoutMs: number,
  llmApiBase: string,
): Promise<{ result: EnhanceParsed | null; reason: string }> => {
  try {
    const response = await fetchUpstreamWithTimeout(
      `${llmApiBase}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${llmApiKey}`, 'Content-Type': 'application/json' },
        // No response_format: kimi faster without it; qwen hangs with json_object (probe-results.md)
        body: JSON.stringify({ model, messages }),
      },
      timeoutMs,
    )
    if (!response.ok) return { result: null, reason: 'upstream-error' }
    const payload = (await response.json()) as EnhanceLlmResponse
    const content = payload.choices?.[0]?.message?.content || ''
    const parsed = parseEnhanceJson(content)
    return { result: parsed, reason: parsed ? '' : 'bad-json' }
  } catch (error) {
    return {
      result: null,
      reason: error instanceof UpstreamRequestTimeoutError ? 'timeout' : 'upstream-error',
    }
  }
}

type EnhanceRequestBody = {
  prompt?: unknown
  modelId?: unknown
  history?: unknown
  hasSelectedImage?: unknown
  sceneId?: unknown
}

export const enhanceHandler: Handler<{ Bindings: HttpBindings }> = async (c) => {
  const requestId = newRequestId()
  c.header('X-Request-Id', requestId)
  const t0 = Date.now()
  const log = (status: number, upstream?: string, note?: string): void => {
    logRequest({
      method: c.req.method,
      path: c.req.path,
      requestId,
      status,
      upstream,
      latencyMs: Date.now() - t0,
      note,
    })
  }
  const env = getEnvConfig()
  try {
    if (c.req.method !== 'POST') {
      log(405)
      return c.json({ error: 'Method not allowed' }, 405)
    }

    if (!env.llmApiKey.trim()) {
      log(200, 'no-key')
      return c.json({ enhanced: false, degradedReason: 'no-key' }, 200)
    }

    const body = await readJsonBody<EnhanceRequestBody>(c)
    const prompt = String(body.prompt || '').trim()
    if (!prompt) {
      log(400)
      return c.json({ error: 'prompt is required' }, 400)
    }

    const modelId = typeof body.modelId === 'string' && body.modelId.trim() ? body.modelId.trim() : 'gpt-image-2'
    const allowedRatios = mivoModelRatioMap[modelId] ?? mivoModelRatioMap['gpt-image-2']
    const defaultRatio = mivoModelDefaultRatio[modelId] ?? '1:1'

    type HistoryEntry = { role: string; content: string }
    const historyEntries: HistoryEntry[] = Array.isArray(body.history)
      ? (body.history as unknown[])
          .filter(
            (entry): entry is HistoryEntry =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as HistoryEntry).role === 'string' &&
              typeof (entry as HistoryEntry).content === 'string',
          )
          .slice(-6)
      : []

    const systemPrompt = buildEnhanceSystemPrompt(allowedRatios)
    const userContent =
      historyEntries.length > 0
        ? `Previous conversation:\n${historyEntries.map((e) => `${e.role}: ${e.content}`).join('\n')}\n\nNew request: ${prompt}`
        : prompt

    const llmMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]

    // D11 (intentional change): primary is claude-haiku-4-5 @ 8s. The stale dev
    // comment "Primary: kimi-k2.6 (10s)" was wrong; behavior already matched the
    // constants. Migration uses the constants and the corrected comment.
    let { result, reason: degradedReason } = await callEnhanceLlm(
      mivoEnhancePrimaryModel,
      llmMessages,
      env.llmApiKey.trim(),
      env.enhancePrimaryTimeoutMs,
      env.llmApiBase,
    )

    // Fallback: fast JSON-stable mini model (8s)
    if (!result) {
      const fallback = await callEnhanceLlm(
        mivoEnhanceFallbackModel,
        llmMessages,
        env.llmApiKey.trim(),
        env.enhanceFallbackTimeoutMs,
        env.llmApiBase,
      )
      result = fallback.result
      if (!result) degradedReason = fallback.reason || degradedReason
    }

    if (!result) {
      log(200, `degraded:${degradedReason}`)
      return c.json({ enhanced: false, degradedReason }, 200)
    }

    if (result.mode === 'chat') {
      log(200, 'chat')
      return c.json({ mode: 'chat', replyText: result.replyText, enhanced: true }, 200)
    }

    const clampedRatio =
      typeof result.imgRatio === 'string' && (allowedRatios as string[]).includes(result.imgRatio)
        ? result.imgRatio
        : defaultRatio
    const quality =
      typeof result.quality === 'string' && ['low', 'medium', 'high'].includes(result.quality)
        ? result.quality
        : 'medium'

    log(200, 'generate')
    return c.json(
      {
        mode: 'generate',
        scene: result.scene,
        reasoning: result.reasoning,
        richPrompt: result.richPrompt,
        imgRatio: clampedRatio,
        quality,
        enhanced: true,
      },
      200,
    )
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 500
    log(status, error instanceof UpstreamRequestTimeoutError ? 'timeout' : 'error')
    return c.json({ error: error instanceof Error ? error.message : 'Unable to enhance prompt' }, status)
  }
}
