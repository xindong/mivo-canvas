// src/lib/snapshotCursorStore.ts
// A2-S3 client 侧 per-canvas SnapshotCursor bundle 持有者(hydrate 写,adapter/executor 读)。
// 权威:docs/decisions/n20-truth-source-decision.md §14.7 + canvas-sync-port-inventory.md §2.1/§2.2/§3。
//
// 设计:
// - hydrate(GET /api/canvas/:id)响应现签发 per-record base(RecordEntry.base)+ canvas bundle(CanvasMeta.bundle)
//   + sinceSeq(§14.7/§10.2;A2-S3 server 补全)。client 从响应构建 canvas 级 opaque bundle(recordId→base 映射 +
//   orderCv=contentVersion + sinceSeq)存此 holder;submitChange/edit/delete 从 holder 取对应 wire base 作 If-Match。
// - holder 是 module 级 Map(同 persistBoot.orderRevisionByCanvas/userStateMap 模式);local 模式永不写(hydrate 不跑)。
// - bundle 构建用 snapshotCursorBundle.buildBundle(opaque holder,client 不签名不验签;base 是 server 签发的
//   opaque 字符串,client 透传 If-Match)。

import { buildBundle, setRecordBase } from './snapshotCursorBundle'
import type { SnapshotCursor } from './canvasSyncPort'
import type { GetCanvasResponse, RecordEntry } from '../../shared/persist-contract.ts'

const cursorByCanvas = new Map<string, SnapshotCursor>()

/**
 * A2-S3:从 GET /api/canvas/:id 响应构建 canvas 级 bundle cursor 并存入 holder。
 * - records:recordId → RecordEntry.base(server 签发的 opaque BaseCursor;pre-existing record 即得 base)。
 * - orderCv:contentVersion(reorder If-Match bare number)。
 * - sinceSeq:CanvasMeta.sinceSeq(canvas 事件 seq;catch-up + bundle since)。
 * hydrate 调此;后 adapter/submitChange 据 change.recordId/op class 从 holder 抽对应 wire base。
 */
export const storeCanvasCursor = (resp: GetCanvasResponse): SnapshotCursor => {
  const recordBases: Record<string, string> = {}
  for (const r of [...resp.nodes, ...resp.edges, ...resp.anchors] as RecordEntry[]) {
    if (r.base) recordBases[r.id] = r.base
  }
  const cursor = buildBundle(resp.id, recordBases, resp.contentVersion, resp.sinceSeq ?? 0)
  cursorByCanvas.set(resp.id, cursor)
  return cursor
}

/** 取某 canvas 的 bundle cursor(adapter/submitChange 用;未 hydrate / local → undefined)。 */
export const getCanvasCursor = (canvasId: string): SnapshotCursor | undefined =>
  cursorByCanvas.get(canvasId)

/** 真 submitChange 用:以增量/refresh 结果整体替换某 canvas 的 bundle cursor。 */
export const setCanvasCursor = (canvasId: string, cursor: SnapshotCursor): void => {
  cursorByCanvas.set(canvasId, cursor)
}

/** 测试用:定点回填单 record base(authoritative load 后,R2-P1-3)。 */
export const setCanvasRecordBase = (canvasId: string, recordId: string, base: string | undefined): void => {
  const cur = cursorByCanvas.get(canvasId)
  if (!cur) return
  // 增量更新(snapshotCursorBundle.setRecordBase;未命中 record 不动)。
  cursorByCanvas.set(canvasId, setRecordBase(cur, recordId, base))
}

/** 测试用:清 holder(逐 test 隔离)。 */
export const __resetCanvasCursorStore = (): void => {
  cursorByCanvas.clear()
}
