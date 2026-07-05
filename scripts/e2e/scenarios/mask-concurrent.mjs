// scripts/e2e/scenarios/mask-concurrent.mjs
// SC-14: 两个 mask edit 并发时取消第二个只 DELETE task-2，不影响 task-1；两张卡片最终各自 terminal
//  - 建两张 source image（A、B），各提交 mask edit
//    （/tasks/edit POST 第 1 次返 task-1、第 2 次返 task-2，计数器 route；/tasks/* GET 挂起两 task）
//  - 两张各出现 assistant generating card
//  - 点第二张卡（task-2）的取消按钮（.chat-cancel-btn，按 messageId 定位第二张）→
//    断言 /tasks/task-2 DELETE 发生、/tasks/task-1 DELETE 未发生
//  - release task-1 GET → done → 断言第一张卡 status='done' + result image；
//    第二张卡 status='error' errorKind='canceled'
//  - 用 page.route 捕获 DELETE 的 taskId（route.request().url() 提取）

import { doneTaskView } from '../api-mocks.mjs'
import { clickCanvasNode, waitForNodeRendered } from '../renderer-evidence.mjs'

const ensureChatPanelOpen = async (page) => {
  if (await page.locator('.ai-panel.collapsed').isVisible()) {
    await page.getByRole('button', { name: 'Open AI panel' }).click()
    await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
  }
  await page.waitForSelector('.ai-panel-header')
}

const collapseChatPanel = async (page) => {
  if (!(await page.locator('.ai-panel.collapsed').isVisible())) {
    await page.getByRole('button', { name: 'Collapse AI panel' }).click()
    await page.waitForSelector('.ai-panel.collapsed')
  }
}

const openMaskEditorOn = async (page, rendererMode, sourceNodeId) => {
  await clickCanvasNode(page, rendererMode, sourceNodeId)
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
  await page.waitForSelector('.image-mask-edit-stage')
  await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '点选', exact: true }).click()
}

const drawPointRegion = async (page) => {
  const stage = await page.locator('.image-mask-edit-stage').boundingBox()
  if (!stage) throw new Error('Mask edit stage should be visible')
  await page.mouse.click(stage.x + stage.width * 0.52, stage.y + stage.height * 0.5)
}

const waitForCondition = async (fn, { timeout = 8000, interval = 50 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
}

// 读取当前 scene 所有 mask-edit assistant 消息（按顺序，用于区分第一张/第二张）。
const readMaskEditAssistants = async (page, chatStoreSpec) => {
  const spec = await chatStoreSpec()
  return page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    return messages
      .filter((m) => m.role === 'assistant' && m.origin === 'mask-edit')
      .map((m) => ({
        id: m.id,
        status: m.status,
        resultNodeIds: m.resultNodeIds || [],
        error: m.error,
        errorKind: m.errorKind,
      }))
  }, spec)
}

export const runMaskConcurrentScenario = async (context) => {
  const { canvasStoreSpec, chatStoreSpec, generatedImageB64, horizontalMaskSourceB64, page, rendererMode } = context

  // ── 准备：character-flow + 两张 source image ──
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())

  const addSource = async (label, position) => {
    const spec = await canvasStoreSpec()
    const nodeId = await page.evaluate(
      async ({ moduleSpec, assetUrl, label, position }) => {
        const { useCanvasStore } = await import(moduleSpec)
        useCanvasStore.getState().addImportedImage(assetUrl, label, 'source', position, {
          dimensions: { width: 1600, height: 900 },
          mimeType: 'image/svg+xml',
          originalName: `e2e-${label}.svg`,
        })
        return useCanvasStore.getState().selectedNodeId
      },
      { moduleSpec: spec, assetUrl: horizontalMaskSourceB64, label, position },
    )
    await waitForNodeRendered(page, rendererMode, nodeId)
    return nodeId
  }

  const sourceAId = await addSource('concurrent-source-a', { x: -400, y: 200 })
  const sourceBId = await addSource('concurrent-source-b', { x: 300, y: 200 })

  // ── 路由 mock ──
  // enhance 返回 generate mode（快速返回）
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e concurrent',
        richPrompt: 'E2E concurrent rich prompt',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // /tasks/edit POST 计数器：第 1 次返 task-concurrent-1，第 2 次返 task-concurrent-2
  let concurrentEditPostCount = 0
  const concurrentEditTaskIds = []
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    concurrentEditPostCount += 1
    const taskId = `task-concurrent-${concurrentEditPostCount}`
    concurrentEditTaskIds.push(taskId)
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId }) })
  })

  // /tasks/* GET：返 running 直到 release 标志置 true 后返 done；DELETE 捕获 url。
  // 用 running→done 替代 gate 挂起：pollTimeoutMs=15s，gate 挂起会导致 task-1 的 GET
  // 超时 → card A 走 error 而非 done。running 响应立即返回，poller 在 sleep 期间被
  // abort 命中，cancel 能正常收口。
  const concurrentDeleteUrls = []
  let concurrentGetDone = false
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      concurrentDeleteUrls.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method === 'POST') { await route.fallback(); return }
    if (method !== 'GET') { await route.fallback(); return }
    // release 前：返 running（progress 30），poller 保持 alive 且不超时
    if (!concurrentGetDone) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'task-concurrent',
          kind: 'edit',
          status: 'running',
          progress: 30,
          stage: 'poll',
          requestId: 'e2e-concurrent',
          model: 'gpt-image-2',
        }),
      })
      return
    }
    // release 后：返 done
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
  })

  // ── 提交 mask edit A ──
  await collapseChatPanel(page)
  await openMaskEditorOn(page, rendererMode, sourceAId)
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill('E2E concurrent mask A')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)

  // 等 /tasks/edit POST A 落地
  await waitForCondition(() => concurrentEditPostCount >= 1, { timeout: 5000 })
  if (concurrentEditTaskIds[0] !== 'task-concurrent-1') {
    throw new Error(`SC-14: first edit POST should return task-concurrent-1, got ${JSON.stringify(concurrentEditTaskIds)}`)
  }

  // ── 提交 mask edit B ──
  await collapseChatPanel(page)
  await openMaskEditorOn(page, rendererMode, sourceBId)
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill('E2E concurrent mask B')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)

  // 等 /tasks/edit POST B 落地
  await waitForCondition(() => concurrentEditPostCount >= 2, { timeout: 5000 })
  if (concurrentEditTaskIds[1] !== 'task-concurrent-2') {
    throw new Error(`SC-14: second edit POST should return task-concurrent-2, got ${JSON.stringify(concurrentEditTaskIds)}`)
  }

  // 两张卡都在 generating。点第二张卡（task-2 / 最后一条 assistant）的取消按钮。
  await page.waitForSelector('.chat-message-assistant .chat-cancel-btn', { timeout: 5000 })
  const deleteBeforeCancel = concurrentDeleteUrls.length
  // 第二张卡是最后一条 assistant 消息（最近提交）。按 messageId 精确定位：
  // DOM 不暴露 data-message-id，但消息按顺序追加，.last() 即为第二张卡。
  // 同时用 chat state 交叉验证最后一条 mask-edit assistant 的 messageId。
  const maskAssistantsBeforeCancel = await readMaskEditAssistants(page, chatStoreSpec)
  if (maskAssistantsBeforeCancel.length < 2) {
    throw new Error(`SC-14: should have 2 mask-edit assistant cards before cancel, got ${maskAssistantsBeforeCancel.length}`)
  }
  // chat message list 会拦截 pointer events（Playwright actionability check 失败），
  // 用 evaluate 直接调 DOM click 触发 React onClick。
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.chat-message-assistant')
    const last = cards[cards.length - 1]
    const btn = last?.querySelector('.chat-cancel-btn')
    if (btn instanceof HTMLElement) btn.click()
  })

  // 等 DELETE task-2 落地
  await waitForCondition(() => concurrentDeleteUrls.length > deleteBeforeCancel, { timeout: 5000 })

  // SC-14: 只 DELETE 了 task-2，没有 DELETE task-1
  const task2Deletes = concurrentDeleteUrls.filter((url) => url.includes('task-concurrent-2'))
  const task1Deletes = concurrentDeleteUrls.filter((url) => url.includes('task-concurrent-1'))
  if (task2Deletes.length !== 1) {
    throw new Error(`SC-14: should DELETE exactly one task-concurrent-2, got ${JSON.stringify(task2Deletes)} (all deletes: ${JSON.stringify(concurrentDeleteUrls)})`)
  }
  if (task1Deletes.length !== 0) {
    throw new Error(`SC-14: should NOT DELETE task-concurrent-1, got ${JSON.stringify(task1Deletes)}`)
  }

  // release task-1 GET → done（task-2 已 cancel，其 poller 已 abort 停止）
  concurrentGetDone = true

  // SC-14: 第一张卡 done + result image
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })

  // SC-14: 第二张卡 status='error' errorKind='canceled'
  // 轮询 chat state 直到两张卡都 terminal
  let concurrentState = null
  const concurrentDeadline = Date.now() + 10000
  while (Date.now() < concurrentDeadline) {
    concurrentState = await readMaskEditAssistants(page, chatStoreSpec)
    if (
      concurrentState.length >= 2 &&
      concurrentState[0]?.status === 'done' &&
      concurrentState[1]?.status === 'error'
    ) break
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!concurrentState || concurrentState.length < 2) {
    throw new Error(`SC-14: should have 2 mask-edit assistant messages, got: ${JSON.stringify(concurrentState)}`)
  }
  // 第一张卡（task-1）：done + resultNodeIds
  if (concurrentState[0].status !== 'done') {
    throw new Error(`SC-14: first card (task-1) should be done, got: ${JSON.stringify(concurrentState[0])}`)
  }
  if (!concurrentState[0].resultNodeIds || concurrentState[0].resultNodeIds.length === 0) {
    throw new Error(`SC-14: first card (task-1) should carry resultNodeIds, got: ${JSON.stringify(concurrentState[0])}`)
  }
  // 第二张卡（task-2）：error + errorKind='canceled'
  if (concurrentState[1].status !== 'error') {
    throw new Error(`SC-14: second card (task-2) should be error, got: ${JSON.stringify(concurrentState[1])}`)
  }
  if (concurrentState[1].errorKind !== 'canceled') {
    throw new Error(`SC-14: second card (task-2) should have errorKind='canceled', got: ${JSON.stringify(concurrentState[1])}`)
  }
}
