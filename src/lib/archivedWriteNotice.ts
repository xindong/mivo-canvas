// archivedWriteNotice — PR-C1 CR-6 双通道共享 archived-write toast 通知器(P2-4)。
//
// 问题:canvasSyncRuntime(rejected reason 'archived')与 writeRetryQueue drain(rejected body
//   error 'archived')两条通道对同一 canvasId 的同一操作都会弹同一条 warn toast「此画布已归档,
//   请先恢复再编辑。」。一次写撞 archived canvas 时,若该写同时落在两条通道(或两通道各处理一条
//   相邻写),用户连看两条同文案 toast——重复且吵。
//
// 修法:共享 notifier,按 canvasId 做 3s 短窗口去重 + 统一 level=warn(文案不变)。两条通道都改走它。
//   - 同 canvasId 3s 内第二次调用 → 静默(只 debugLogger.log 一条 suppressed 记录,留痕不静默丢)。
//   - 不同 canvasId 各自独立可见(不互相影响)。
//   - 单通道各自可见性保留:单条写只触发一次 notify,toast 照弹(回归不变)。
//
// 边界:仅 archived 专用文案走此去重;其余 rejected/terminal 文案仍各走各自 termToast(不复用)。
//   Date.now() 在本仓 writeRetryQueue/newId 等处已用,这里同用法,无新增限制。
import { toastFeedback } from '../store/toastStore'
import { debugLogger } from '../store/debugLogStore'

const SOURCE = 'Archived Write Notice'

/** 3s 去重窗口:同一 canvasId 在此窗口内的第二次 archived 拒绝不重复弹 toast。 */
const DEDUP_WINDOW_MS = 3000

/** 统一文案(与原两通道一致,不变)。 */
export const ARCHIVED_WRITE_MESSAGE = '此画布已归档,请先恢复再编辑。'

/**
 * P3 item 2:父项目归档专用文案。body.error==='archived' 且 body.id≠op.canvasId(即 409 的 id 是父
 * projectId,非画布自身归档)→ 用此文案,引导用户先恢复项目。与 ARCHIVED_WRITE_MESSAGE 共享 notifier
 * 去重(按 `kind:id` key,见 notifyByKey),不重复弹 toast。
 */
export const PARENT_ARCHIVED_WRITE_MESSAGE = '目标项目已归档,请先恢复项目再编辑该画布。'

/** 去重 key → 上次弹 toast 的 epoch ms。模块级状态(测试用 __resetArchivedWriteNotice 清空)。 */
const lastShown = new Map<string, number>()

/**
 * 共享去重 notifier(P3 item 2:canvas 自身归档与父项目归档共用同一 dedup Map,按 `kind:id` key)。
 * 按 key 做 3s 短窗口去重:窗口内第二次调用静默(debugLogger.log 留痕,不静默丢);窗口外或不同 key
 * 照常弹 warn toast(传 message)。canvas 自身归档 key=`canvas:<canvasId>`;父项目归档 key=`project:<projectId>`。
 */
const notifyByKey = (key: string, message: string): void => {
  const now = Date.now()
  // PR-C1 二轮 P3:清理过期条目(防长会话单调增长)。notify 是唯一写入点,顺带在此 GC:
  //   过期 = now - ts >= DEDUP_WINDOW_MS(与下方抑制判断同阈值,过期即该重新可见)。
  //   单调增长的代价 = O(n) 遍历,但长会话内同一 key 反复命中会原地刷新 ts(不增条目),
  //   故实际增长来源是不同 key 的遗留;清它们即可。
  for (const [k, ts] of lastShown) {
    if (now - ts >= DEDUP_WINDOW_MS) {
      lastShown.delete(k)
    }
  }
  const last = lastShown.get(key)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    debugLogger.log(
      SOURCE,
      `archived-write toast suppressed (dedup ${DEDUP_WINDOW_MS}ms, key ${key})`,
    )
    return
  }
  lastShown.set(key, now)
  toastFeedback.warn(message)
}

/**
 * 通知用户一次"画布已归档,写被拒"。按 canvasId 做 3s 短窗口去重:窗口内第二次调用静默
 * (debugLogger.log 留痕,不静默丢);窗口外或不同 canvasId 照常弹 warn toast。
 *
 * 调用方:canvasSyncRuntime rejected(reason 'archived')、writeRetryQueue drain rejected
 * (body.error 'archived',body.id===op.canvasId)。两处都传被拒写的 canvasId。
 */
export const notifyArchivedWriteBlocked = (canvasId: string): void => {
  notifyByKey(`canvas:${canvasId}`, ARCHIVED_WRITE_MESSAGE)
}

/**
 * P3 item 2:通知用户一次"目标项目已归档,写被拒"。当 409 body.error==='archived' 且 body.id(父
 * projectId)≠op.canvasId 时调用——区分父项目归档(非画布自身归档)。与 notifyArchivedWriteBlocked
 * 共享同一 dedup Map(按 `project:<projectId>` key),3s 窗口去重,不与画布归档 toast 互相抑制
 * (key 前缀不同),但同 projectId 重复命中静默。
 *
 * 调用方:writeRetryQueue drain rejected(body.error 'archived',body.id≠op.canvasId)。
 */
export const notifyParentArchivedWriteBlocked = (projectId: string): void => {
  notifyByKey(`project:${projectId}`, PARENT_ARCHIVED_WRITE_MESSAGE)
}

/** 测试专用:清空去重状态(隔离用例,防同文件内同 canvasId 用例互相污染)。 */
export const __resetArchivedWriteNotice = (): void => {
  lastShown.clear()
}

/** 测试专用:读取去重 Map 当前条目数(断言过期清理,防长会话单调增长)。 */
export const __getArchivedWriteNoticeSize = (): number => lastShown.size
