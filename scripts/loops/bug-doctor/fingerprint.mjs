// fingerprint.mjs — bug-doctor 错误指纹规整(纯函数,零依赖,零 IO)
//
// 指纹 = source + '::' + normalize(message)。normalize 剥离记录级变量
// (UUID / 长 hex / 数字串 / 引号路径 / URL query),保留错误语义词,使同根因
// 记录聚成同簇。算法带版本号 FINGERPRINT_VERSION:升版时台账按新旧指纹
// 双写一轮过渡(见 docs/plan/bug-doctor-execution-plan.md 后悔成本排序 #2)。

export const FINGERPRINT_VERSION = 1

// 归一化占位符:统一尖括号形态,避免与原文冲突(服务端 sanitize 已剥 <>)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
// 长 hex(≥8):commit sha / 内部 id。UUID 先行处理,这里不会命中其分段。
const HEX_RE = /\b[0-9a-f]{8,}\b/gi
// URL query:保留路径(路径含语义,如 /api/canvas/xxx),剥 ?a=b&c=d 变量部分
const URL_QUERY_RE = /(\bhttps?:\/\/[^\s"'?]+|\B\/[^\s"'?]*)\?[^\s"']*/g
// 引号包裹的路径("/a/b/c" 或 '/a/b/c'):整体归一(引号路径基本是文件/资源变量)
const QUOTED_PATH_RE = /(["'])\/[^"']*\1/g
// data:/blob: 内联资源
const INLINE_RES_RE = /\b(data|blob):[^\s"']+/gi
// 数字串(最后跑,前面的规则已保护 UUID/hex 不被拆碎)
const NUM_RE = /\d+/g

const MAX_PATTERN_LENGTH = 200

/**
 * 规整 message:剥离记录级变量,保留错误语义词。纯函数。
 * @param {string} message
 * @returns {string}
 */
export const normalizeMessage = (message) => {
  const normalized = String(message ?? '')
    .replace(UUID_RE, '<uuid>')
    .replace(HEX_RE, '<hex>')
    .replace(INLINE_RES_RE, '<res>')
    .replace(URL_QUERY_RE, '$1')
    .replace(QUOTED_PATH_RE, '<path>')
    .replace(NUM_RE, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
  // 取前缀:超长消息(如内嵌 JSON dump)尾部多为变量噪声,前缀已足够区分根因
  return normalized.length > MAX_PATTERN_LENGTH
    ? normalized.slice(0, MAX_PATTERN_LENGTH)
    : normalized
}

/**
 * 指纹 = source + '::' + normalize(message)。纯函数。
 * @param {{source?: string, message?: string}} record
 * @returns {string}
 */
export const fingerprintOf = (record) => {
  const source = String(record?.source ?? 'Unknown').trim() || 'Unknown'
  return `${source}::${normalizeMessage(record?.message)}`
}
