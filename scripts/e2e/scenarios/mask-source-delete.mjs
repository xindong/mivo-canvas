// scripts/e2e/scenarios/mask-source-delete.mjs
// SC-16: 提交后删除 source image → release done → 断言 placeholder 原位替换（无 edge）
//        + assistant.maskEdit.sourceDeleted === true（chat state）
//  - 提交后删除 source 不 cancel 上游任务
//  - source 已删时成功结果仍替换 placeholder，但不建 derivation edge
//  - assistant message 的 generationContext.maskEdit.sourceDeleted === true

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

export const runMaskSourceDeleteScenario = async (context) => {
  const { canvasStoreSpec, chatStoreSpec, generatedImageB64, page, rendererMode } = context

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
        reasoning: 'e2e source-delete',
        richPrompt: 'E2E source-delete rich prompt',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // /tasks/edit POST → taskId
  let sourceDeleteEditPostCount = 0
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    sourceDeleteEditPostCount += 1
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-source-delete' }) })
  })

  // /tasks/* GET：running → done（flag 控制）
  let sourceDeleteGetDone = false
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    if (!sourceDeleteGetDone) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'task-source-delete', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-source-delete', model: 'gpt-image-2' }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
  })

  // 记录 edges before
  const spec = await canvasStoreSpec()
  const edgesBefore = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().edges.map((e) => ({ ...e }))
  }, spec)

  // 提交 mask edit
  await collapseChatPanel(page)
  await openMaskEditorOn(page, rendererMode, 'ref-hero')
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await page.locator('.image-mask-edit-prompt textarea').fill('E2E source-delete mask')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })

  // 等 /tasks/edit POST 落地
  await waitForCondition(() => sourceDeleteEditPostCount >= 1, { timeout: 5000 })

  // 提交后删除 source image（不 cancel 上游任务）
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().deleteNode('ref-hero')
  }, await canvasStoreSpec())

  // release GET → done
  sourceDeleteGetDone = true

  // SC-16: 结果仍替换 placeholder（assistant done + resultNodeIds）
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })

  // 读取 chat state：assistant.maskEdit.sourceDeleted === true
  const chatSpec = await chatStoreSpec()
  const sourceDeleteState = await page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.origin === 'mask-edit')
    return last
      ? {
          id: last.id,
          status: last.status,
          resultNodeIds: last.resultNodeIds || [],
          sourceDeleted: last.generationContext?.maskEdit?.sourceDeleted,
        }
      : null
  }, chatSpec)

  if (!sourceDeleteState || sourceDeleteState.status !== 'done') {
    throw new Error(`SC-16: assistant should be done, got: ${JSON.stringify(sourceDeleteState)}`)
  }
  if (!sourceDeleteState.resultNodeIds || sourceDeleteState.resultNodeIds.length === 0) {
    throw new Error(`SC-16: assistant should carry resultNodeIds, got: ${JSON.stringify(sourceDeleteState)}`)
  }
  if (sourceDeleteState.sourceDeleted !== true) {
    throw new Error(`SC-16: assistant.maskEdit.sourceDeleted should be true, got: ${JSON.stringify(sourceDeleteState)}`)
  }

  // SC-16: 不建 derivation edge（source 已删，commit 不传 sourceNodeId/lineageSourceId）
  const edgesAfter = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().edges.map((e) => ({ ...e }))
  }, spec)
  const newEdges = edgesAfter.filter((e) => !edgesBefore.some((b) => b.id === e.id))
  if (newEdges.length !== 0) {
    throw new Error(`SC-16: should not create derivation edge when source is deleted, got new edges: ${JSON.stringify(newEdges)}`)
  }

  // SC-16: source node 不存在（已删）
  const sourceStillInCanvas = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.some((n) => n.id === 'ref-hero')
  }, spec)
  if (sourceStillInCanvas) {
    throw new Error('SC-16: source node should have been deleted')
  }
}
