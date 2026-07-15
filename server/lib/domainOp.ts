// server/lib/domainOp.ts
// A2-S2 DomainOp — field-level LWW delta(transport-neutral,§10.1)。
// 权威:docs/decisions/n20-truth-source-decision.md §10.1 / §14.1 / §14.7 NOTES。
// 语义移植自 src/kernel/__spike__/n20-truth-source.spike.test.ts:48-92(setByPath/fieldKeyOf/assertSafePath)+
// :461-495(DomainOp union / CreateBody / trustify),但生产化:类型 export 给 route/backend;validator 拒
// 原型污染/空路径/容器 clobber;runtime 校验 unknown wire shape。
//
// 设计(§10.1):
// - DomainOp = 中性 delta(无 recordId/actor/base/opId;全 adapter/path/header 注入,§10 trustify 三层信任边界)。
// - 无 create(走独立 POST /:id/nodes/:nodeId,CreateBody,§10.2)/ 无 strict-tx(改 server-named ServerInvariantCommand)/
//   无 by-id(A2 deferred,fail-visible,禁降级整数组 LWW;fills/strokes/effects 的 by-id 结构编辑 A2 不支持,
//   migration 走 legacy 兼容通道,见 §14.3/C-2)。
// - whole-lww(markupPoints,无 stable-id)+ primitive(resultNodeIds)A2 supported。
// - container 白名单取消(lead 裁定 rejected):A2 维持叶子级 set(整对象 set 拒,须分解 transform.x 叶子 set)。
//
// 边界:类型可被 shared/route/backend 引用;validator 是 runtime 入口(route 把 PATCH body unknown → DomainOp[])。
// 不 import spike;不碰 client(阶段 3)。

// A2-S2 wire 契约类型(FieldPath/DomainOp/ServerInvariantCommand/RecordKind/CreateBody)定义在
// shared/persist-contract.ts(server/client 共享 seam);本文件 re-export + 提供 runtime validator(fieldKeyOf/setByPath/validateDomainOp)。
import type { CreateBody, DomainOp, FieldPath, LegacyReplaceRequest, RecordKind, ServerInvariantCommand } from '../../shared/persist-contract.ts'
export type { CreateBody, DomainOp, FieldPath, LegacyReplaceRequest, RecordKind, ServerInvariantCommand }

// ── fieldKeyOf + setByPath/getByPath(硬化:拒原型污染 + 拒空路径 + 拒容器 clobber)──
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export type DomainOpViolation =
  | 'empty-field-path'
  | 'forbidden-path-segment'
  | 'non-atomic-container-set'
  | 'bad-array-class'
  | 'bad-array-intent'
  | 'bad-array-value'
  | 'bad-reorder-ids'
  | 'unknown-op-shape'
  | 'bad-field-path-segment'
  | 'bad-kind'
  | 'bad-legacy-envelope'

// erasableSyntaxOnly(tsconfig):禁止 parameter property(public readonly 构造参数),显式赋值。
export class DomainOpError extends Error {
  readonly violation: DomainOpViolation
  readonly field?: string
  constructor(violation: DomainOpViolation, field?: string) {
    super(`domain-op violation: ${violation}${field ? ` (${field})` : ''}`)
    this.name = 'DomainOpError'
    this.violation = violation
    this.field = field
  }
}

const assertSafePath = (path: (string | number)[]): void => {
  if (path.length === 0) throw new DomainOpError('empty-field-path')
  for (const seg of path) {
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) {
      throw new DomainOpError('forbidden-path-segment', String(seg))
    }
  }
}

/** fieldPath → 稳定 key 串(per-field clock / overwritten 判定用;§14.1 fieldKeyOf 完整 path 粒度)。 */
export const fieldKeyOf = (path: readonly (string | number)[]): string => path.map((s) => String(s)).join('.')

/** 容器判定(plain object 或 array;R2-4 leaf validator:容器对容器 set = clobber 风险)。 */
const isContainer = (v: unknown): boolean => v !== null && typeof v === 'object'

/**
 * R2-4 leaf validator:拒"容器 path + 容器 value"的 clobber(如 setByPath(obj,['transform'],{x:10}) 会吞 transform.y)。
 * - 要求 fieldPath 导航到**原子 leaf**(number/string/boolean),或对容器整值替换显式声明 allowContainerClobber(整值 LWW 限制,whole-lww array 用)。
 * - 对照 mivoCanvas.ts:transform 是容器对象 → set ['transform'] 整对象会吞兄弟字段;必须 set ['transform','x'] 等叶子。
 */
const assertAtomicLeaf = (obj: Record<string, unknown>, path: (string | number)[], value: unknown): void => {
  if (path.length === 0) return // assertSafePath 已拒空路径
  let parent: unknown = obj
  for (let i = 0; i < path.length - 1; i++) parent = (parent as Record<string, unknown>)?.[path[i] as string]
  const cur = (parent as Record<string, unknown> | undefined)?.[path[path.length - 1] as string]
  if (isContainer(cur) && isContainer(value)) {
    throw new DomainOpError('non-atomic-container-set', fieldKeyOf(path))
  }
}

/** 通用嵌套字段 set(path 导航到 leaf,mutates obj)。硬化:拒原型污染路径 + 拒整对象 clobber(除非 allowContainerClobber)。 */
export const setByPath = (obj: Record<string, unknown>, path: (string | number)[], value: unknown, opts: { allowContainerClobber?: boolean } = {}): void => {
  assertSafePath(path)
  if (!opts.allowContainerClobber) assertAtomicLeaf(obj, path, value)
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    // F1-bis ①(T2.2 Block 2 review):缺失的 plain-object 祖先自动物化,使 set ['asset','url'] 在 asset 缺失时
    //   建 {asset:{url:...}}(ai-slot→image 的 asset 物化;审官真实 backend 往返证原实现直接 TypeError)。
    //   仅物化 string 段的 plain-object 祖先;数组下标(number 段)缺失不物化(遇数组祖先仍 throw,不静默
    //   创对象数组,lead 裁定:数组祖先不物化)。null 祖先不物化(导航 null 报错,合理)。
    if (cur[seg as string] === undefined && typeof seg !== 'number') {
      cur[seg as string] = {}
    }
    cur = cur[seg as string] as Record<string, unknown>
  }
  cur[path[path.length - 1] as string] = value
}

/** 嵌套字段 unset(删叶子键,mutates obj)。硬化:同拒原型污染路径;拒删 container 整子树(由 validateDomainOp 在 kind 层拦)。 */
export const unsetByPath = (obj: Record<string, unknown>, path: (string | number)[]): void => {
  assertSafePath(path)
  // 记录祖先链(parent + key),供删叶子后向上剪枝空 plain-object 祖先。
  const chain: Array<{ parent: Record<string, unknown>; key: string | number }> = []
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    chain.push({ parent: cur, key: path[i] })
    cur = cur[path[i] as string] as Record<string, unknown>
  }
  delete cur[path[path.length - 1] as string]
  // F1-bis ②(T2.2 Block 2 review):叶子删后沿路径向上清除变空的 plain-object 祖先(通用空对象剪枝,不依赖
  //   schema;剪到 record 顶层字段为止——chain[0].parent===obj,顶层空对象字段也剪)。防 asset:{} 空壳残留被
  //   hydrate 误判 ready。数组祖先不剪(即便空也不删数组容器;但数组字段被删后其 plain-object 父容器变空仍剪,
  //   见 ③ 裁定)。遇非空/数组祖先即停(上层不会再因子树变空)。
  for (let i = chain.length - 1; i >= 0; i--) {
    const { parent, key } = chain[i]!
    const node = parent[key as string] as unknown
    if (
      node !== null &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      Object.keys(node as Record<string, unknown>).length === 0
    ) {
      delete parent[key as string]
    } else {
      break
    }
  }
}

/** 嵌套字段 get(读当前服务端值用;条件逆运算 / overwritten historicalValue)。硬化:同拒原型污染路径。 */
export const getByPath = (obj: Record<string, unknown>, path: (string | number)[]): unknown => {
  assertSafePath(path)
  let cur: unknown = obj
  for (const seg of path) cur = (cur as Record<string, unknown>)[seg as string]
  return cur
}

// ── runtime validator(route 把 PATCH body unknown → DomainOp[] 用)──
const isStringOrNumber = (v: unknown): v is string | number => typeof v === 'string' || typeof v === 'number'

const parseFieldPath = (v: unknown, field: string): FieldPath => {
  if (!Array.isArray(v) || v.length === 0) throw new DomainOpError('empty-field-path', field)
  for (const seg of v) {
    if (!isStringOrNumber(seg)) throw new DomainOpError('bad-field-path-segment', field)
    if (typeof seg === 'string' && FORBIDDEN_SEGMENTS.has(seg)) throw new DomainOpError('forbidden-path-segment', String(seg))
  }
  return v as unknown as FieldPath
}

/**
 * validateDomainOp:runtime 校验 wire op shape(unknown → DomainOp)。
 * - 拒未知 kind / 拒空路径 / 拒原型污染段 / 拒 set 容器 clobber(非 atomic leaf)/ 校 array class+intent+value / 校 reorder ids。
 * - 不依赖 schema(classifier 是 G1-b R4 安全入口,本 A2 server 侧 leaf-level set 不需 schema-aware;container clobber 由 assertAtomicLeaf 拦)。
 * - 不校验 base/actor/recordId(全 adapter 注入,body 零 privileged)。
 */
export const validateDomainOp = (op: unknown): DomainOp => {
  if (op == null || typeof op !== 'object' || Array.isArray(op)) throw new DomainOpError('unknown-op-shape')
  const o = op as Record<string, unknown>
  const kind = o.kind
  switch (kind) {
    case 'set': {
      const fieldPath = parseFieldPath(o.fieldPath, 'set.fieldPath')
      // assertAtomicLeaf 在 backend setByPath 时跑(需当前 record 状态);此处只校 shape。
      return { kind: 'set', fieldPath, value: o.value }
    }
    case 'unset': {
      const fieldPath = parseFieldPath(o.fieldPath, 'unset.fieldPath')
      return { kind: 'unset', fieldPath }
    }
    case 'array': {
      const fieldPath = parseFieldPath(o.fieldPath, 'array.fieldPath')
      const cls = o.class
      if (cls !== 'whole-lww' && cls !== 'primitive') throw new DomainOpError('bad-array-class', String(cls))
      const intent = o.intent
      if (cls === 'whole-lww') {
        if (intent !== 'replace') throw new DomainOpError('bad-array-intent', String(intent))
        if (!Array.isArray(o.value)) throw new DomainOpError('bad-array-value', 'whole-lww value must be array')
        return { kind: 'array', fieldPath, class: 'whole-lww', intent: 'replace', value: o.value as unknown[] }
      }
      // primitive
      if (intent !== 'insert' && intent !== 'remove') throw new DomainOpError('bad-array-intent', String(intent))
      if (typeof o.value !== 'string') throw new DomainOpError('bad-array-value', 'primitive value must be string')
      return { kind: 'array', fieldPath, class: 'primitive', intent, value: o.value }
    }
    case 'reorder': {
      if (!Array.isArray(o.orderedIds)) throw new DomainOpError('bad-reorder-ids', 'orderedIds must be array')
      for (const id of o.orderedIds) if (typeof id !== 'string') throw new DomainOpError('bad-reorder-ids', 'orderedIds must be string[]')
      return { kind: 'reorder', orderedIds: o.orderedIds as string[] }
    }
    default:
      throw new DomainOpError('bad-kind', String(kind))
  }
}

/**
 * validateDomainOps:PATCH body = DomainOp | DomainOp[](batch 同 record 原子)。
 * - 单 op → [op];array → 逐 op validate(全 ok 或全 reject,无 partial;§10.2/S10-5)。
 * - create/strict-tx/by-id 不在 DomainOp(body 含这些 kind → bad-kind 400,即 §1.2 stale-client 旧 body→400 payload-rejected 等价路径)。
 */
export const validateDomainOps = (body: unknown): DomainOp[] => {
  if (Array.isArray(body)) return body.map((op) => validateDomainOp(op))
  return [validateDomainOp(body)]
}

/** validateCreateBody:POST /:id/nodes/:nodeId body(零 privileged;id 来自 path,§10.1)。 */
export const validateCreateBody = (body: unknown): CreateBody => {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new DomainOpError('unknown-op-shape', 'create body must be object')
  const o = body as Record<string, unknown>
  if (typeof o.clientId !== 'string' || !o.clientId) throw new DomainOpError('unknown-op-shape', 'create clientId required')
  if (o.type !== 'node' && o.type !== 'edge' && o.type !== 'anchor') throw new DomainOpError('bad-kind', String(o.type))
  if (o.payload == null || typeof o.payload !== 'object' || Array.isArray(o.payload)) throw new DomainOpError('unknown-op-shape', 'create payload required')
  return { clientId: o.clientId, type: o.type, payload: o.payload }
}

/**
 * validateLegacyReplaceRequest:PATCH body = LegacyReplaceRequest 信封(§14.3;FX-5 drain-only 兼容通道)。
 * - kind='legacy-replace' + canvasId+nodeId+version=1+payload(object)+baseRevision(非负整数)。
 * - route 复用 PATCH decoder wire:body 非信封 → validateDomainOps 走 DomainOp 路径;信封 → 本 validator 走 drain。
 * - scope 校验(env.canvasId/nodeId 匹配 path)在 route 做(防同 nodeId 跨 canvas 重放);本 validator 只校 wire shape。
 */
export const validateLegacyReplaceRequest = (body: unknown): LegacyReplaceRequest => {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new DomainOpError('bad-legacy-envelope', 'legacy-replace must be object')
  const o = body as Record<string, unknown>
  if (o.kind !== 'legacy-replace') throw new DomainOpError('bad-legacy-envelope', 'kind must be legacy-replace')
  if (typeof o.canvasId !== 'string' || !o.canvasId) throw new DomainOpError('bad-legacy-envelope', 'canvasId required')
  if (typeof o.nodeId !== 'string' || !o.nodeId) throw new DomainOpError('bad-legacy-envelope', 'nodeId required')
  if (o.version !== 1) throw new DomainOpError('bad-legacy-envelope', 'version must be 1')
  if (o.payload == null || typeof o.payload !== 'object' || Array.isArray(o.payload)) throw new DomainOpError('bad-legacy-envelope', 'payload required')
  if (typeof o.baseRevision !== 'number' || !Number.isInteger(o.baseRevision) || o.baseRevision < 0) throw new DomainOpError('bad-legacy-envelope', 'baseRevision must be non-negative integer')
  return { kind: 'legacy-replace', canvasId: o.canvasId, nodeId: o.nodeId, version: 1, payload: o.payload, baseRevision: o.baseRevision }
}
