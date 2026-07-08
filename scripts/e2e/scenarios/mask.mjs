// scripts/e2e/scenarios/mask.mjs
// mask-chat-card: 局部重绘并入对话生图卡片链路的主覆盖场景。
//  新实现(2026-07-07):局部重绘不做 LLM 提示词增强(/enhance 零调用,SC-01 末断言);
//  /tasks/edit prompt 走双图模板外壳(commit 253bd42 设计,runner.ts:BFF 透传前端 buildDualImagePrompt),
//  用户原文逐字嵌在外壳内——「无增强」在网络层的形态 = 原文不被 LLM 改写,而非裸等于原文。
//  旧 SC-02(enhance gate)/SC-03(enhance body)/SC-05(degraded)/SC-06(chat mode)已随 enhance 删除。
//  SC-01 提交后 chat panel 立即出现 user prompt + assistant 卡片(enhancing→generating)
//  SC-04 /tasks/edit prompt 内逐字嵌着用户原文(双图模板外壳内,无 LLM 增强)
//  SC-10 成功后 chat 落 .chat-result-image（resultNodeIds[0]）；同场景不再只落 notice；画布 placeholder 原位替换
//  SC-13 gemini 深色/黑结果直落,不做黑块自愈(canInspect 仅 gpt-image-2);只一次 /tasks/edit,最终 done
//  SC-19 chat×mask 并行取消隔离：点 mask 卡取消只 DELETE edit task，chat 卡仍 generating
//
// #90 IDB harness: 用 waitForPersistedKv 读 persisted chat state，禁止 localStorage 断言。

import { doneTaskView, failedTaskView } from '../api-mocks.mjs'
import { clickCanvasNode, waitForNodeRendered } from '../renderer-evidence.mjs'


const canceledGenerationMessage = '已取消生成，可修改提示后重试。'

// contentEditable 富文本编辑器(非 textarea)输入:click 聚焦 + insertText,
// 触发 input 事件让 overlay 的 hasText/占位符逻辑生效。
const fillMaskPrompt = async (page, text) => {
  const editor = page.locator('.image-mask-edit-prompt .image-mask-edit-editor')
  await editor.click()
  await page.evaluate((t) => { document.execCommand('insertText', false, t) }, text)
}

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
    rendererMode,
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
    await clickCanvasNode(page, rendererMode, sourceNodeId)
    await page.waitForSelector('.selection-quick-toolbar')
    await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
    await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
    await page.waitForSelector('.image-mask-edit-stage')
    await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '点选', exact: true }).click()
  }

  // 2026-07-07 决策:局部重绘不做提示词增强。新实现里 /enhance 不应被调用;注册计数
  // route 钉住契约,SC-01 末尾断言计数 === 0。后续 SC-W2②/SC-19 会 unroute 重注册自己
  // 的 /enhance(那些场景故意走 enhance 路径,不在此契约范围)。
  let enhanceCallCount = 0
  await page.route('**/api/mivo/enhance', async (route) => {
    enhanceCallCount += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'generate', scene: 'general', reasoning: 'e2e', richPrompt: 'e2e derived concept image', imgRatio: '1:1', quality: 'medium', enhanced: true }),
    })
  })

  // ── SC-01/02/03/04/10: 主覆盖 —— enhance generate mode 全链路断言 ──
  // 重置场景让 ref-hero 回来。
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await waitForNodeRendered(page, rendererMode, 'ref-hero')

  // 新实现(2026-07-07):局部重绘不做提示词增强,无 /enhance 请求,/tasks/edit prompt
  // 原样透传。SC-02(enhance gate)/SC-03(enhance body)场景已随 enhance 删除不复存在。

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
  await fillMaskPrompt(page, mainPrompt)

  // SC-01: 提交后立即出现 chat 卡片(enhancing→generating);新实现不做 enhance,
  // /tasks/edit 立即发出(无 enhance gate,SC-02 删除)。
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-message-assistant .chat-generating-indicator', { timeout: 5000 })

  // SC-02 提交链路改写合并到此(新实现不做 enhance,gating 从「enhance 完成后提交」改为
  // 「直接提交」;断言 /tasks/edit prompt 逐字等于用户输入;提交→轮询→出图主链路原样保留)。
  // SC-03(enhance body)/SC-05(degraded)/SC-06(chat mode)整场景只测已删 enhance 死行为,
  // 整删;其活断言(prompt===原始)由本 SC-04 覆盖,错误展示路径由 SC-W2② 覆盖。
  // 等 /tasks/edit POST 落地（mivoEditRequests 由默认 mock 推入）。
  const editPostDeadline = Date.now() + 5000
  while (Date.now() < editPostDeadline && mivoEditRequests.length <= editRequestCountBefore) {
    await new Promise((r) => setTimeout(r, 50))
  }
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })

  // SC-04: /tasks/edit 层契约 = 双图模板外壳内逐字嵌着用户原文(无 LLM 增强)。
  //  外壳 = 确定性模板(作者设计,commit 253bd42;runner.ts:BFF 透传前端 buildDualImagePrompt);
  //  无 LLM 增强由 /enhance 零调用断言(SC-01 末)守护;用户原文逐字性由 includes 守护。
  const mainLatestRequest = mivoEditRequests.at(-1)
  if (!mainLatestRequest || !mainLatestRequest.prompt.includes(mainPrompt)) {
    throw new Error(`SC-04: /tasks/edit prompt should embed original user input verbatim, got: ${JSON.stringify(mainLatestRequest?.prompt)}`)
  }
  // 防退化:成功路径(markedImage 生成成功)必走 Set-of-Mark 双图模板,外壳引用"图2"(标注图)。
  if (!mainLatestRequest.prompt.includes('图2')) {
    throw new Error(`SC-04: /tasks/edit prompt should carry dual-image template shell referencing 图2, got: ${JSON.stringify(mainLatestRequest.prompt)}`)
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
  // 画布 placeholder 原位替换。规格(2026-07-05):占位一律 320×320 方形,替换时按
  // 结果图自然比例(fixture courage-1.jpg 1080×1920 = 9:16)与占位等面积落画布。
  const mainAfter = await readCanvasState()
  const mainResultNode = mainAfter.nodes.find((n) => n.id === mainAssistant.resultNodeIds[0])
  if (!mainResultNode) {
    throw new Error(`SC-10: result node ${mainAssistant.resultNodeIds[0]} not found in canvas state`)
  }
  const mainResultRatio = mainResultNode.width / mainResultNode.height
  const mainResultArea = mainResultNode.width * mainResultNode.height
  if (Math.abs(mainResultRatio - 1080 / 1920) > 0.05) {
    throw new Error(`SC-10: result ratio should match result image 9:16, got ${mainResultNode.width}x${mainResultNode.height}`)
  }
  if (mainResultArea < 320 * 320 * 0.9 || mainResultArea > 320 * 320 * 1.1) {
    throw new Error(`SC-10: result should be equal-area with 320x320 placeholder, got ${mainResultNode.width}x${mainResultNode.height}`)
  }

  // 2026-07-07 决策:局部重绘不做提示词增强。新实现 /enhance 不被调用,计数应 === 0。
  if (enhanceCallCount !== 0) {
    throw new Error(`SC-01: /enhance should not be called for mask edit (2026-07-07 decision: no prompt enhancement), got ${enhanceCallCount} calls`)
  }

  // ── SC-13: gemini 深色/黑结果直落，不做黑块自愈（不误报重试循环） ──
  // 2026-07-08 用户实测「深色图出不了图」根因:近黑连通块检测在 gemini 整图重生成的深色
  // 内容上纯误报,触发本不该有的 self-heal 循环。修复:黑块自愈只对 gpt-image-2 的
  // alpha-mask 挖洞路生效(maskEditGeneration.ts canInspect gate),gemini 路跳过检测、
  // 结果照常 commit。gpt-image-2 的自愈重试逻辑由 maskEditGeneration.test.ts 单测覆盖。
  // 本 SC 守护「gemini 返黑不触发第二次 /tasks/edit」——即那个 bug 不回归。UI 无模型选择
  // 器,mask edit 只能提交 gemini(maskEditDefaultModel),故此路无法从 UI 触发 gpt 自愈。
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
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    const taskId = `task-black-${blackPlateEditTaskIds.length + 1}`
    blackPlateEditTaskIds.push(taskId)
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId }) })
  })

  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-black', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    // 每次 GET 都返黑盘 done。gemini 不检测黑块 → 应原样 commit,不触发第二次 edit。
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: blackPlateB64 }])) })
  })

  // 重置场景，提交一张会返回黑盘结果的 gemini 局部重绘。
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await waitForNodeRendered(page, rendererMode, 'ref-hero')
  await openMaskEditorOn('ref-hero')
  await drawPointRegion()
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await fillMaskPrompt(page, 'E2E gemini dark-result no-selfheal')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)

  // 至少一次 /tasks/edit POST 落地。
  await waitForCondition(() => blackPlateEditTaskIds.length >= 1, { timeout: 8000 })
  // gemini 路应原样 commit → assistant done，结果图落地（不因黑块误报卡在 in-flight）。
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })
  const blackDoneState = await readLastAssistantState(page, chatStoreSpec)
  if (!blackDoneState || blackDoneState.status !== 'done') {
    throw new Error(`SC-13: gemini dark result should commit as done (no self-heal), got: ${JSON.stringify(blackDoneState)}`)
  }
  // 关键回归守护:gemini 不做黑块自愈 → 只应有一次 /tasks/edit,绝不因误报触发重试循环。
  await new Promise((r) => setTimeout(r, 300))
  if (blackPlateEditTaskIds.length !== 1) {
    throw new Error(`SC-13: gemini must NOT self-heal-retry on dark result (expected exactly 1 /tasks/edit), got ${JSON.stringify(blackPlateEditTaskIds)}`)
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
    await waitForNodeRendered(page, rendererMode, 'ref-hero')
    const before = await readCanvasState()
    const beforeImageCount = before.nodes.filter((n) => n.type === 'image').length
    await openMaskEditorOn('ref-hero')
    await drawPointRegion()
    await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
    await fillMaskPrompt(page, `E2E ${label} path`)
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
  await waitForNodeRendered(page, rendererMode, 'ref-hero')

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
  await fillMaskPrompt(page, 'E2E parallel mask edit')
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

}
