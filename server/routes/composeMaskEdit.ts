// server/routes/composeMaskEdit.ts
// POST /api/mivo/compose-mask-edit (JSON) → 200 {requirements: string[], degradedReason?}
// 局部重绘「结构化整理」：把用户一句话大意，按图2上已编号的红圈（附标签+方位）
// 拆成逐条编辑要求（1 条 / 圈），供前端 buildDualImagePrompt 套上图1/图2 外壳。
// 这是受约束的重排（只按圈拆分意图 + 补保护句，禁止新增/改写语义），不是通用润色。
//
// 同 /describe-region 的通道：llm-proxy chat/completions，primary gpt-5.4-mini。
// 失败/条数不符 → 200 {requirements: [], degradedReason} —— 前端静默回退到直接套壳，
// 整理永远不阻塞出图。
import type { Handler } from 'hono'
import type { HttpBindings } from '@hono/node-server'
import { getEnvConfig, mivoDescribeFallbackModel, mivoDescribePrimaryModel } from '../lib/config'
import { fetchUpstreamWithTimeout } from '../lib/upstream'
import { logRequest, newRequestId, readJsonBody } from '../lib/request'
import { rejectInvalidGatewayKey, resolveGatewayKey } from '../lib/keys'

type ComposeAnchor = { n: number; label: string; position?: string }

const composeSystemPrompt = [
  '你是局部重绘指令整理器。用户在图2上圈了 N 个已编号红圈（附标签和方位），并用一句话表达修改意图。',
  '把用户意图拆成逐条编辑要求，每个红圈一条，严格按规则：',
  '- 以「N.」开头，N=红圈编号，顺序与给定红圈完全一致，共输出 N 条，不多不少。',
  '- 消除类动作（去除/去掉/消除/删除/移除/清除等）：务必只{动作}图2中{N}号红圈（{方位}）范围内的{标签}。画面中其他{标签}一律保留，不要误删其他{标签}。',
  '- 修改类动作（改色/替换/调整等）：将图2中{N}号红圈（{方位}）范围内的{标签}{动作}。红圈范围内除{标签}以外的内容保持不变，其他相似内容不要误改。',
  '- 只整理用户已表达的意图，严禁新增、删减或改变语义；用户没提到的红圈，按其标签默认「保持不变」。',
  '- 方位若为空则省略括号部分。',
  '只返回一个 JSON 对象，不要任何其他文字、解释、开场白，也不要输出图1/图2 的框架句：',
  '{"requirements":["1.务必只去除图2中1号红圈（最左侧）范围内的蓝色烟雾。画面中其他蓝色烟雾一律保留，不要误删其他蓝色烟雾。","2.将图2中2号红圈范围内的左眼改成红色。红圈范围内除左眼以外的内容保持不变，其他相似内容不要误改。"]}',
].join('\n')

const buildUserMessage = (instruction: string, anchors: ComposeAnchor[]): string => {
  const list = anchors
    .map((anchor) => `圈${anchor.n}=${anchor.label || `目标${anchor.n}`}${anchor.position ? `（${anchor.position}）` : ''}`)
    .join('；')
  return `红圈：${list}。\n用户意图：${instruction}\n请按要求返回 JSON，requirements 数组恰好 ${anchors.length} 条。`
}

const parseRequirements = (content: string, expectedCount: number): string[] | null => {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as { requirements?: unknown }
    if (!Array.isArray(parsed.requirements)) return null
    const items = parsed.requirements
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .map((item) => item.slice(0, 300))
    // 校验：条数必须与红圈数一致，否则判定映射不可靠 → 交给前端回退。
    if (items.length !== expectedCount) return null
    return items
  } catch {
    return null
  }
}

const callComposeLlm = async (
  model: string,
  instruction: string,
  anchors: ComposeAnchor[],
  llmApiKey: string,
  timeoutMs: number,
  llmApiBase: string,
): Promise<string[] | null> => {
  try {
    const response = await fetchUpstreamWithTimeout(
      `${llmApiBase}/chat/completions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${llmApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: composeSystemPrompt },
            { role: 'user', content: buildUserMessage(instruction, anchors) },
          ],
        }),
      },
      timeoutMs,
    )
    if (!response.ok) return null
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return parseRequirements(payload.choices?.[0]?.message?.content || '', anchors.length)
  } catch {
    return null
  }
}

const sanitizeAnchors = (raw: unknown): ComposeAnchor[] => {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item, index) => {
      const record = item as { n?: unknown; label?: unknown; position?: unknown }
      const n = typeof record.n === 'number' && Number.isFinite(record.n) ? Math.round(record.n) : index + 1
      const label = typeof record.label === 'string' ? record.label.replace(/[\r\n]/g, ' ').trim().slice(0, 40) : ''
      const position = typeof record.position === 'string' ? record.position.trim().slice(0, 12) : undefined
      return { n, label, position }
    })
    .slice(0, 12)
}

export const composeMaskEditHandler: Handler<{ Bindings: HttpBindings }> = async (c) => {
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
    const body = await readJsonBody<{ instruction?: unknown; anchors?: unknown }>(c)
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 1000) : ''
    const anchors = sanitizeAnchors(body.anchors)
    if (!instruction || !anchors.length) {
      log(200, 'noop')
      return c.json({ requirements: [], degradedReason: 'noop' }, 200)
    }
    if (!gatewayKey) {
      log(200, 'no-key')
      return c.json({ requirements: [], degradedReason: 'no-key' }, 200)
    }

    let requirements = await callComposeLlm(
      mivoDescribePrimaryModel,
      instruction,
      anchors,
      gatewayKey,
      env.enhancePrimaryTimeoutMs,
      env.llmApiBase,
    )
    if (!requirements) {
      requirements = await callComposeLlm(
        mivoDescribeFallbackModel,
        instruction,
        anchors,
        gatewayKey,
        env.enhanceFallbackTimeoutMs,
        env.llmApiBase,
      )
    }
    if (!requirements) {
      log(200, 'degraded')
      return c.json({ requirements: [], degradedReason: 'upstream' }, 200)
    }
    log(200, 'ok')
    return c.json({ requirements }, 200)
  } catch (error) {
    log(500, 'error')
    return c.json({ error: error instanceof Error ? error.message : 'Unable to compose mask edit' }, 500)
  }
}
