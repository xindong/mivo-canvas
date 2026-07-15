// src/lib/assetAttachWiring.ts
// Block 3 (A2-S4): asset attach/detach 客户端接线 helper。
// 把「画布节点开始/停止引用某 server 资产」翻译成 NonCanvas WriteOp,经 enqueuePersistWrite →
// writeRetryQueue → persistWriteExecutor → BFF(POST /api/assets/:assetId/{attach,detach})。
//
// 设计要点(见预检报告 + lead 批复):
// - 只对 server 资产(isServerAssetUrl,前缀 mivo-sasset:)发 attach/detach;local/asset:// 资产无 server
//   assetId(server 上不存在,无需 refcount),跳过。enqueuePersistWrite 本身在 local 模式也 inert
//   (writeQueue undefined → no-op),双重保险,生产 local 默认零变化。
// - canvasId required(G2.2/#233):server attach 双门 ① 验 actor 对 canvas write 权 + node 属该 canvas(不信裸 nodeId);
//   detach 用 canvasId 做 ref composite-key 选择(P1-4)。ownerFp 服务端派生(client 不传)。
// - R1 ordering(Block 3 裁定方案 A):attach 必须在 node-create submitChange resolve 成功后 enqueue
//   (server 端 node 已存在,attach gate ① persist.getChild 才能找到);reject 不发 attach。由 canvasSyncRuntime
//   在 submitChanges 的 accepted 路径调本 helper。detach 在 delete-node submitChange 成功后 enqueue
//   (server 端 node 已删,但 asset ref 残留 —— server 不级联清,detach 显式清它;detach 幂等,ref 已不在也 success)。
// - fire-and-forget(不 await):enqueuePersistWrite 把 op 放 IDB 队列,drain 异步发;失败入队重试,断网恢复补发。
//
// OUT 边界(本块不接,见 PR 残余风险段):
// - import/generate 路径的 attach:这些 mutation 不经 wrapMutation,server 模式下 node 不落 server,attach 无对象。
//   依赖 T2.2 deferred-kinds server-wire lane。
// - mask-edit 换 asset(edit-node 改 assetUrl)的 diff 机制由 Block 2(T2.2)覆盖(computeAssetSideEffects assetUrl-diff
//   + submitChanges edit-node accepted 接线);但产生此类 edit-node 的 mask-edit/generation 调用方仍走 deferred
//   路径不经 wrapMutation,实际接线是 Block 3。

import { enqueuePersistWrite } from './persistBoot'
import { isServerAssetUrl, serverAssetId } from './assetServiceMode'

/**
 * 从 assetUrl 抽 server assetId;非 server 资产返回 undefined(调用方跳过)。
 * server 资产 URL 形如 `mivo-sasset:<sha256-hex>`;serverAssetId 剥前缀得 content-hash assetId。
 * 用于从 NodeRecord.asset.url(canvasSyncRuntime 的 SyncSnapshot)抽 attach/detach 所需 assetId。
 */
export const serverAssetIdFromUrl = (assetUrl: string | undefined): string | undefined => {
  if (!assetUrl || !isServerAssetUrl(assetUrl)) return undefined
  return serverAssetId(assetUrl)
}

/**
 * Enqueue attach:画布节点(nodeId)开始引用 server 资产(assetId)于画布(canvasId)。
 * 调用方须保证 node-create submitChange 已 resolve 成功(R1 方案 A:attach 依赖 server 端 node 已存在)。
 */
export const enqueueAssetAttach = (canvasId: string, assetId: string, nodeId: string): void => {
  void enqueuePersistWrite({ kind: 'attachAsset', canvasId, assetId, nodeId })
}

/**
 * Enqueue detach:画布节点停止引用 server 资产。幂等(404/already-detached → success)。
 * 调用方须保证 delete-node submitChange 已 resolve 成功(detach 清残留 ref;refcount→0 触发 7 天 grace → purge)。
 */
export const enqueueAssetDetach = (canvasId: string, assetId: string, nodeId: string): void => {
  void enqueuePersistWrite({ kind: 'detachAsset', canvasId, assetId, nodeId })
}
