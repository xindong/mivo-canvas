// scripts/e2e/scenarios/mask.mjs
// mask-chat-card: 局部重绘并入对话生图卡片链路的主覆盖场景。
//  SC-01 提交后 chat panel 立即出现 user prompt + assistant enhancing 卡片
//       （.chat-param-card / .chat-thinking-placeholder），不自造 mask 专属 loading 组件
//  SC-02 enhance 完成前 /tasks/edit 不得发出（gated /api/mivo/enhance 延迟断言）
//  SC-03 enhance request body 含 intent:'edit' + editContext.maskBoundsPx/sourceSize/hasMask/sourceTitle
//  SC-04 enhance generate mode → /tasks/edit multipart prompt === richPrompt；卡片「增强 Prompt」折叠区含 richPrompt
//  SC-10 成功后 chat 落 .chat-result-image（resultNodeIds[0]）；同场景不再只落 notice；画布 placeholder 原位替换
//  SC-13 黑盘自愈：两次 /tasks/edit 不同 Idempotency-Key；期间 assistant 不出现 error；最终 done
//  SC-19 chat×mask 并行取消隔离：点 mask 卡取消只 DELETE edit task，chat 卡仍 generating
//  SC-05 enhance degraded → /tasks/edit prompt === 原始 + .chat-param-not-enhanced[data-degraded-reason]
//  SC-06 enhance chat mode → /tasks/edit prompt === 原始 + 生成后 notice 文本为 replyText
//
// #90 IDB harness: 用 waitForPersistedKv 读 persisted chat state，禁止 localStorage 断言。

import { doneTaskView, failedTaskView } from '../api-mocks.mjs'

const RICH_PROMPT = 'E2E mask rich prompt: replace the selected masked character with a handsome male character while preserving the unmasked image.'
const CHAT_REPLY_TEXT = '我会按你选中的区域改，未选区域保持不变。'

const canceledGenerationMessage = '已取消生成，可修改提示后重试。'

// 等待 chat panel 展开（mask overlay 关闭后可能仍折叠）。
const ensureChatPanelOpen = async (page) => {
  if (await page.locator('.ai-panel.collapsed').isVisible()) {
    await page.getByRole('button', { name: 'Open AI panel' }).click()
    await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
  }
  await page.waitForSelector('.ai-panel-header')
}

// 读取当前 scene 的最后一条 assistant 消息状态。
const readLastAssistantState = async (page, chatStoreSpec) => {
  const spec = await chatStoreSpec()
  return page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    return last ? { id: last.id, status: last.status, origin: last.origin, resultNodeIds: last.resultNodeIds || [], error: last.error, errorKind: last.errorKind, retryDisabledReason: last.retryDisabledReason } : null
  }, spec)
}

// 读取当前 scene 的 mask-edit notice 数量（kind==='notice' && origin==='mask-edit'）。
const readMaskNoticeCount = async (page, chatStoreSpec) => {
  const spec = await chatStoreSpec()
  return page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    return messages.filter((m) => m.kind === 'notice' && m.origin === 'mask-edit').length
  }, spec)
}

// Node.js 侧轮询（用于等待 route handler 推入的数组长度或计数器变化）。
const waitForCondition = async (fn, { timeout = 8000, interval = 50 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
}

export const runMaskScenario = async (context) => {
  const {
    canvasStoreSpec,
    chatStoreSpec,
    generatedImageB64,
    horizontalMaskSourceB64,
    mivoEditRequests,
    page,
    readCanvasState,
    waitForCanvasState,
    waitForPersistedKv,
  } = context

  // ── 公共 mask 编辑入口工具 ──
  const addHorizontalMaskSource = async () => {
    const spec = await canvasStoreSpec()
    return page.evaluate(async ({ moduleSpec, assetUrl }) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().addImportedImage(assetUrl, 'E2E horizontal mask source', 'source', { x: -280, y: 260 }, {
        dimensions: { width: 1600, height: 900 },
        mimeType: 'image/svg+xml',
        originalName: 'e2e-horizontal-mask-source.svg',
      })
      return useCanvasStore.getState().selectedNodeId
    }, { moduleSpec: spec, assetUrl: horizontalMaskSourceB64 })
  }

  const drawPointRegion = async () => {
    const stage = await page.locator('.image-mask-edit-stage').boundingBox()
    if (!stage) throw new Error('Mask edit stage should be visible')
    await page.mouse.click(stage.x + stage.width * 0.52, stage.y + stage.height * 0.5)
  }

  const openMaskEditorOn = async (sourceNodeId) => {
    await page.locator(`[data-node-id="${sourceNodeId}"]`).click()
    await page.waitForSelector('.selection-quick-toolbar')
    await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
    await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
    await page.waitForSelector('.image-mask-edit-stage')
    await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '点选', exact: true }).click()
  }

  // ── SC-01/02/03/04/10: 主覆盖 —— enhance generate mode 全链路断言 ──
  // 重置场景让 ref-hero 回来。
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await page.waitForSelector('[data-node-id="ref-hero"]')

  // 自定义 /api/mivo/enhance：gated（延迟 release），capture request body，返回 generate mode。
  // 顺便保留 mivoEditRequests（/tasks/edit 的 prompt/fileKeys）由默认 mock 捕获。
  const enhanceRequests = []
  let releaseEnhance
  const enhanceGate = new Promise((resolve) => { releaseEnhance = resolve })
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    let body = null
    try { body = route.request().postDataJSON() } catch { body = null }
    enhanceRequests.push(body || {})
    await enhanceGate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e mask reasoning',
        richPrompt: RICH_PROMPT,
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // 重置默认 GET /tasks/* 计数器（前面的 scenario 可能已耗尽 progressive 序列）。
  let mainGetCalls = 0
  const mainSequence = [
    { id: 'task-e2e', kind: 'edit', status: 'running', progress: 10, stage: 'submit', requestId: 'e2e-mask-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-mask-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'edit', status: 'running', progress: 60, stage: 'poll', requestId: 'e2e-mask-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-mask-1', model: 'gpt-image-2', result: { images: [{ b64: generatedImageB64 }] } },
  ]
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    mainGetCalls += 1
    const view = mainSequence[Math.min(mainGetCalls - 1, mainSequence.length - 1)]
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) })
  })

  const mainSourceNodeId = 'ref-hero'
  const editRequestCountBefore = mivoEditRequests.length
  await openMaskEditorOn(mainSourceNodeId)
  await drawPointRegion()
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  const mainBefore = await readCanvasState()
  const mainBeforeImageCount = mainBefore.nodes.filter((n) => n.type === 'image').length
  const mainPrompt = 'E2E main mask repaint'
  await page.locator('.image-mask-edit-prompt textarea').fill(mainPrompt)

  // SC-01/02: 提交后立即出现 enhancing 卡片；enhance gated 期间 /tasks/edit POST count=0。
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)
  // SC-01: assistant enhancing 卡片已渲染（.chat-param-card + .chat-thinking-placeholder）
  await page.waitForSelector('.chat-message-assistant .chat-param-card', { timeout: 5000 })
  await page.waitForSelector('.chat-message-assistant .chat-thinking-placeholder', { timeout: 5000 })
  const enhancingCardText = await page.locator('.chat-message-assistant').last().locator('.chat-thinking-placeholder').innerText()
  if (!/深度思考中/.test(enhancingCardText)) {
    throw new Error(`SC-01: enhancing card should show "深度思考中…", got: ${JSON.stringify(enhancingCardText)}`)
  }

  // SC-02: enhance 仍在 gated，/tasks/edit POST count 必须为 0。
  // 给一点时间让潜在的错误 POST 被观察到（不应有）。
  await new Promise((r) => setTimeout(r, 300))
  if (mivoEditRequests.length !== editRequestCountBefore) {
    throw new Error(`SC-02: /tasks/edit must not fire before /enhance resolves, got ${mivoEditRequests.length - editRequestCountBefore} extra POST(s)`)
  }

  // SC-03: enhance request body 含 intent:'edit' + editContext 字段。
  if (enhanceRequests.length === 0) {
    throw new Error('SC-03: /enhance should have been called with intent:"edit" before /tasks/edit')
  }
  const enhanceBody = enhanceRequests[0]
  if (enhanceBody.intent !== 'edit') {
    throw new Error(`SC-03: enhance body should carry intent:"edit", got: ${JSON.stringify(enhanceBody.intent)}`)
  }
  const editContext = enhanceBody.editContext
  if (!editContext) {
    throw new Error(`SC-03: enhance body should carry editContext, got: ${JSON.stringify(enhanceBody)}`)
  }
  for (const field of ['maskBoundsPx', 'sourceSize', 'hasMask', 'sourceTitle']) {
    if (!(field in editContext)) {
      throw new Error(`SC-03: editContext should carry ${field}, got: ${JSON.stringify(editContext)}`)
    }
  }
  // maskBoundsPx 与 flow 捕获值逐字段相等；满足 0<=x<=x+width<=sourceSize.width。
  const mb = editContext.maskBoundsPx
  const ss = editContext.sourceSize
  if (mb && ss && typeof mb.x === 'number' && typeof mb.width === 'number' && typeof ss.width === 'number') {
    if (!(mb.x >= 0 && mb.x + mb.width <= ss.width)) {
      throw new Error(`SC-03: maskBoundsPx out of bounds: x=${mb.x} width=${mb.width} sourceWidth=${ss.width}`)
    }
  }

  // Release enhance → generate mode with richPrompt.
  releaseEnhance()

  // SC-04: 等 enhancing → generating 转换完成（enhance 返回后 patch 成 generating）。
  await page.waitForFunction(
    () => {
      const cards = Array.from(document.querySelectorAll('.chat-message-assistant'))
      const last = cards[cards.length - 1]
      if (!last) return false
      const card = last.querySelector('.chat-param-card')
      const thinking = last.querySelector('.chat-thinking-placeholder')
      return card && !thinking
    },
    { timeout: 5000 },
  ).catch(() => {})
  // 展开「增强 Prompt」折叠区。
  const promptFoldBtn = page.locator('.chat-message-assistant').last().locator('.chat-param-fold-btn', { hasText: '增强 Prompt' })
  if (await promptFoldBtn.count() > 0) {
    await promptFoldBtn.click()
    await page.waitForFunction(
      (expected) => {
        const cards = Array.from(document.querySelectorAll('.chat-message-assistant'))
        const last = cards[cards.length - 1]
        if (!last) return false
        const body = last.querySelector('.chat-param-fold-body')
        return body && body.textContent && body.textContent.includes(expected)
      },
      RICH_PROMPT,
      { timeout: 5000 },
    )
  }

  // 等 /tasks/edit POST 落地（mivoEditRequests 由默认 mock 推入）。
  const editPostDeadline = Date.now() + 5000
  while (Date.now() < editPostDeadline && mivoEditRequests.length <= editRequestCountBefore) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })

  // SC-04: /tasks/edit multipart prompt === richPrompt。
  const mainLatestRequest = mivoEditRequests.at(-1)
  if (!mainLatestRequest || mainLatestRequest.prompt !== RICH_PROMPT) {
    throw new Error(`SC-04: /tasks/edit prompt should equal richPrompt, got: ${JSON.stringify(mainLatestRequest?.prompt)}`)
  }

  // SC-10: assistant done + resultNodeIds + .chat-result-image；同场景不再只落 notice。
  await waitForCanvasState(
    (state, payload) => state.nodes.filter((n) => n.type === 'image').length >= payload.minImageCount,
    { minImageCount: mainBeforeImageCount + 1 },
  )
  const mainAssistant = await readLastAssistantState(page, chatStoreSpec)
  if (!mainAssistant || mainAssistant.status !== 'done') {
    throw new Error(`SC-10: assistant should be done, got: ${JSON.stringify(mainAssistant)}`)
  }
  if (!mainAssistant.resultNodeIds || mainAssistant.resultNodeIds.length === 0) {
    throw new Error(`SC-10: assistant should carry resultNodeIds, got: ${JSON.stringify(mainAssistant)}`)
  }
  if (mainAssistant.origin !== 'mask-edit') {
    throw new Error(`SC-10: assistant should be origin:"mask-edit", got: ${JSON.stringify(mainAssistant.origin)}`)
  }
  // 同场景 generate mode 不应落 mask-edit notice（finishMaskEditMessage 只在跨场景或 chat mode 加 notice）。
  const mainNoticeCount = await readMaskNoticeCount(page, chatStoreSpec)
  if (mainNoticeCount !== 0) {
    throw new Error(`SC-10: same-scene generate-mode done should not append mask-edit notice, got ${mainNoticeCount}`)
  }
  // 画布 placeholder 原位替换（尺寸保持）。
  const mainAfter = await readCanvasState()
  const mainResultNode = mainAfter.nodes.find((n) => n.id === mainAssistant.resultNodeIds[0])
  const mainSourceNode = mainAfter.nodes.find((n) => n.id === mainSourceNodeId)
  if (mainResultNode && mainSourceNode && (Math.abs(mainResultNode.width - mainSourceNode.width) > 1 || Math.abs(mainResultNode.height - mainSourceNode.height) > 1)) {
    throw new Error(`SC-10: result should preserve placeholder size ${mainSourceNode.width}x${mainSourceNode.height}, got ${mainResultNode.width}x${mainResultNode.height}`)
  }

  // ── SC-13: 黑盘自愈重试 ──
  // mock 第一次 done 返黑盘，第二次返正常图。断言两次 /tasks/edit 不同 Idempotency-Key，
  // 期间 assistant 不出现 error，DOM 仍 generating；最终 done。
  const blackPlateB64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 8, 8)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  if (!blackPlateB64) throw new Error('Unable to synthesize black-plate b64 for SC-13')

  const blackPlateEditTaskIds = []
  const blackPlateIdempotencyKeys = []
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    const taskId = `task-black-${blackPlateEditTaskIds.length + 1}`
    blackPlateEditTaskIds.push(taskId)
    blackPlateIdempotencyKeys.push(route.request().headers()['idempotency-key'] || '')
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId }) })
  })

  let blackPlateGetCall = 0
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-black', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    blackPlateGetCall += 1
    const view = blackPlateGetCall === 1
      ? doneTaskView([{ b64: blackPlateB64 }])
      : doneTaskView([{ b64: generatedImageB64 }])
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) })
  })

  // 重置场景，触发黑盘 self-heal。
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await page.waitForSelector('[data-node-id="ref-hero"]')
  await openMaskEditorOn('ref-hero')
  await drawPointRegion()
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill('E2E black-plate self-heal')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)

  // SC-13: 两次 /tasks/edit POST，不同 Idempotency-Key，不同 taskId。
  await waitForCondition(() => blackPlateEditTaskIds.length >= 2, { timeout: 8000 })
  if (blackPlateEditTaskIds[0] === blackPlateEditTaskIds[1]) {
    throw new Error(`SC-13: retry should produce a different taskId, got ${JSON.stringify(blackPlateEditTaskIds)}`)
  }
  if (!blackPlateIdempotencyKeys[0] || !blackPlateIdempotencyKeys[1]) {
    throw new Error(`SC-13: each /tasks/edit must carry an Idempotency-Key header, got ${JSON.stringify(blackPlateIdempotencyKeys)}`)
  }
  if (blackPlateIdempotencyKeys[0] === blackPlateIdempotencyKeys[1]) {
    throw new Error(`SC-13: self-heal retry must use a different Idempotency-Key (dedupe), got duplicate ${JSON.stringify(blackPlateIdempotencyKeys)}`)
  }

  // SC-13: self-heal 期间 assistant 不出现 status:'error'，DOM 仍 generating/cancel。
  // 在第一次黑盘 done 之后、第二次重试期间取样 chat state。
  // 等 first done 已经被消费、重试已经开始（blackPlateGetCall >= 1 之后）。
  await waitForCondition(() => blackPlateGetCall >= 1, { timeout: 5000 })
  // 重试期间取样：assistant 不应为 error。
  const retryState = await readLastAssistantState(page, chatStoreSpec)
  if (!retryState || retryState.status === 'error') {
    throw new Error(`SC-13: assistant should stay in-flight during self-heal retry, got: ${JSON.stringify(retryState)}`)
  }

  // 最终 done。
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })
  const blackDoneState = await readLastAssistantState(page, chatStoreSpec)
  if (!blackDoneState || blackDoneState.status !== 'done') {
    throw new Error(`SC-13: assistant should be done after self-heal, got: ${JSON.stringify(blackDoneState)}`)
  }

  // ── SC-W2②: cancel/failed 三态 —— placeholder 回滚，无新 image node ──
  const verifyMaskEditTerminalFailure = async ({ label, taskView }) => {
    // 给 terminal failure 一个干净的 /enhance（避免继承前面 gated route 的副作用）。
    await page.unroute('**/api/mivo/enhance')
    await page.route('**/api/mivo/enhance', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'generate', scene: 'general', reasoning: 'e2e', richPrompt: `e2e ${label} rich`, imgRatio: '1:1', quality: 'medium', enhanced: true }),
      })
    })
    await page.unroute('**/api/mivo/tasks/edit')
    await page.route('**/api/mivo/tasks/edit', async (route) => {
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: `task-${label}` }) })
    })
    await page.unroute('**/api/mivo/tasks/*')
    await page.route('**/api/mivo/tasks/*', async (route) => {
      const method = route.request().method()
      if (method === 'DELETE') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: `task-${label}`, status: 'canceled' }) }); return }
      if (method !== 'GET') { await route.fallback(); return }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(taskView) })
    })

    await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().loadScene('character-flow')
      useCanvasStore.getState().resetCurrentScene()
    }, await canvasStoreSpec())
    await page.waitForSelector('[data-node-id="ref-hero"]')
    const before = await readCanvasState()
    const beforeImageCount = before.nodes.filter((n) => n.type === 'image').length
    await openMaskEditorOn('ref-hero')
    await drawPointRegion()
    await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
    await page.locator('.image-mask-edit-prompt textarea').fill(`E2E ${label} path`)
    await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
    await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
    await ensureChatPanelOpen(page)
    const after = await readCanvasState()
    const afterImageCount = after.nodes.filter((n) => n.type === 'image').length
    if (afterImageCount !== beforeImageCount) {
      throw new Error(`SC-W2② ${label} path should roll back placeholder (no new image node), got before=${beforeImageCount} after=${afterImageCount}`)
    }
    // mask 失败后 chat card 应展示 error row（mask-edit origin）。用 chat state 轮询兜底
    //（DOM 可能在 panel 折叠时不可见，chat state 是 zustand store 真相源）。
    let failState = null
    const failDeadline = Date.now() + 10000
    while (Date.now() < failDeadline) {
      failState = await readLastAssistantState(page, chatStoreSpec)
      if (failState && failState.status === 'error') break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!failState || failState.status !== 'error') {
      throw new Error(`SC-W2② ${label} path: assistant should be error, got: ${JSON.stringify(failState)}`)
    }
  }

  await verifyMaskEditTerminalFailure({ label: 'failed', taskView: failedTaskView('upstream 500', { status: 'failed', progress: 50 }) })
  await verifyMaskEditTerminalFailure({ label: 'canceled', taskView: failedTaskView('用户取消', { status: 'canceled', progress: 50, stage: 'canceled' }) })

  // ── SC-19: chat×mask 并行取消隔离 ──
  // 拦截 /tasks/generate 与 /tasks/edit 各挂起；发普通 chat 生图 + 画布提交 mask edit；
  // 点 mask 卡取消 → 断言只有 edit task 被 DELETE、chat 卡仍 generating；release generate 后 chat 卡 done。
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await page.waitForSelector('[data-node-id="ref-hero"]')

  // enhance 返回默认 generate mode（快速返回，不 gate）。
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'generate', scene: 'general', reasoning: 'e2e', richPrompt: 'e2e parallel chat gen', imgRatio: '1:1', quality: 'medium', enhanced: true }),
    })
  })

  const parallelEditRequests = []
  const parallelGenerateTaskIds = []
  const parallelEditTaskIds = []
  const parallelDeleteUrls = []
  let releaseParallelGets
  const parallelGetGate = new Promise((resolve) => { releaseParallelGets = resolve })

  await page.unroute('**/api/mivo/tasks/generate')
  await page.route('**/api/mivo/tasks/generate', async (route) => {
    const taskId = `task-chat-parallel-${parallelGenerateTaskIds.length + 1}`
    parallelGenerateTaskIds.push(taskId)
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId }) })
  })
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    const taskId = `task-mask-parallel-${parallelEditTaskIds.length + 1}`
    parallelEditTaskIds.push(taskId)
    try {
      const request = route.request()
      const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', { method: 'POST', headers: request.headers(), body: request.postDataBuffer() })
      const formData = await formRequest.formData()
      parallelEditRequests.push({ prompt: String(formData.get('prompt') || '') })
    } catch { parallelEditRequests.push({ prompt: '' }) }
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId }) })
  })
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    const url = route.request().url()
    if (method === 'DELETE') {
      parallelDeleteUrls.push(url)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method === 'POST') { await route.fallback(); return }
    if (method !== 'GET') { await route.fallback(); return }
    // 挂起所有 GET，直到 release。
    await parallelGetGate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])),
    })
  })

  // 发起普通 chat 生图（先不选节点，composer 文本生图）。
  await ensureChatPanelOpen(page)
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().selectNode(undefined)
  }, await canvasStoreSpec())
  await page.locator('.chat-composer-textarea').fill('E2E parallel chat generation')
  await page.locator('.chat-composer-textarea').press('Enter')
  // 等 /tasks/generate POST 落地。
  await waitForCondition(() => parallelGenerateTaskIds.length >= 1, { timeout: 5000 })

  // 提交 mask edit。
  await openMaskEditorOn('ref-hero')
  await drawPointRegion()
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill('E2E parallel mask edit')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)
  // 等 /tasks/edit POST 落地。
  await waitForCondition(() => parallelEditTaskIds.length >= 1, { timeout: 5000 })

  // 两个卡片都在 generating。点 mask 卡的取消按钮。
  // mask 卡是最后一条 assistant 消息（最近提交）。
  const maskCancelButton = page.locator('.chat-message-assistant').last().locator('.chat-cancel-btn')
  await page.waitForSelector('.chat-message-assistant .chat-cancel-btn', { timeout: 5000 })
  // 记录 release 前的 DELETE 数。
  const deleteBeforeCancel = parallelDeleteUrls.length
  await maskCancelButton.click()
  // 等 DELETE 落地（mask task cancel 走 DELETE /tasks/:id）。
  await waitForCondition(() => parallelDeleteUrls.length > deleteBeforeCancel, { timeout: 5000 })

  // SC-19: 只 DELETE 了 mask task，没有 DELETE chat task。
  const maskDeletes = parallelDeleteUrls.filter((url) => url.includes('task-mask-parallel'))
  const chatDeletes = parallelDeleteUrls.filter((url) => url.includes('task-chat-parallel'))
  if (maskDeletes.length !== 1) {
    throw new Error(`SC-19: should DELETE exactly one mask task, got ${JSON.stringify(maskDeletes)}`)
  }
  if (chatDeletes.length !== 0) {
    throw new Error(`SC-19: should NOT DELETE chat task, got ${JSON.stringify(chatDeletes)}`)
  }

  // mask 卡应转 error（canceled）；chat 卡仍 generating。
  // 先 release 一个 GET 让 mask 的 cancel 收口（mask GET 被 abort 了，但 release 后 chat GET 能 done）。
  // 实际上 mask cancel 是 abort controller + catch 收口，不需要 GET 返回。chat 卡需要 GET done。
  releaseParallelGets()

  // chat 卡应最终 done。
  await page.waitForFunction(() => {
    const cards = Array.from(document.querySelectorAll('.chat-message-assistant'))
    const chatCard = cards.find((card) => card.querySelector('.chat-result-image'))
    return chatCard !== undefined
  }, { timeout: 10000 })

  // mask 卡应展示 error row（canceled）。
  await page.waitForSelector('.chat-message-assistant .chat-error-row', { timeout: 5000 })
  const parallelMaskState = await readLastAssistantState(page, chatStoreSpec)
  if (!parallelMaskState || parallelMaskState.status !== 'error' || parallelMaskState.errorKind !== 'canceled') {
    throw new Error(`SC-19: mask card should be canceled error, got: ${JSON.stringify(parallelMaskState)}`)
  }
  if (parallelMaskState.error !== canceledGenerationMessage) {
    throw new Error(`SC-19: mask card error text mismatch, got: ${JSON.stringify(parallelMaskState.error)}`)
  }

  // ── SC-05: enhance degraded ──
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enhanced: false, degradedReason: 'timeout', stage: 'fallback' }),
    })
  })
  // 重置 GET /tasks/* 为 done 序列。
  let degradedGetCalls = 0
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) }); return }
    if (method !== 'GET') { await route.fallback(); return }
    degradedGetCalls += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
  })
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    try {
      const request = route.request()
      const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', { method: 'POST', headers: request.headers(), body: request.postDataBuffer() })
      const formData = await formRequest.formData()
      parallelEditRequests.push({ prompt: String(formData.get('prompt') || '') })
    } catch { parallelEditRequests.push({ prompt: '' }) }
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-degraded' }) })
  })

  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await page.waitForSelector('[data-node-id="ref-hero"]')
  const degradedPrompt = 'E2E degraded mask repaint'
  await openMaskEditorOn('ref-hero')
  await drawPointRegion()
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill(degradedPrompt)
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-message-assistant .chat-param-not-enhanced[data-degraded-reason="timeout"]', { timeout: 5000 })
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })
  // SC-05: /tasks/edit prompt === 原始 prompt（degraded 用原始 overlay prompt）。
  const degradedRequest = parallelEditRequests.at(-1)
  if (!degradedRequest || degradedRequest.prompt !== degradedPrompt) {
    throw new Error(`SC-05: degraded /tasks/edit prompt should equal original prompt, got: ${JSON.stringify(degradedRequest?.prompt)}`)
  }

  // ── SC-06: enhance chat mode ──
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'chat', replyText: CHAT_REPLY_TEXT, enhanced: true }),
    })
  })
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await page.waitForSelector('[data-node-id="ref-hero"]')
  const chatModePrompt = 'E2E chat mode mask repaint'
  await openMaskEditorOn('ref-hero')
  await drawPointRegion()
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill(chatModePrompt)
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })
  // SC-06: /tasks/edit prompt === 原始 prompt（chat mode 也用原始 prompt 出图）。
  const chatModeRequest = parallelEditRequests.at(-1)
  if (!chatModeRequest || chatModeRequest.prompt !== chatModePrompt) {
    throw new Error(`SC-06: chat mode /tasks/edit prompt should equal original prompt, got: ${JSON.stringify(chatModeRequest?.prompt)}`)
  }
  // SC-06: 生成后 notice 文本为 replyText。
  const chatModeNoticeRaw = await waitForPersistedKv(
    page,
    'mivo-chat-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const byScene = parsed?.state?.messagesByScene ?? {}
        return Object.values(byScene).flat().some((m) => m.kind === 'notice' && m.origin === 'mask-edit' && (m.text || m.prompt || '').includes(CHAT_REPLY_TEXT))
      } catch { return false }
    },
    { timeout: 3000 },
  )
  if (!chatModeNoticeRaw) {
    throw new Error('SC-06: chat mode should append a mask-edit notice with replyText after generation')
  }
}
