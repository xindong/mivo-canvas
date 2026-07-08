// src/lib/maskEditCompose.ts
// 前端客户端：把用户一句话大意 + 已编号红圈（标签+方位）发给 BFF 结构化整理端点，
// 拿到逐条「编辑要求」。失败/降级返回 null，调用方静默回退到直接套壳（不阻塞出图）。
import { authHeaders } from './authHeaders'

export type ComposeAnchor = { n: number; label: string; position?: string }

/**
 * 调 /api/mivo/compose-mask-edit。成功返回逐条要求拼成的正文（换行连接）；
 * 无 anchors、空意图、上游降级、条数不符、网络错误一律返回 null。
 */
export const composeMaskEditBody = async (
  instruction: string,
  anchors: ComposeAnchor[],
  signal?: AbortSignal,
): Promise<string | null> => {
  if (!instruction.trim() || !anchors.length) return null
  try {
    const response = await fetch('/api/mivo/compose-mask-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ instruction, anchors }),
      signal,
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { requirements?: unknown }
    if (!Array.isArray(payload.requirements) || !payload.requirements.length) return null
    const lines = payload.requirements.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return lines.length ? lines.join('\n') : null
  } catch {
    return null
  }
}
