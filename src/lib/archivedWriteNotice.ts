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

/** canvasId → 上次弹 toast 的 epoch ms。模块级状态(测试用 __resetArchivedWriteNotice 清空)。 */
const lastShown = new Map<string, number>()

/**
 * 通知用户一次"画布已归档,写被拒"。按 canvasId 做 3s 短窗口去重:窗口内第二次调用静默
 * (debugLogger.log 留痕,不静默丢);窗口外或不同 canvasId 照常弹 warn toast。
 *
 * 调用方:canvasSyncRuntime rejected(reason 'archived')、writeRetryQueue drain rejected
 * (body.error 'archived')。两处都传被拒写的 canvasId。
 */
export const notifyArchivedWriteBlocked = (canvasId: string): void => {
  const now = Date.now()
  const last = lastShown.get(canvasId)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    debugLogger.log(
      SOURCE,
      `archived-write toast suppressed (dedup ${DEDUP_WINDOW_MS}ms, same canvasId): canvas ${canvasId}`,
    )
    return
  }
  lastShown.set(canvasId, now)
  toastFeedback.warn(ARCHIVED_WRITE_MESSAGE)
}

/** 测试专用:清空去重状态(隔离用例,防同文件内同 canvasId 用例互相污染)。 */
export const __resetArchivedWriteNotice = (): void => {
  lastShown.clear()
}
