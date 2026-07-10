// scripts/e2e/scenarios/mask-timeout-retry.mjs
// edit-timeout-batch: 局部重绘超时分级 + 中文文案 + 超时可重试 CTA + source 已删不可重试
//   Phase 1: /tasks/edit POST → taskId-1；/tasks/* GET 返 failed(error="Image API request
//             timed out") → 触发 upstream-timeout → 卡片 error 含「局部重绘上游超时」+
//             retryDisabledReason 为空（Retry 可点）。点 Retry → POST taskId-2 → GET done
//             → 卡片 done + result image。
//   Phase 2: 另一次 mask edit → POST taskId-3 → GET running（挂起）→ 删除 source →
//             release GET failed(timeout) → failMaskEditMessage 查 source 不在 →
//             retryDisabledReason 含「原图已被删除」+ Retry 按钮 disabled。
//   #90 IDB harness: 不用 localStorage 断言；状态读取走 store bridge（同 mask-source-delete 模式）。

import { doneTaskView, failedTaskView } from '../api-mocks.mjs'
import { clickCanvasNode, waitForNodeRendered } from '../renderer-evidence.mjs'

// contentEditable 富文本编辑器输入(对齐 mask.mjs fillMaskPrompt):prompt 输入区自
// 253bd42 起从 <textarea> 改为 contentEditable .image-mask-edit-editor,旧的
// '.image-mask-edit-prompt textarea' 选择器失效(fill 必 30s 超时)。内联避免改共享文件。
const fillMaskPrompt = async (page, text) => {
  const editor = page.locator('.image-mask-edit-prompt .image-mask-edit-editor')
  await editor.click()
  await page.evaluate((t) => { document.execCommand('insertText', false, t) }, text)
}

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

// 读取当前 scene 最后一条 mask-edit assistant 消息的关键字段。
const readLastMaskEditAssistant = async (page, chatStoreSpec) => {
  const spec = await chatStoreSpec()
  return page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.origin === 'mask-edit')
    return last
      ? {
          id: last.id,
          status: last.status,
          error: last.error,
          errorKind: last.errorKind,
          retryDisabledReason: last.retryDisabledReason,
          resultNodeIds: last.resultNodeIds || [],
        }
      : null
  }, spec)
}

export const runMaskTimeoutRetryScenario = async (context) => {
  const { canvasStoreSpec, chatStoreSpec, generatedImageB64, page, rendererMode } = context

  // ── 准备 ──
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await waitForNodeRendered(page, rendererMode, 'ref-hero')

  // enhance 返回 generate mode（快速返回）
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e mask-timeout-retry',
        richPrompt: 'E2E mask-timeout-retry rich prompt',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // /tasks/edit POST 计数器：每次返不同 taskId
  let editPostCount = 0
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    editPostCount += 1
    const taskId = `task-mask-timeout-${editPostCount}`
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId }) })
  })

  // /tasks/* GET：基于 editPostCount 分阶段
  //  count=1 → failed(timeout)  [Phase 1: 第一次 mask edit 超时]
  //  count=2 → done              [Phase 1: retry 成功]
  //  count=3 → running(挂起) → release 后 failed(timeout)  [Phase 2: source 已删超时]
  let phase2ReleaseTimeout = false
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }

    if (editPostCount === 1) {
      // Phase 1: 第一次 mask edit → upstream-timeout
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(failedTaskView('Image API request timed out')),
      })
      return
    }
    if (editPostCount === 2) {
      // Phase 1: retry → done
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])),
      })
      return
    }
    if (editPostCount === 3) {
      // Phase 2: 先 running 挂起，release 后 failed(timeout)
      if (!phase2ReleaseTimeout) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'task-mask-timeout-3',
            kind: 'edit',
            status: 'running',
            progress: 30,
            stage: 'poll',
            requestId: 'e2e-mask-timeout',
            model: 'gpt-image-2',
          }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(failedTaskView('Image API request timed out')),
      })
      return
    }
    await route.continue()
  })

  // ══ Phase 1: 超时 → 重试 → 成功 ══

  await collapseChatPanel(page)
  await openMaskEditorOn(page, rendererMode, 'ref-hero')
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await fillMaskPrompt(page, 'E2E mask timeout retry phase1')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })

  // 等 /tasks/edit POST 落地
  await waitForCondition(() => editPostCount >= 1, { timeout: 5000 })
  if (editPostCount !== 1) {
    throw new Error(`Phase 1: expected editPostCount=1, got ${editPostCount}`)
  }

  // 等卡片转 error
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-error-text', { timeout: 10000 })

  const phase1ErrorState = await readLastMaskEditAssistant(page, chatStoreSpec)
  if (!phase1ErrorState || phase1ErrorState.status !== 'error') {
    throw new Error(`Phase 1: assistant should be error, got: ${JSON.stringify(phase1ErrorState)}`)
  }
  if (!phase1ErrorState.error || !phase1ErrorState.error.includes('局部重绘上游超时')) {
    throw new Error(`Phase 1: error should contain 「局部重绘上游超时」, got: ${JSON.stringify(phase1ErrorState.error)}`)
  }
  if (phase1ErrorState.errorKind !== 'upstream-timeout') {
    throw new Error(`Phase 1: errorKind should be upstream-timeout, got: ${JSON.stringify(phase1ErrorState.errorKind)}`)
  }
  // 超时 + source 存在 → retryDisabledReason 为空（Retry 按钮可点）
  if (phase1ErrorState.retryDisabledReason) {
    throw new Error(`Phase 1: retryDisabledReason should be empty for timeout+source-exists, got: ${JSON.stringify(phase1ErrorState.retryDisabledReason)}`)
  }

  // 点 Retry 按钮
  await page.locator('.chat-retry-btn').last().click()

  // 等 /tasks/edit POST retry 落地
  await waitForCondition(() => editPostCount >= 2, { timeout: 5000 })

  // 等卡片转 done + result image
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })

  const phase1DoneState = await readLastMaskEditAssistant(page, chatStoreSpec)
  if (!phase1DoneState || phase1DoneState.status !== 'done') {
    throw new Error(`Phase 1 retry: assistant should be done, got: ${JSON.stringify(phase1DoneState)}`)
  }
  if (!phase1DoneState.resultNodeIds || phase1DoneState.resultNodeIds.length === 0) {
    throw new Error(`Phase 1 retry: assistant should carry resultNodeIds, got: ${JSON.stringify(phase1DoneState)}`)
  }

  // ══ Phase 2: 超时 + source 已删 → Retry disabled ══

  await collapseChatPanel(page)
  // ref-hero 仍存在（Phase 1 结果是新节点，不替换 source）
  await waitForNodeRendered(page, rendererMode, 'ref-hero')
  await openMaskEditorOn(page, rendererMode, 'ref-hero')
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await fillMaskPrompt(page, 'E2E mask timeout retry phase2')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })

  // 等 /tasks/edit POST 落地
  await waitForCondition(() => editPostCount >= 3, { timeout: 5000 })
  if (editPostCount !== 3) {
    throw new Error(`Phase 2: expected editPostCount=3, got ${editPostCount}`)
  }

  // 提交后删除 source image（GET 仍 running，poller 保持 alive）
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().deleteNode('ref-hero')
  }, await canvasStoreSpec())

  // release GET → failed(timeout)，failMaskEditMessage 查 source 不在 → retryDisabledReason
  phase2ReleaseTimeout = true

  // 等卡片转 error
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-error-text', { timeout: 10000 })

  const phase2ErrorState = await readLastMaskEditAssistant(page, chatStoreSpec)
  if (!phase2ErrorState || phase2ErrorState.status !== 'error') {
    throw new Error(`Phase 2: assistant should be error, got: ${JSON.stringify(phase2ErrorState)}`)
  }
  if (!phase2ErrorState.error || !phase2ErrorState.error.includes('局部重绘上游超时')) {
    throw new Error(`Phase 2: error should contain 「局部重绘上游超时」, got: ${JSON.stringify(phase2ErrorState.error)}`)
  }
  // source 已删 → retryDisabledReason 含「原图已被删除」
  if (!phase2ErrorState.retryDisabledReason || !phase2ErrorState.retryDisabledReason.includes('原图已被删除')) {
    throw new Error(`Phase 2: retryDisabledReason should contain 「原图已被删除」, got: ${JSON.stringify(phase2ErrorState.retryDisabledReason)}`)
  }

  // Retry 按钮应 disabled
  const retryBtnDisabled = await page.locator('.chat-message-assistant').last().locator('.chat-retry-btn').first().isDisabled()
  if (!retryBtnDisabled) {
    throw new Error('Phase 2: Retry button should be disabled when source is deleted')
  }

  // source 已删（sanity）
  const sourceStillInCanvas = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.some((n) => n.id === 'ref-hero')
  }, await canvasStoreSpec())
  if (sourceStillInCanvas) {
    throw new Error('Phase 2: source node ref-hero should have been deleted')
  }
}
