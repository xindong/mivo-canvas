// archive-cr6-409 e2e — PR-C1 CR-6 双通道 409 引导(archived canvas 写被拒,不静默丢编辑)。
//
// 通道 5a(canvasSyncPort 路径,node/edge 传输主路径):createFetchCanvasSyncPort 注入 mock fetch(直返
//   409 Response,不走真网络——避免浏览器把 409 记成 "Failed to load resource" console error 触发 harness
//   console-error 守卫),传给 enqueueCanvasSyncChanges(绕过 local persist 的 isLocalPersist 门)。port 的
//   transport(requestJson→HttpError→409 handler)真实执行:409 {error:'archived'} → rejected reason 'archived'
//   (非 conflict)→ canvasSyncRuntime rejected 分支 toastFeedback.warn "先恢复再编辑"。
// 通道 5b(队列路径,chat/meta):自建 createWriteQueue(app 实例,toast 落 app toastStore)+ executor 直返
//   rejected{body:{error:'archived'}}(不 fetch,免 console error;classifyHttpStatus→drain 已由 writeRetryQueue.test.ts
//   单测覆盖)→ drain case 'rejected' 判 body.error==='archived' → 专用 error toast。
import { waitForCanvasReady } from '../renderer-evidence.mjs'

const toastArchived = (page, type) =>
  page.locator(`.toast-item${type ? `.${type}` : ''}`).filter({ hasText: '此画布已归档,请先恢复再编辑' })

// 找到 app 已加载的模块资源路径(带 ?v= 查询),确保 import 命中同一模块实例(toast 落 app toastStore)。
const moduleSpec = async (page, needle) =>
  page.evaluate((needle) => {
    const resource = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes(needle))
    return resource ? new URL(resource).pathname + new URL(resource).search : needle
  }, needle)

export const runArchiveCr6409Scenario = async (context) => {
  const { canvasUrl, page, rendererMode, wait, isProdTopology } = context

  // prod topology skip:本场景依赖 Vite dev server 的 TS module HMR——moduleSpec 通过
  // performance resource entries 找带 ?v= 查询的 .ts 模块路径,再 dynamic import 注入 mock。
  // prod 拓扑 BFF 只 serve dist/ 静态产物,不存在 .ts 资源 → moduleSpec 回退原始 .ts 路径 →
  // 浏览器向 BFF 端口 import 该路径失败(Failed to fetch dynamically imported module)。
  // 409 逻辑已由 writeRetryQueue.test.ts 单测覆盖,prod e2e 跳过不降低覆盖。dev 拓扑照常执行。
  if (isProdTopology) {
    console.log('[e2e-smoke] SKIP scenario=archive-cr6-409 topology=prod reason=依赖 Vite dev server TS module HMR (moduleSpec + dynamic import mock),prod 拓扑 BFF 无 .ts 资源;409 逻辑由 writeRetryQueue.test.ts 单测覆盖')
    return
  }

  await page.goto(canvasUrl, { waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)

  const sharedCanvasId = 'cr6-shared'

  // ── 5a:canvasSyncPort 路径(node create 撞 409 archived → warn toast)──────────────
  {
    const runtimeSpec = await moduleSpec(page, '/src/canvas/actions/canvasSyncRuntime.ts')
    const portSpec = await moduleSpec(page, '/src/lib/canvasSyncPortClient.ts')

    await page.evaluate(
      async ({ runtimeSpec, portSpec, sharedCanvasId }) => {
        const { enqueueCanvasSyncChanges } = await import(runtimeSpec)
        const { createFetchCanvasSyncPort } = await import(portSpec)
        // mock fetch:直返 409 {error:'archived'}(archived canvas 写被 CR-6 拒)。不走真网络 → 浏览器
        //   不记 "Failed to load resource: 409" console error(否则触发 harness console-error 守卫)。
        //   transport 的 requestJson 仍真实执行:解析 body → HttpError(409) → 409 handler → rejected 'archived'。
        const mockFetch = async () =>
          new Response(JSON.stringify({ error: 'archived' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          })
        const port = createFetchCanvasSyncPort({ fetch: mockFetch, getAuthHeaders: async () => ({}) })
        await enqueueCanvasSyncChanges(
          sharedCanvasId,
          [{ kind: 'create-node', node: { id: 'n-cr6a', type: 'text', x: 10, y: 10, width: 96, height: 42, title: 'T', text: '', transform: { x: 10, y: 10, width: 96, height: 42, rotation: 0 }, fills: [], strokes: [], effects: [], relations: {}, hidden: false } }],
          port,
        )
      },
      { runtimeSpec, portSpec, sharedCanvasId },
    )
    await wait()
    // 5a 断言:archived 引导 warn toast 出现(canvasSyncRuntime rejected→toastFeedback.warn;编辑不静默丢)。
    await toastArchived(page, 'warning').waitFor({ state: 'visible', timeout: 5000 })
  }

  // ── 5b:同 canvas 的队列路径撞 archived → 3s 窗口内不重复 toast──────────────────
  {
    const queueSpec = await moduleSpec(page, '/src/lib/writeRetryQueue.ts')
    const userIdSpec = await moduleSpec(page, '/src/lib/persistUserId.ts')

    await page.evaluate(
      async ({ queueSpec, userIdSpec, sharedCanvasId }) => {
        const { createWriteQueue } = await import(queueSpec)
        const { setPersistUserId } = await import(userIdSpec)
        setPersistUserId('e2e-cr6b')
        // executor 直返 rejected{body:{error:'archived'}}(不 fetch → 免 409 console error)。
        //   classifyHttpStatus(409,{error:'archived'}) → rejected(body) 已由 writeRetryQueue.test.ts 单测覆盖;
        //   本 e2e 验真 createWriteQueue drain → case 'rejected' 判 body.error==='archived' → 专用 toast。
        const executor = async () => ({ status: 'rejected', body: { error: 'archived' } })
        const q = createWriteQueue({ executor, clock: () => Date.now(), random: () => 0.5 })
        await q.enqueue({ kind: 'updateCanvas', canvasId: sharedCanvasId, projectId: '', title: 'renamed' })
        await q.drain()
      },
      { queueSpec, userIdSpec, sharedCanvasId },
    )
    await wait()
    const allArchivedToasts = toastArchived(page)
    if ((await allArchivedToasts.count()) !== 1) {
      throw new Error(`same-canvas dual archived rejection should show exactly 1 toast, got ${await allArchivedToasts.count()}`)
    }
    if ((await toastArchived(page, 'warning').count()) !== 1 || (await toastArchived(page, 'error').count()) !== 0) {
      throw new Error('archived write notifier must use one unified warning toast')
    }
  }
}
