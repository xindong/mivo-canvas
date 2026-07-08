// server/routes/describeRegion.ts
// POST /api/mivo/describe-region (multipart: `crop` image) → 200 {label, description}
// Anchor semantics (Lovart-style): the frontend crops the user's mask selection
// (plus some context margin) and this endpoint asks a vision LLM what the crop
// shows. The label feeds the overlay UI chip and the instruction-based (gemini)
// mask-edit prompt clause ("only modify the {label} ...").
//
// Same channel as /enhance: llm-proxy chat/completions, primary claude-haiku-4-5
// (vision-capable) with the gpt mini fallback. Failure degrades to 200
// {label: ''} — recognition is a hint, never a blocker.
import { Buffer } from 'node:buffer'
import type { Handler } from 'hono'
import type { HttpBindings } from '@hono/node-server'
import {
  getEnvConfig,
  mivoDescribeFallbackModel,
  mivoDescribePrimaryModel,
} from '../lib/config'
import { fetchUpstreamWithTimeout, RequestBodyTooLargeError } from '../lib/upstream'
import { logRequest, multipartFiles, newRequestId, parseMultipartBody } from '../lib/request'
import { rejectInvalidGatewayKey, resolveGatewayKey } from '../lib/keys'

// Lovart-style anchor picker: instead of betting one label (which we got wrong —
// hair→cape), return a nested candidate list from coarse to fine so the user can
// confirm/switch in one click. Ordered whole-subject → specific-part; the LAST
// (most specific, under the anchor/red-ring) is the default selection.
const describeSystemPrompt = [
  '你是图像区域识别助手。用户会给你 1-2 张图：可能是「完整原图（红圈标锚点位置）+ 锚点区域放大特写」两张，也可能只有特写一张。',
  '给两张图时：整体主体和所属物件（如 角色/外套）从完整原图判断，细节名称从特写确认——不要只凭特写下结论。',
  '⚠️ 截图上那个红色空心圆环是【系统叠加上去的定位标记】，不是画面内容本身。你必须把它当作透明、不存在的东西：',
  '- 绝对禁止把红圈/圆环/圆圈/圆点/标记/以及「红色」这个属性当成识别结果；任何候选的 label 里都不允许出现「红圈/圆环/圆圈/圆点/红色/标记/marker/定位」之类的字眼。',
  '- 你要识别的是红圈【圈住/正中心那块画面本身】是什么物体或部位，就当红圈是一块透明玻璃，透过它看下面的内容。',
  '返回一个由粗到细的候选列表：从整体主体（如 动漫女孩/机甲/建筑）到红圈中心指向的具体部位（如 白色头发/左眼/衣领），共 2-4 个，顺序必须「整体在前、红圈中心指向的最具体部位在最后」。',
  '例：红圈压在头发上，最后一项就是「头发」，即使旁边有脸；红圈套在眼睛上，最后一项就是「眼睛」。若红圈圈住的整体就是一个完整物件（如一朵云、一个图标），不要硬拆出子部位，直接给这个物件即可。',
  '消歧（重要）：如果画面中存在多个相似物件（如两把刀/两个刀柄/多朵云），红圈指向那个的 label 必须带上可区分的方位或特征前缀（如「左侧刀柄」「背后那把刀的刀柄」「右上方的云」），绝不能只给「刀柄」这种分不清是哪一个的名字。方位以完整原图为准。',
  'scope 字段：整体主体填 "whole"，具体部位/物件填 "part"。label 为不超过10个字的中文名。',
  '只返回一个 JSON 对象，不要任何其他文字：',
  '{"candidates":[{"label":"动漫女孩","scope":"whole"},{"label":"白色头发","scope":"part"}],"description":"一句话描述(不超过40字，同样不要提红圈)"}',
  '如果完全无法辨认，candidates 返回空数组。',
].join('\n')

type DescribeScope = 'whole' | 'part'
type DescribeCandidate = { label: string; scope: DescribeScope }
type DescribeParsed = { candidates: DescribeCandidate[]; description: string }

const toScope = (value: unknown): DescribeScope => (value === 'whole' ? 'whole' : 'part')

const parseDescribeJson = (content: string): DescribeParsed | null => {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as {
      candidates?: unknown
      // 兼容旧的单 label 返回：老模型/降级路径可能仍吐 {label,description}。
      label?: unknown
      description?: unknown
    }
    const rawList = Array.isArray(parsed.candidates)
      ? parsed.candidates
      : typeof parsed.label === 'string'
        ? [{ label: parsed.label, scope: 'part' }]
        : []
    const candidates: DescribeCandidate[] = rawList
      .map((item) => {
        const record = item as { label?: unknown; scope?: unknown }
        const label = typeof record.label === 'string' ? record.label.trim().slice(0, 24) : ''
        return { label, scope: toScope(record.scope) }
      })
      .filter((candidate) => Boolean(candidate.label))
      .slice(0, 4)
    return {
      candidates,
      description: typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 120) : '',
    }
  } catch {
    return null
  }
}

type VisionContent = Array<
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
>

const callDescribeLlm = async (
  model: string,
  dataUrl: string,
  llmApiKey: string,
  timeoutMs: number,
  llmApiBase: string,
  contextDataUrl?: string,
): Promise<DescribeParsed | null> => {
  try {
    // 双图模式（有全图 context 时）：图1 = 完整原图缩略、红圈标出锚点位置——用来
    // 判断锚点属于什么大物件（角色/衣服/…）；图2 = 锚点放大特写——用来认细节。
    // 单裁片视野太窄会把「外套上的花纹」直接认成「图案」，候选里丢掉「衣服」层级。
    const userContent: VisionContent = contextDataUrl
      ? [
          {
            type: 'text',
            text: '图1是完整原图（红圈标出锚点位置），图2是锚点区域的放大特写。先从图1判断红圈处属于什么整体/物件，再结合图2给出由粗到细的候选。按要求返回 JSON。',
          },
          { type: 'image_url', image_url: { url: contextDataUrl } },
          { type: 'image_url', image_url: { url: dataUrl } },
        ]
      : [
          { type: 'text', text: '这个区域里是什么？按要求返回 JSON。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ]
    const response = await fetchUpstreamWithTimeout(
      `${llmApiBase}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${llmApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: describeSystemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
      },
      timeoutMs,
    )
    if (!response.ok) return null
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return parseDescribeJson(payload.choices?.[0]?.message?.content || '')
  } catch {
    return null
  }
}

export const describeRegionHandler: Handler<{ Bindings: HttpBindings }> = async (c) => {
  const requestId = newRequestId()
  c.header('X-Request-Id', requestId)
  const t0 = Date.now()
  const log = (status: number, note?: string): void => {
    logRequest({ method: c.req.method, path: c.req.path, requestId, status, latencyMs: Date.now() - t0, note })
  }
  const env = getEnvConfig()
  try {
    if (c.req.method !== 'POST') {
      log(405)
      return c.json({ error: 'Method not allowed' }, 405)
    }
    // Gateway key (sk-): X-Gateway-Key → fallback env MIVO_LLM_API_KEY;present-but-invalid → 400。
    const badGatewayKey = rejectInvalidGatewayKey(c)
    if (badGatewayKey) {
      log(400, 'bad-gateway-key')
      return badGatewayKey
    }
    const gatewayKey = resolveGatewayKey(c).trim()
    if (!gatewayKey) {
      log(200, 'no-key')
      return c.json({ candidates: [], label: '', description: '', degradedReason: 'no-key' }, 200)
    }

    const { files } = await parseMultipartBody(c)
    const crop = multipartFiles(files, 'crop')[0]
    if (!crop) {
      log(400)
      return c.json({ error: 'crop image is required' }, 400)
    }
    const mime = crop.type && crop.type.startsWith('image/') ? crop.type : 'image/png'
    const cropBuffer = Buffer.from(await crop.arrayBuffer())
    const dataUrl = `data:${mime};base64,${cropBuffer.toString('base64')}`
    // 可选的全图 context（前端只在点选锚点时附带）。
    const contextFile = multipartFiles(files, 'context')[0]
    let contextDataUrl: string | undefined
    if (contextFile) {
      const contextMime = contextFile.type && contextFile.type.startsWith('image/') ? contextFile.type : 'image/jpeg'
      contextDataUrl = `data:${contextMime};base64,${Buffer.from(await contextFile.arrayBuffer()).toString('base64')}`
    }

    let result = await callDescribeLlm(
      mivoDescribePrimaryModel,
      dataUrl,
      gatewayKey,
      env.enhancePrimaryTimeoutMs,
      env.llmApiBase,
      contextDataUrl,
    )
    if (!result) {
      result = await callDescribeLlm(
        mivoDescribeFallbackModel,
        dataUrl,
        gatewayKey,
        env.enhanceFallbackTimeoutMs,
        env.llmApiBase,
        contextDataUrl,
      )
    }

    if (!result) {
      log(200, 'degraded')
      return c.json({ candidates: [], label: '', description: '', degradedReason: 'upstream' }, 200)
    }
    // label = 默认选中项（最具体的部位，即列表最后一项）——兼容旧的单 label 调用方。
    const defaultLabel = result.candidates.at(-1)?.label ?? ''
    log(200, result.candidates.length ? 'ok' : 'empty')
    return c.json({ candidates: result.candidates, label: defaultLabel, description: result.description }, 200)
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 500
    log(status, 'error')
    return c.json({ error: error instanceof Error ? error.message : 'Unable to describe region' }, status)
  }
}
