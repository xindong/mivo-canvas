// scripts/e2e/scenarios/mask-hydration.mjs
// SC-15: IDB seed reload — 刷新后 persisted mask generating card 与 canvas generating
//        placeholder 同步 settle：card error、slot failed、retry disabled
//  - 提交 mask edit（running GET 永不 done）→ 等 generating 态持久化到 IDB
//  - reload → hydration settle：chat card error + retryDisabledReason、slot failed
//  - 用 #90 IDB harness (waitForPersistedKv) 确认 generating 态已持久化再 reload

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

export const runMaskHydrationScenario = async (context) => {
  const { canvasStoreSpec, canvasUrl, chatStoreSpec, generatedImageB64, page, rendererMode, waitForPersistedKv } = context

  // ── 准备 ──
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().loadScene('character-flow')
    useCanvasStore.getState().resetCurrentScene()
  }, await canvasStoreSpec())
  await waitForNodeRendered(page, rendererMode, 'ref-hero')

  // enhance 返回 generate mode
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e hydration',
        richPrompt: 'E2E hydration rich prompt',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // /tasks/edit POST → taskId
  let hydrationEditPostCount = 0
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    hydrationEditPostCount += 1
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-hydration-seed' }) })
  })

  // /tasks/* GET：永远返 running（永不 done，让 card 停在 generating）
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'task-hydration-seed', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-hydration', model: 'gpt-image-2' }),
    })
  })

  // 提交 mask edit
  await collapseChatPanel(page)
  await openMaskEditorOn(page, rendererMode, 'ref-hero')
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await fillMaskPrompt(page, 'E2E hydration seed')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })

  // 等 /tasks/edit POST 落地
  await waitForCondition(() => hydrationEditPostCount >= 1, { timeout: 5000 })

  // 等 chat state 进入 generating（enhance 返回后 patch 为 generating）
  const chatSpec = await chatStoreSpec()
  await waitForCondition(async () => {
    const generating = await page.evaluate(async (moduleSpec) => {
      const { useChatStore } = await import(moduleSpec)
      const { useCanvasStore } = await import('/src/store/canvasStore.ts')
      const sceneId = useCanvasStore.getState().sceneId
      const messages = useChatStore.getState().messagesByScene[sceneId] || []
      return messages.some((m) => m.role === 'assistant' && m.origin === 'mask-edit' && m.status === 'generating')
    }, chatSpec)
    return generating
  }, { timeout: 8000 })

  // 等 IDB 持久化 generating 态（chat + canvas）
  const chatPersisted = await waitForPersistedKv(
    page,
    'mivo-chat-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const byScene = parsed?.state?.messagesByScene ?? {}
        return Object.values(byScene).flat().some((m) => m.role === 'assistant' && m.origin === 'mask-edit' && m.status === 'generating')
      } catch { return false }
    },
    { timeout: 8000 },
  )
  if (!chatPersisted) {
    throw new Error('SC-15: chat generating state should be persisted to IDB before reload')
  }

  const canvasPersisted = await waitForPersistedKv(
    page,
    'mivo-canvas-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const canvases = parsed?.state?.canvases ?? {}
        return Object.values(canvases).some((c) =>
          (c.nodes || []).some((n) => n.type === 'ai-slot' && n.aiWorkflow?.status === 'generating'),
        )
      } catch { return false }
    },
    { timeout: 8000 },
  )
  if (!canvasPersisted) {
    throw new Error('SC-15: canvas generating slot should be persisted to IDB before reload')
  }

  // ── reload ──
  await page.goto(canvasUrl, { waitUntil: 'networkidle' })

  // 等 app 加载完成（chat panel 可见后 store 才就绪）
  await page.waitForSelector('.ai-panel-header', { timeout: 15000 })

  // 等 hydration 完成 + settled 态持久化回 IDB。
  // 用 IDB 断言（不依赖 chatStore 模块路径解析，reload 后 performance entries 可能未就绪）。
  const settledChatRaw = await waitForPersistedKv(
    page,
    'mivo-chat-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const byScene = parsed?.state?.messagesByScene ?? {}
        return Object.values(byScene).flat().some((m) =>
          m.role === 'assistant' &&
          m.origin === 'mask-edit' &&
          m.status === 'error' &&
          m.retryDisabledReason,
        )
      } catch { return false }
    },
    { timeout: 12000 },
  )
  if (!settledChatRaw) {
    throw new Error('SC-15: chat card should be settled to error+retryDisabledReason in IDB after reload')
  }

  // SC-15: canvas slot failed（用 IDB 断言）
  const settledCanvasRaw = await waitForPersistedKv(
    page,
    'mivo-canvas-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const canvases = parsed?.state?.canvases ?? {}
        return Object.values(canvases).some((c) =>
          (c.nodes || []).some((n) => n.type === 'ai-slot' && n.aiWorkflow?.status === 'failed'),
        )
      } catch { return false }
    },
    { timeout: 12000 },
  )
  if (!settledCanvasRaw) {
    throw new Error('SC-15: canvas slot should be settled to failed in IDB after reload')
  }
}
