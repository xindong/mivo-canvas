// src/lib/snapshotCursorBundle.ts
// A2-S3 client-side canvas-level opaque SnapshotCursor bundle holder。
// 权威:docs/decisions/n20-truth-source-decision.md §14.7 NOTES + §10.2 wire;
//       docs/decisions/canvas-sync-port-inventory.md §1/§2.1/§2.2/§3。
//
// 设计要点(§14.7 v9):
// - SnapshotCursor = canvas 级 opaque **bundle**(recordId→BaseCursor 映射 + canvas order cursor + event since cursor)。
// - client 对 base/order/since 的内部值**不签名不验签**(签名 secret 只在 server/lib/baseCursor.ts;
//   client 无 secret,不可伪造)。client 只持有 server 签发的 opaque 字符串/数字,回传 If-Match。
//   故本模块是 opaque bookkeeping,非 codec——不 import node:crypto,不在 client 签任何 token。
// - submitChange 按 change kind/id **解包对应 wire base**(edit/delete→record base;reorder→order cursor;
//   create→无 base;缺命中项→undefined,fail-visible,禁借用别的 record 的 base 串用)。
// - accepted/conflict 用 wire response 的 base/seq **定点增量更新** bundle(仅命中 record/order 项;
//   未命中项值不变;非整 bundle 全量重建)。
// - since 用 wire 权威 seq(非连续 seq:旧 since=5 响应 seq=11 → since=11;seq 不要求连续,取响应权威值)。
//
// 边界:本模块是 client adapter 的 bundle 工具;port(canvasSyncPort.ts)的 SnapshotCursor 是 branded unknown,
//   本模块用 `as unknown as SnapshotCursor` 构造/port 侧零 inspection。不出现 wire DTO(DomainOp/If-Match 字串
//   仅为 base 字符串透传,不在本模块构造 wire body)。

import type { SnapshotCursor, CanvasChange } from './canvasSyncPort'
import type { Revision } from '../../shared/persist-contract.ts'

/**
 * bundle 内部形状(client adapter 解释;port 侧 opaque)。
 * - records:recordId → opaque BaseCursor 字符串(server encodeBase 签发;client 不读内部)。
 *   来源:hydrate 响应签发(server 签发 base 时)+ write accepted 响应签发。pre-existing record 若
 *   hydrate 未签发 base → 该 record 不在 map(缺命中,extractWireBase 返 undefined,fail-visible/refetch)。
 * - orderCv:canvas contentVersion(Revision 数字;reorder 的 If-Match 走 parseIfMatch bare number,非签名)。
 * - sinceSeq:canvas 事件 seq(catch-up poll ?since= 锚点;取响应权威 seq,非连续)。
 * - canvasId:scope(防跨 canvas bundle 串用;client 不验签但保留 scope 供调用方自检)。
 */
export type Bundle = {
  readonly canvasId: string
  readonly records: Readonly<Record<string, string>>
  readonly orderCv: Revision
  readonly sinceSeq: number
}

/** brand 标记(bundle 内部形状 → port SnapshotCursor opaque)。 */
const BRAND = '__snapshotCursorBundle__'

/**
 * 从 server hydrate 响应构建 canvas 级 bundle。
 * @param canvasId scope(防跨 canvas 串用)。
 * @param recordBases recordId → opaque BaseCursor 字符串(hydrate 签发;pre-existing record 无 base 时不入 map)。
 * @param orderCv canvas contentVersion(reorder If-Match bare number)。
 * @param sinceSeq canvas 事件 seq(catch-up 锚点;无则 0)。
 */
export const buildBundle = (
  canvasId: string,
  recordBases: Record<string, string>,
  orderCv: Revision,
  sinceSeq = 0,
): SnapshotCursor => {
  const bundle: Bundle & { __brand?: typeof BRAND } = {
    canvasId,
    records: { ...recordBases },
    orderCv,
    sinceSeq,
  }
  ;(bundle as { __brand?: string }).__brand = BRAND
  return bundle as unknown as SnapshotCursor
}

/** 取 bundle 内部形状(adapter 用;非 port 面)。null = 非 bundle cursor(防误用)。 */
export const unwrapBundle = (cursor: SnapshotCursor | undefined): Bundle | null => {
  if (cursor == null || typeof cursor !== 'object') return null
  const b = cursor as unknown as Bundle & { __brand?: string }
  if (b.__brand !== BRAND) return null
  return { canvasId: b.canvasId, records: { ...b.records }, orderCv: b.orderCv, sinceSeq: b.sinceSeq }
}

/**
 * 按 change kind/id 解包对应 wire base(submitChange 用;§14.7 / inventory §3)。
 * - edit-* / delete-* → records[recordId](opaque BaseCursor 字符串,回传 If-Match)。
 * - reorder-children → String(orderCv)(reorder If-Match 走 parseIfMatch bare contentVersion)。
 * - create-* → undefined(create 免 base;POST 不带 If-Match)。
 * - 缺命中项(edit/delete 的 recordId 不在 records) → undefined(**fail-visible**,禁借用别的 record base 串用)。
 *
 * 返 undefined 时调用方据 fail-visible 语义处理:不可借用别的 record base;应 refetch/拒绝(见 item 1 spec)。
 */
export const extractWireBase = (
  cursor: SnapshotCursor | undefined,
  change: CanvasChange,
): string | undefined => {
  const bundle = unwrapBundle(cursor)
  if (!bundle) return undefined
  switch (change.kind) {
    case 'edit-node':
    case 'delete-node':
      return bundle.records[change.nodeId]
    case 'edit-edge':
    case 'delete-edge':
      return bundle.records[change.edgeId]
    case 'edit-anchor':
    case 'delete-anchor':
      return bundle.records[change.anchorId]
    case 'reorder-children':
      // reorder If-Match = bare contentVersion(parseIfMatch 路径,非签名 order base)。
      return bundle.orderCv > 0 ? String(bundle.orderCv) : undefined
    case 'create-node':
    case 'create-edge':
    case 'create-anchor':
    case 'update-meta':
      return undefined // create 免 base;update-meta 走 canvas meta PUT(metaRevision,非本 bundle 范畴)
  }
}

/** 取 canvas 事件 since seq(catch-up poll ?since= 锚点)。null = 非 bundle。 */
export const getSinceSeq = (cursor: SnapshotCursor | undefined): number | null => {
  const bundle = unwrapBundle(cursor)
  return bundle ? bundle.sinceSeq : null
}

/** 取 canvas contentVersion(reorder If-Match bare base)。null = 非 bundle。 */
export const getOrderCv = (cursor: SnapshotCursor | undefined): Revision | null => {
  const bundle = unwrapBundle(cursor)
  return bundle ? bundle.orderCv : null
}

/**
 * accepted 定点增量更新(§14.7 v9:仅命中 record/order 项更新,未命中项值不变;非整 bundle 重建)。
 * - edit/delete/create 命中 record:更新 records[recordId] = newBase(server accepted 响应签发的新 base)。
 * - reorder 命中 order:更新 orderCv = newOrderCv(reorder 响应 bump 后的新 contentVersion)。
 * - sinceSeq:取 wire 权威 seq(非连续;旧 since=5 响应 seq=11 → since=11)。newSeq<=0 时不动(无权威 seq)。
 * - 未命中 record 的 base **值不变**(spike S10-12 增量铁证:.toStrictEqual 未命中项)。
 * @param change 用于定位命中 record/order 项(create/edit/delete→recordId;reorder→order)。
 * @param newBase accepted 响应签发的新 base(create/edit/delete 用;无则不更新 record 项)。
 * @param newSeq accepted 响应权威 seq(取 wire 值,非连续;无则不更新 since)。
 * @param newOrderCv reorder accepted 响应 bump 后的新 contentVersion(仅 reorder 用)。
 */
export const applyAccepted = (
  cursor: SnapshotCursor,
  change: CanvasChange,
  newBase?: string,
  newSeq?: number,
  newOrderCv?: Revision,
): SnapshotCursor => {
  const bundle = unwrapBundle(cursor)
  if (!bundle) return cursor // 防御:非 bundle cursor 不动(调用方应先 buildBundle)
  const records = { ...bundle.records }
  switch (change.kind) {
    case 'edit-node':
      if (newBase !== undefined) records[change.nodeId] = newBase
      break
    case 'delete-node':
      delete records[change.nodeId]
      break
    case 'edit-edge':
      if (newBase !== undefined) records[change.edgeId] = newBase
      break
    case 'delete-edge':
      delete records[change.edgeId]
      break
    case 'edit-anchor':
      if (newBase !== undefined) records[change.anchorId] = newBase
      break
    case 'delete-anchor':
      delete records[change.anchorId]
      break
    case 'create-node':
      if (newBase !== undefined) records[change.node.id] = newBase
      break
    case 'create-edge':
      if (newBase !== undefined) records[change.edge.id] = newBase
      break
    case 'create-anchor':
      if (newBase !== undefined) records[change.anchor.id] = newBase
      break
    case 'reorder-children':
      // order 项增量更新(reorder 响应 bump 后新 contentVersion);未传 newOrderCv 时不动。
      // 不在此更新 records(reorder 不改 per-record base)。
      break
    case 'update-meta':
      break // update-meta 非 bundle record/order 项范围
  }
  // since 取 wire 权威 seq(非连续:旧 sinceSeq=5,响应 newSeq=11 → sinceSeq=11)。
  const sinceSeq = typeof newSeq === 'number' && newSeq > 0 ? newSeq : bundle.sinceSeq
  // order 增量:reorder accepted 带 newOrderCv 才更新;否则保留(bundle.orderCv 不变)。
  const orderCv =
    change.kind === 'reorder-children' && newOrderCv !== undefined && newOrderCv > 0 ? newOrderCv : bundle.orderCv
  return buildBundle(bundle.canvasId, records, orderCv, sinceSeq)
}

/**
 * conflict 定点增量更新(§14.7 v9:conflict 响应返 current base/seq,增量更新对应项;未命中项不动)。
 * - edit/delete conflict:更新 records[recordId] = currentBase(server 返的 current cursor 供 re-fetch/retry)。
 * - reorder conflict:更新 orderCv = currentOrderCv(server 返 current contentVersion)。
 * - sinceSeq:取 wire 权威 seq(conflict 响应亦携 seq;非连续)。
 * 仅更新对应 current base;**不**整 bundle 重建,不误改别的 record 项。
 */
export const applyConflict = (
  cursor: SnapshotCursor,
  change: CanvasChange,
  currentBase?: string,
  currentSeq?: number,
  currentOrderCv?: Revision,
): SnapshotCursor => {
  const bundle = unwrapBundle(cursor)
  if (!bundle) return cursor
  const records = { ...bundle.records }
  switch (change.kind) {
    case 'edit-node':
    case 'delete-node':
      if (currentBase !== undefined) records[change.nodeId] = currentBase
      break
    case 'edit-edge':
    case 'delete-edge':
      if (currentBase !== undefined) records[change.edgeId] = currentBase
      break
    case 'edit-anchor':
    case 'delete-anchor':
      if (currentBase !== undefined) records[change.anchorId] = currentBase
      break
    case 'reorder-children':
    case 'create-node':
    case 'create-edge':
    case 'create-anchor':
    case 'update-meta':
      break // create 无 conflict(create dup→409 不返 current base;reorder conflict 走 currentOrderCv)
  }
  const sinceSeq = typeof currentSeq === 'number' && currentSeq > 0 ? currentSeq : bundle.sinceSeq
  const orderCv =
    change.kind === 'reorder-children' && currentOrderCv !== undefined && currentOrderCv > 0
      ? currentOrderCv
      : bundle.orderCv
  return buildBundle(bundle.canvasId, records, orderCv, sinceSeq)
}

/**
 * 更新单条 record 的 base(供 caller 在 loadSnapshot authoritative load 后定点回填某 record 的 base,
 * 不重建整 bundle)。port R2-P1-3:delete-* accepted 必经 authoritative load 取真实 cursor——caller 拿到
 * 该 record 的 current base 后用本函数回填 bundle(防常量 cursor 冒充权威)。
 */
export const setRecordBase = (
  cursor: SnapshotCursor,
  recordId: string,
  base: string | undefined,
): SnapshotCursor => {
  const bundle = unwrapBundle(cursor)
  if (!bundle) return cursor
  const records = { ...bundle.records }
  if (base === undefined) delete records[recordId]
  else records[recordId] = base
  return buildBundle(bundle.canvasId, records, bundle.orderCv, bundle.sinceSeq)
}
