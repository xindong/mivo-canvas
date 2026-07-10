// scripts/e2e/scenarios/mask-cross-scene.mjs
// SC-11: 跨场景完成/失败仍在当前 scene 追加 origin:'mask-edit' notice
//  done 分支：
//    - scene A (character-flow) 提交 mask edit（gated /enhance + /tasks/edit + /tasks/* GET 挂起）
//    - 提交后切 scene B (variants)
//    - release /tasks/* GET → done
//    - 断言 scene B 的 messagesByScene[IDB] 出现 origin:'mask-edit' notice 文本含「结果已生成到画布」
//    - 切回 scene A，断言 assistant card status='done' + resultNodeIds 非空 + .chat-result-image 可定位
//  failed 分支：
//    - 另一次提交，release GET → failedTaskView
//    - 切 scene B 后断言 notice 文本含「局部重绘失败」
//    - 切回 scene A 断言 assistant status='error'
//
// #90 IDB harness: 用 waitForPersistedKv 读 persisted chat state，禁止 localStorage 断言。

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

// 读取当前 scene 的最后一条 mask-edit assistant 消息状态。
const readLastMaskEditAssistant = async (page, chatStoreSpec) => {
  const spec = await chatStoreSpec()
  return page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.origin === 'mask-edit')
    return last
      ? { id: last.id, status: last.status, resultNodeIds: last.resultNodeIds || [], error: last.error, errorKind: last.errorKind }
      : null
  }, spec)
}

const waitForCondition = async (fn, { timeout = 8000, interval = 50 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
}

export const runMaskCrossSceneScenario = async (context) => {
  const { canvasStoreSpec, chatStoreSpec, generatedImageB64, page, rendererMode, waitForPersistedKv } = context

  const resetCharacterFlow = async () => {
    await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().loadScene('character-flow')
      useCanvasStore.getState().resetCurrentScene()
    }, await canvasStoreSpec())
    await waitForNodeRendered(page, rendererMode, 'ref-hero')
  }

  const switchScene = async (sceneId) => {
    await page.evaluate(async ({ moduleSpec, target }) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().loadScene(target)
    }, { moduleSpec: await canvasStoreSpec(), target: sceneId })
  }

  // ── SC-11 done 分支 ──
  await resetCharacterFlow()

  // enhance 返回 generate mode（不 gate，快速返回）
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e cross-scene',
        richPrompt: 'E2E cross-scene rich prompt',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // /tasks/edit POST → taskId；用计数器确认提交
  let crossEditPostCount = 0
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    crossEditPostCount += 1
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-cross-done' }) })
  })

  // /tasks/* GET：返 running 直到 release 后返 done；DELETE 返 canceled。
  // 用 running→done 替代 gate 挂起：pollTimeoutMs=15s，gate 挂起会导致 GET 超时。
  let crossDoneGetReleased = false
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    if (!crossDoneGetReleased) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'task-cross-done', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-cross', model: 'gpt-image-2' }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
  })

  // 提交 mask edit
  await openMaskEditorOn(page, rendererMode, 'ref-hero')
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await fillMaskPrompt(page, 'E2E cross-scene done mask')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)

  // 等 /tasks/edit POST 落地（确认任务已提交，切场景前 task 已在上游）
  await waitForCondition(() => crossEditPostCount >= 1, { timeout: 5000 })
  if (crossEditPostCount < 1) {
    throw new Error('SC-11: /tasks/edit POST should have fired before scene switch')
  }

  // 切 scene B (variants) —— 此时 finishMaskEditMessage 的 currentSceneId === 'variants'
  await switchScene('variants')

  // release GET → done
  crossDoneGetReleased = true

  // SC-11: 断言 scene B (variants) 出现 origin:'mask-edit' notice 文本含「结果已生成到画布」
  const doneNoticeRaw = await waitForPersistedKv(
    page,
    'mivo-chat-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const byScene = parsed?.state?.messagesByScene ?? {}
        const variantsMessages = byScene['variants'] || []
        return variantsMessages.some(
          (m) => m.kind === 'notice' && m.origin === 'mask-edit' && (m.text || m.prompt || '').includes('结果已生成到画布'),
        )
      } catch { return false }
    },
    { timeout: 8000 },
  )
  if (!doneNoticeRaw) {
    throw new Error('SC-11: cross-scene done should append mask-edit notice with "结果已生成到画布" to variants scene')
  }

  // 切回 scene A (character-flow)
  await switchScene('character-flow')
  await waitForNodeRendered(page, rendererMode, 'ref-hero')
  await ensureChatPanelOpen(page)

  // SC-11: assistant card status='done' + resultNodeIds + .chat-result-image
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 8000 })
  const doneState = await readLastMaskEditAssistant(page, chatStoreSpec)
  if (!doneState || doneState.status !== 'done') {
    throw new Error(`SC-11: cross-scene done — assistant should be done after switching back, got: ${JSON.stringify(doneState)}`)
  }
  if (!doneState.resultNodeIds || doneState.resultNodeIds.length === 0) {
    throw new Error(`SC-11: cross-scene done — assistant should carry resultNodeIds, got: ${JSON.stringify(doneState)}`)
  }

  // ── SC-11 failed 分支 ──
  await resetCharacterFlow()

  // 重置 /tasks/edit POST 计数 + /tasks/* GET：running → failedTaskView
  let crossFailEditPostCount = 0
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    crossFailEditPostCount += 1
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-cross-fail' }) })
  })

  let crossFailGetReleased = false
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    if (!crossFailGetReleased) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'task-cross-fail', kind: 'edit', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-cross-fail', model: 'gpt-image-2' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(failedTaskView('cross-scene upstream 500', { status: 'failed', progress: 50 })),
    })
  })

  // 提交 mask edit
  await openMaskEditorOn(page, rendererMode, 'ref-hero')
  await drawPointRegion(page)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
  await fillMaskPrompt(page, 'E2E cross-scene failed mask')
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)

  // 等 /tasks/edit POST 落地
  await waitForCondition(() => crossFailEditPostCount >= 1, { timeout: 5000 })

  // 切 scene B (variants)
  await switchScene('variants')

  // release GET → failed
  crossFailGetReleased = true

  // SC-11: 断言 scene B 出现 notice 文本含「局部重绘失败」
  const failNoticeRaw = await waitForPersistedKv(
    page,
    'mivo-chat-demo',
    (raw) => {
      try {
        const parsed = JSON.parse(raw)
        const byScene = parsed?.state?.messagesByScene ?? {}
        const variantsMessages = byScene['variants'] || []
        return variantsMessages.some(
          (m) => m.kind === 'notice' && m.origin === 'mask-edit' && (m.text || m.prompt || '').includes('局部重绘失败'),
        )
      } catch { return false }
    },
    { timeout: 8000 },
  )
  if (!failNoticeRaw) {
    throw new Error('SC-11: cross-scene failed should append mask-edit notice with "局部重绘失败" to variants scene')
  }

  // 切回 scene A
  await switchScene('character-flow')
  await waitForNodeRendered(page, rendererMode, 'ref-hero')
  await ensureChatPanelOpen(page)

  // SC-11: assistant status='error'
  let failState = null
  const failDeadline = Date.now() + 10000
  while (Date.now() < failDeadline) {
    failState = await readLastMaskEditAssistant(page, chatStoreSpec)
    if (failState && failState.status === 'error') break
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!failState || failState.status !== 'error') {
    throw new Error(`SC-11: cross-scene failed — assistant should be error after switching back, got: ${JSON.stringify(failState)}`)
  }
}
