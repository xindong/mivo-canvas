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
import { rejectInvalidGatewayKey, resolveGatewayKey } from '../lib/keys'

// intent='edit' → edit-specific system prompt (partial-modification guidance).
// intent omitted / 'generate' / anything else → existing generate prompt, byte-for-byte unchanged.
const buildEnhanceSystemPrompt = (allowedRatios: string[], intent?: 'generate' | 'edit'): string => {
  if (intent === 'edit') {
    return `You are Mivo, a game art creative design assistant. Return ONLY one JSON object.
Modes:
- Use "chat" for questions, discussion, advice, capability questions, casual talk, or ambiguous intent. Return {"mode":"chat","replyText":"中文纯文本，简洁自然，200字以内；歧义时追问澄清"}.
- Chat replyText must not use markdown, bullets, headings, bold markers, or asterisks.
- Use "generate" when the user asks to edit, modify, or refine a selected region of an existing image. Return mode, scene, reasoning, richPrompt, imgRatio, quality.
Edit intent:
- The user's input is a PARTIAL MODIFICATION INSTRUCTION for a selected/masked region of an existing source image, NOT a description of a brand-new image or full scene.
- richPrompt must be a vivid English EDIT INSTRUCTION describing ONLY what should change in the selected/masked area.
- preserve unmasked areas: do not instruct changes outside the user-indicated mask/selection.
- preserve source identity: keep the existing character, object, lighting, style, and composition continuity of the source image.
- Only change the selected/masked area; do not invent a full new scene or replace the overall image.
- richPrompt must be vivid English, faithful to user intent; do not add unmentioned entities or pile words like masterpiece/8k/cinematic/high quality.
- For image prompts, avoid negative safety disclaimers such as "no blood or violence" and avoid unnecessary weapon emphasis; describe the intended peaceful or neutral visual outcome in affirmative terms.
- richPrompt must not output real person's names, portrait likeness, team logos, jersey marks, or other identifying real-world persona signals. When the user references a real person, generalize to a fictional role description, e.g. "a fictional footballer performing an iconic celebratory jump".
- richPrompt must not output brand, IP, or product names such as Mario, Nintendo Switch, or Sonic. Convert them to generic art-direction language, e.g. "bright family-friendly 3D platformer aesthetic".
- imgRatio must be one of: ${allowedRatios.join(', ')}.
- quality is low, medium, or high. Default medium; high only for explicit print-grade, fine detail, or preserving small text.
- Chinese or short edit requests should become specific English edit instructions.
- With history, treat it as refinement and evolve the previous edit direction.`
  }
  return `You are Mivo, a game art creative design assistant. Return ONLY one JSON object.
Modes:
- Use "chat" for questions, discussion, advice, capability questions, casual talk, or ambiguous intent. Return {"mode":"chat","replyText":"中文纯文本，简洁自然，200字以内；歧义时追问澄清"}.
- Chat replyText must not use markdown, bullets, headings, bold markers, or asterisks.
- Use "generate" only when the user clearly asks to generate/draw/modify/outpaint/restyle/create a set. Return mode, scene, reasoning, richPrompt, imgRatio, quality.
Persona: you help create game characters, scenes, UI, props, logos, style transfer, outpainting, element separation, sprite/action/VFX assets, design advice, and visual optimization.
Generate rules:
- richPrompt must be vivid English, faithful to user intent; do not add unmentioned entities or pile words like masterpiece/8k/cinematic/high quality.
- For image prompts, avoid negative safety disclaimers such as "no blood or violence" and avoid unnecessary weapon emphasis; describe the intended peaceful or neutral visual outcome in affirmative terms.
- richPrompt must not output real person's names, portrait likeness, team logos, jersey marks, or other identifying real-world persona signals. When the user references a real person, generalize to a fictional role description, e.g. "a fictional footballer performing an iconic celebratory jump".
- richPrompt must not output brand, IP, or product names such as Mario, Nintendo Switch, or Sonic. Convert them to generic art-direction language, e.g. "bright family-friendly 3D platformer aesthetic".
- imgRatio must be one of: ${allowedRatios.join(', ')}.
- quality is low, medium, or high. Default medium; high only for explicit print-grade, fine detail, or preserving small text.
- Chinese or short generate requests should become specific English prompts.
- With history, treat it as refinement and evolve the previous direction.`
}

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

type EnhanceDegradedReason = 'upstream-http' | 'upstream-network' | 'timeout' | 'bad-json'

// P1-c Step 2 (mask-chat-card): edit intent sanitize. Non-conforming fields are
// silently dropped (no 400) per contract — frontend sends loose shapes and we
// only keep what the edit system prompt + user content need.
type EditContext = {
  sourceTitle?: string
  hasMask?: boolean
  maskKind?: 'brush' | 'bounds'
  maskBoundsPx?: { x: number; y: number; width: number; height: number }
  sourceSize?: { width: number; height: number }
}

const sanitizeEditContext = (raw: unknown): EditContext => {
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const out: EditContext = {}
  if (typeof obj.sourceTitle === 'string') out.sourceTitle = obj.sourceTitle
  if (typeof obj.hasMask === 'boolean') out.hasMask = obj.hasMask
  if (obj.maskKind === 'brush' || obj.maskKind === 'bounds') out.maskKind = obj.maskKind
  const mb = obj.maskBoundsPx
  if (typeof mb === 'object' && mb !== null) {
    const m = mb as Record<string, unknown>
    if (
      typeof m.x === 'number' &&
      typeof m.y === 'number' &&
      typeof m.width === 'number' &&
      typeof m.height === 'number'
    ) {
      out.maskBoundsPx = { x: m.x, y: m.y, width: m.width, height: m.height }
    }
  }
  const ss = obj.sourceSize
  if (typeof ss === 'object' && ss !== null) {
    const s = ss as Record<string, unknown>
    if (typeof s.width === 'number' && typeof s.height === 'number') {
      out.sourceSize = { width: s.width, height: s.height }
    }
  }
  return out
}

// Edit-intent user content. Coordinates are in source image pixel space — the
// string "normalized" must NEVER appear here (per mask-chat-card Step 2 contract).
// Omit maskBoundsPx / sourceSize lines when absent rather than fabricating values.
const buildEditUserContent = (
  prompt: string,
  ec: EditContext,
  historyEntries: Array<{ role: string; content: string }>,
): string => {
  const lines: string[] = []
  if (historyEntries.length > 0) {
    lines.push('Previous conversation:')
    lines.push(historyEntries.map((e) => `${e.role}: ${e.content}`).join('\n'))
    lines.push('')
  }
  lines.push(`Edit instruction: ${prompt}`)
  lines.push(`Source title: ${ec.sourceTitle || 'untitled'}`)
  lines.push(`Mask: ${ec.hasMask ? (ec.maskKind || 'bounds') : 'none'}`)
  if (ec.maskBoundsPx) {
    lines.push(
      `Mask bounds (px, in source image space): ${ec.maskBoundsPx.x},${ec.maskBoundsPx.y},${ec.maskBoundsPx.width},${ec.maskBoundsPx.height}`,
    )
  }
  if (ec.sourceSize) {
    lines.push(`Source size: ${ec.sourceSize.width}x${ec.sourceSize.height} px`)
  }
  return lines.join('\n')
}

const callEnhanceLlm = async (
  model: string,
  messages: Array<{ role: string; content: string }>,
  llmApiKey: string,
  timeoutMs: number,
  llmApiBase: string,
): Promise<{ result: EnhanceParsed | null; reason: EnhanceDegradedReason | '' }> => {
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
    // W4: non-2xx → upstream-http（与下方 throw 的 upstream-network 区分）。
    if (!response.ok) return { result: null, reason: 'upstream-http' }
    const payload = (await response.json()) as EnhanceLlmResponse
    const content = payload.choices?.[0]?.message?.content || ''
    const parsed = parseEnhanceJson(content)
    return { result: parsed, reason: parsed ? '' : 'bad-json' }
  } catch (error) {
    return {
      result: null,
      reason: error instanceof UpstreamRequestTimeoutError ? 'timeout' : 'upstream-network',
    }
  }
}

type EnhanceRequestBody = {
  prompt?: unknown
  modelId?: unknown
  history?: unknown
  hasSelectedImage?: unknown
  sceneId?: unknown
  intent?: unknown
  editContext?: unknown
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

    // Gateway key (sk-): X-Gateway-Key header → fallback env MIVO_LLM_API_KEY.
    // present-but-invalid → 400(不 fallback env,防脏 header 构造 Bearer 异常被误报网络失败)。
    const badGatewayKey = rejectInvalidGatewayKey(c)
    if (badGatewayKey) {
      log(400, 'bad-gateway-key')
      return badGatewayKey
    }
    const gatewayKey = resolveGatewayKey(c).trim()

    if (!gatewayKey) {
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

    const intent: 'generate' | 'edit' = body.intent === 'edit' ? 'edit' : 'generate'
    const editContext = intent === 'edit' ? sanitizeEditContext(body.editContext) : {}

    const systemPrompt = buildEnhanceSystemPrompt(allowedRatios, intent)
    const userContent =
      intent === 'edit'
        ? buildEditUserContent(prompt, editContext, historyEntries)
        : historyEntries.length > 0
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
      gatewayKey,
      env.enhancePrimaryTimeoutMs,
      env.llmApiBase,
    )
    // W4: stage 标哪一档 LLM 给出的降级，供前端标签 + 服务端测试矩阵断言。
    let stage: 'primary' | 'fallback' = 'primary'

    // Fallback: fast JSON-stable mini model (8s)
    if (!result) {
      const fallback = await callEnhanceLlm(
        mivoEnhanceFallbackModel,
        llmMessages,
        gatewayKey,
        env.enhanceFallbackTimeoutMs,
        env.llmApiBase,
      )
      result = fallback.result
      stage = 'fallback'
      if (!result) degradedReason = fallback.reason || degradedReason
    }

    if (!result) {
      const reason = degradedReason || 'upstream-network'
      log(200, `degraded:${reason}:${stage}`)
      return c.json({ enhanced: false, degradedReason: reason, stage }, 200)
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
