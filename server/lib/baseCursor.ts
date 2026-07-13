// server/lib/baseCursor.ts
// A2-S2 BaseCursor codec — opaque 签名 token(绑 scope canvasId+recordId + revision + per-field clock snapshot)。
// 权威:docs/decisions/n20-truth-source-decision.md §10.1 / §14.1(Blocker 1)+ §14.7 NOTES。
// 语义移植自 src/kernel/__spike__/n20-truth-source.spike.test.ts:357-454(BaseDrivenHarness 蓝本),
// 但生产化:HMAC-SHA256 替换 spike 的 FNV-1a;secret 来自 env(非硬编码);恒时验签防时序泄漏。
//
// 设计(§14.1 冻结矩阵):
// - token 绑 canvasId+recordId+revision+per-field clock snapshot;decodeBase 验签 + scope 校验。
// - 防 v5 两洞:① 跨 record/canvas 重放(n1 token 用于 n2;HMAC 只防改值不防换资源)→ token 绑 canvasId+recordId,decode 校验 scope;
//   ② 无 per-field clock,record-rev 落后判 overwritten 会误报别的字段变过 → token 携 per-field clock,同-field(fieldKeyOf 完整 path)stale 才 overwritten。
// - 生命周期:accepted `{id,revision,seq,base}` 响应签发 base + hydrate snapshot 签发;client 回传 If-Match;
//   server decodeBase 验签;malformed/unsigned/scope-mismatch → null(→ route 400/428);conflict 返 current base 供 re-fetch。
// - 业务层 opaque:BaseCursor 是 branded string,port 不读内部;codec 只在 adapter/server(§10.2)。
//
// 密钥来源与轮换立场(env,写注释):
// - secret 来自 process.env.MIVO_BASE_CURSOR_SECRET;生产必填,缺失 → codec fail-closed(throw,防弱签名被本地伪造)。
// - 轮换:env 支持逗号分隔多 secret(新 key 在前,旧 key 在后);encode 用第一个,decode 遍历尝试验签
//   (旧 secret 签发的 token 在轮换窗内仍可 decode,不 428 风暴)。轮换流程:加新 key 到前 → 部署 →
//   观察旧 token 全过期(quiet window)→ 删旧 key。不就地改值(就地改会让存量 token 全 invalid)。
// - dev/test:显式设 env,或调 setBaseCursorSecrets() 注入(仅测试用);无 env 时 throw(不静默 fallback 弱 secret)。
//
// 边界:本模块是 server 内部 codec,不进 shared 契约(BaseCursor brand 不出 shared;route 用 string 收发,server 内部 brand 化)。

import { createHmac, timingSafeEqual } from 'node:crypto'

/** fieldKey → clock(同-field stale 判定,§10.3;key = fieldKeyOf 完整 path)。 */
export type FieldClocks = Record<string, number>

/** BaseCursor = opaque string token(branded;绑 scope+revision+per-field clock;client 不可构造/伪造)。 */
export type BaseCursor = string & { readonly __brand: 'BaseCursor' }
/** SnapshotCursor = canvas 级 opaque bundle(§14.7;内含 recordId→BaseCursor map + order + since)。 */
export type SnapshotCursor = string & { readonly __brand: 'SnapshotCursor' }
/** bundle 内 per-record entry(签发时从 record revision + per-field clock snapshot 构造)。 */
export type BundleEntry = { revision: number; fieldClocks: FieldClocks }

// ── secret 管理(env + 轮换 + 测试注入)──
// 进程内 cache;env 变更需 restart 或调 setBaseCursorSecrets()(测试用)。生产 env 改动靠 deploy 重启。
let _secrets: string[] | null = null

const loadSecrets = (): string[] => {
  if (_secrets) return _secrets
  const raw = process.env.MIVO_BASE_CURSOR_SECRET
  if (!raw) {
    // fail-closed:无 secret → 不签不验(防本地用空 secret 伪造 token 误信)。
    throw new Error('MIVO_BASE_CURSOR_SECRET not configured (BaseCursor codec fail-closed; set env or call setBaseCursorSecrets for tests)')
  }
  _secrets = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!_secrets.length) throw new Error('MIVO_BASE_CURSOR_SECRET configured but empty')
  return _secrets
}

/** 测试注入 secrets(绕过 env;生产禁用,仅 baseCursor.test.ts 用)。null → 回退 env(清缓存)。 */
export const setBaseCursorSecrets = (secrets: string[] | null): void => { _secrets = secrets }

/** 用最新 secret(列表首个)签名 payload → hex(HMAC-SHA256,64 hex chars = 32 bytes)。 */
const sign = (payload: string): string => createHmac('sha256', loadSecrets()[0]).update(payload).digest('hex')

/** 恒时验签:遍历所有 secret(轮换窗内旧 key 仍可验);hex 解码失败/长度错 → false。 */
const verify = (payload: string, expectedSigHex: string): boolean => {
  const secrets = loadSecrets()
  let expected: Buffer
  try { expected = Buffer.from(expectedSigHex, 'hex') } catch { return false }
  if (expected.length !== 32) return false // sha256 digest 恒 32 bytes
  for (const s of secrets) {
    const actual = createHmac('sha256', s).update(payload).digest()
    // timingSafeEqual 要求等长 Buffer;expected/actual 均 32 bytes,恒时比较防时序泄漏。
    if (timingSafeEqual(expected, actual)) return true
  }
  return false
}

const PREFIX = 'base:'

// ── record base ──
/** encode record base:绑 canvasId+recordId+revision+per-field clock snapshot;签。 */
export const encodeBase = (canvasId: string, recordId: string, revision: number, fieldClocks: FieldClocks): BaseCursor => {
  const fc = Object.entries(fieldClocks).map(([k, v]) => `${k}:${v}`).join(',')
  const payload = `cv=${canvasId}|rid=${recordId}|r=${revision}|fc=${fc}`
  return `${PREFIX}${payload}.${sign(payload)}` as BaseCursor
}

/** parse payload segments(payload 格式 `cv=X|rid=Y|r=Z|fc=k:v,k:v`)。 */
const parseSegments = (payload: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const seg of payload.split('|')) {
    const i = seg.indexOf('=')
    if (i > 0) out[seg.slice(0, i)] = seg.slice(i + 1)
  }
  return out
}

export type DecodedBase = { revision: number; fieldClocks: FieldClocks }

/**
 * decode record base:验签 + scope(canvasId+recordId 必须匹配 expected)→ {revision, fieldClocks} | null。
 * - null 语义:malformed(非 base: 前缀/无 dot)→ 400;unsigned/篡改(验签失败)→ 400;scope mismatch(跨 record/canvas 重放)→ 400。
 * - missing(token undefined)在 route 层映射 428(precondition-required);本函数对 undefined 也返 null,route 据 If-Match 缺失区分。
 */
export const decodeBase = (token: BaseCursor | string | undefined, expectedCanvasId: string, expectedRecordId: string): DecodedBase | null => {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null
  const body = token.slice(PREFIX.length)
  const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot)
  if (!verify(payload, body.slice(dot + 1))) return null
  const seg = parseSegments(payload)
  if (seg.cv !== expectedCanvasId || seg.rid !== expectedRecordId) return null // scope mismatch → null(防跨 record/canvas 重放)
  const fc: FieldClocks = {}
  if (seg.fc) {
    for (const pair of seg.fc.split(',')) {
      const [k, v] = pair.split(':')
      if (k) fc[k] = Number(v)
    }
  }
  const rev = Number(seg.r)
  if (!Number.isFinite(rev)) return null
  return { revision: rev, fieldClocks: fc }
}

// ── order base(canvas-scoped,reorder 用)──
/** encode order base(canvas-scoped,无 recordId;reorder 用 canvas contentVersion)。 */
export const encodeOrderBase = (canvasId: string, cv: number): BaseCursor => {
  const payload = `cv=${canvasId}|order=${cv}`
  return `${PREFIX}${payload}.${sign(payload)}` as BaseCursor
}

export type DecodedOrderBase = { cv: number }

/** decode order base:验签 + canvas scope → {cv} | null。 */
export const decodeOrderBase = (token: BaseCursor | string | undefined, expectedCanvasId: string): DecodedOrderBase | null => {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null
  const body = token.slice(PREFIX.length)
  const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot)
  if (!verify(payload, body.slice(dot + 1))) return null
  const seg = parseSegments(payload)
  if (seg.cv !== expectedCanvasId || seg.order === undefined) return null
  return { cv: Number(seg.order) }
}

// ── event-since base(canvas-scoped seq;bundle 内 since 项)──
/** encode event-since base(canvas-scoped seq;GET /events/poll?since= 增量补拉用;bundle 内 since 项)。 */
export const encodeSinceBase = (canvasId: string, seq: number): BaseCursor => {
  const payload = `cv=${canvasId}|since=${seq}`
  return `${PREFIX}${payload}.${sign(payload)}` as BaseCursor
}

export type DecodedSinceBase = { seq: number }

/** decode event-since base:验签 + canvas scope → {seq} | null。 */
export const decodeSinceBase = (token: BaseCursor | string | undefined, expectedCanvasId: string): DecodedSinceBase | null => {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null
  const body = token.slice(PREFIX.length)
  const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot)
  if (!verify(payload, body.slice(dot + 1))) return null
  const seg = parseSegments(payload)
  if (seg.cv !== expectedCanvasId || seg.since === undefined) return null
  return { seq: Number(seg.since) }
}

// ── v8 Blocker 1:SnapshotCursor(canvas 级 opaque bundle)= recordId→BaseCursor map + canvas order base + event since base ──
//   多 record hydrate 后单 record 级 token 无法为任意 n1/n2 提供 If-Match → bundle 聚合;
//   submitChange 按 recordId/op class 抽对应 wire base(edit/delete→record base;reorder→order base;catch-up→since base);
//   accepted/conflict 用 wire response 的 base/seq 增量更新 bundle(仅命中 record,未命中项值不变;§14.7 v9)。
export type DecodedBundle = {
  records: Record<string, BaseCursor>
  order: BaseCursor
  since: BaseCursor
  entries: Record<string, BundleEntry>
  orderCv: number
  sinceSeq: number
}

/** encode canvas bundle:opaque canvas 级 token(内含 recordId→(rev,fc) map + order cv + since seq;签)。 */
export const encodeBundle = (canvasId: string, entries: Record<string, BundleEntry>, orderCv: number, sinceSeq: number): SnapshotCursor => {
  const payload = JSON.stringify({ cv: canvasId, recs: entries, order: orderCv, since: sinceSeq })
  return `bundle:${payload}.${sign(payload)}` as SnapshotCursor
}

/**
 * decode canvas bundle:验签 + canvas scope → {records(recordId→wire BaseCursor 重建), order, since, entries} | null。
 * ★ 解包即按 recordId 重建 wire BaseCursor(submitChange 抽对应 record base;reorder 抽 order base;不串用)。
 */
export const decodeBundle = (token: SnapshotCursor | string | undefined, expectedCanvasId: string): DecodedBundle | null => {
  if (typeof token !== 'string' || !token.startsWith('bundle:')) return null
  const body = token.slice('bundle:'.length)
  const dot = body.lastIndexOf('.')
  if (dot < 0) return null
  const payload = body.slice(0, dot)
  if (!verify(payload, body.slice(dot + 1))) return null
  let obj: { cv?: string; recs?: Record<string, BundleEntry>; order?: number; since?: number }
  try { obj = JSON.parse(payload) } catch { return null }
  if (obj.cv !== expectedCanvasId) return null // canvas scope mismatch(跨 canvas bundle 重放)→ null
  const records: Record<string, BaseCursor> = {}
  const entries: Record<string, BundleEntry> = {}
  for (const [id, e] of Object.entries(obj.recs ?? {})) {
    entries[id] = e
    records[id] = encodeBase(expectedCanvasId, id, e.revision, e.fieldClocks) // ★ 按 recordId 重建 wire BaseCursor(不串用)
  }
  const orderCv = obj.order ?? 0
  const sinceSeq = obj.since ?? 0
  return { records, order: encodeOrderBase(expectedCanvasId, orderCv), since: encodeSinceBase(expectedCanvasId, sinceSeq), entries, orderCv, sinceSeq }
}
