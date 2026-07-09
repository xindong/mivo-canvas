// scripts/e2e/scenarios/mask-blackblock.mjs
// 黑块修复防回归主场景（二次重绘黑色色块）：
//  BB-1 自愈成功：第一次 /tasks/edit 返"区域外大黑圆"结果 → 检出（旧 W1 只查 mask 区必漏）
//       → 新 Idempotency-Key 重试；第二次 clean → 最终 card done + resultNodeIds，
//       结果节点带 generation.maskBounds + maskSourceSize（历史洞区元数据）。
//  BB-2 自愈失败不 commit：两次都返全黑 → 卡片 error（"局部重绘结果异常"）、无新增
//       image node、placeholder 已移除 —— 宁可失败不落坏图。
//  BB-3 迭代重绘断言（N=5）：mock clean（带透明区）结果后，对 resultNodeId 连续 5 次
//       "上轮结果作下轮源"mask edit；每轮 /tasks/edit 的 multipart image 解码断言为
//       opaque canonical PNG（alphaLt255=0）；每轮返回图全图跑
//       inspectMaskResultForBlackArtifacts 断言 false；每轮落库结果资产解码断言无大黑
//       连通域（黑盘不得进 resultNodeIds）。
//
// #90 IDB harness：断言走 zustand store / route 捕获，不碰 localStorage。

import pngjs from 'pngjs'
import { clickCanvasNode, waitForNodeRendered } from '../renderer-evidence.mjs'

const { PNG } = pngjs

const REJECT_MESSAGE = '局部重绘结果异常，请重新选择区域或换源图后重试。'

// contentEditable 富文本编辑器输入(对齐 mask.mjs fillMaskPrompt):prompt 输入区自
// 253bd42 起从 <textarea> 改为 contentEditable .image-mask-edit-editor,旧的
// '.image-mask-edit-prompt textarea' 选择器失效(fill 必 30s 超时)。内联避免改共享文件。
const fillMaskPrompt = async (page, text) => {
  const editor = page.locator('.image-mask-edit-prompt .image-mask-edit-editor')
  await editor.click()
  await page.evaluate((t) => { document.execCommand('insertText', false, t) }, text)
}

// ── 通用小工具 ──────────────────────────────────────────────────────────────

const waitForCondition = async (fn, { timeout = 10000, interval = 50, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const ensureChatPanelOpen = async (page) => {
  if (await page.locator('.ai-panel.collapsed').isVisible()) {
    await page.getByRole('button', { name: 'Open AI panel' }).click()
    await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
  }
  await page.waitForSelector('.ai-panel-header')
}

// 结果节点落在源图右侧，可能被展开的 chat panel 遮挡（拦截 click）。开编辑器前收起。
const ensureChatPanelCollapsed = async (page) => {
  if (await page.locator('.ai-panel.chat-panel-expanded').isVisible()) {
    await page.getByRole('button', { name: 'Collapse AI panel' }).click()
    await page.waitForSelector('.ai-panel.collapsed', { state: 'visible' })
  }
}

const readLastAssistantState = async (page, chatStoreSpec) => {
  const spec = await chatStoreSpec()
  return page.evaluate(async (moduleSpec) => {
    const { useChatStore } = await import(moduleSpec)
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const sceneId = useCanvasStore.getState().sceneId
    const messages = useChatStore.getState().messagesByScene[sceneId] || []
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    return last
      ? { id: last.id, status: last.status, origin: last.origin, resultNodeIds: last.resultNodeIds || [], error: last.error, errorKind: last.errorKind }
      : null
  }, spec)
}

const waitForAssistantTerminal = async (page, chatStoreSpec, { timeout = 15000 } = {}) => {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await readLastAssistantState(page, chatStoreSpec)
    if (last && (last.status === 'done' || last.status === 'error')) return last
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for assistant terminal state, last=${JSON.stringify(last)}`)
}

// Node 侧解码 multipart /tasks/edit 请求 → { prompt, image: {name,type,base64} }。
const parseEditRequest = async (route) => {
  const request = route.request()
  const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', {
    method: 'POST',
    headers: request.headers(),
    body: request.postDataBuffer(),
  })
  const formData = await formRequest.formData()
  const image = formData.get('image')
  let imageEntry = null
  if (image && typeof image.arrayBuffer === 'function') {
    const buffer = Buffer.from(await image.arrayBuffer())
    imageEntry = { name: image.name || '', type: image.type || '', base64: buffer.toString('base64') }
  }
  return {
    prompt: String(formData.get('prompt') || ''),
    idempotencyKey: request.headers()['idempotency-key'] || '',
    image: imageEntry,
  }
}

// PNG alpha<255 像素计数（BB-3 归一断言核心）。
const countPngAlphaLt255 = (base64) => {
  const png = PNG.sync.read(Buffer.from(base64, 'base64'))
  let alphaLt255 = 0
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] < 255) alphaLt255++
  }
  return { alphaLt255, width: png.width, height: png.height }
}

export const runMaskBlackblockScenario = async (context) => {
  const { page, canvasStoreSpec, chatStoreSpec, rendererMode } = context
  const spec = await canvasStoreSpec()

  // ── 浏览器侧合成测试图（raw b64，无 data: 前缀 —— 检测器 atob 直接可解） ──
  const synth = await page.evaluate(() => {
    const makeCanvas = (size) => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      return canvas
    }
    // ① 区域外大黑圆：白底 1024 + 黑圆 (176,176) r=100 —— 远离中心 mask 区
    const outOfMask = makeCanvas(1024)
    {
      const ctx = outOfMask.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 1024, 1024)
      ctx.fillStyle = '#000000'
      ctx.beginPath()
      ctx.arc(176, 176, 100, 0, Math.PI * 2)
      ctx.fill()
    }
    // ② 全黑 1024（两次全黑 → reject）
    const allBlack = makeCanvas(1024)
    {
      const ctx = allBlack.getContext('2d')
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, 1024, 1024)
    }
    // ③ clean 带透明区：亮色渐变 + 透明圆角（无近黑像素；alpha<255 像素显著存在）
    const cleanAlpha = makeCanvas(1024)
    {
      const ctx = cleanAlpha.getContext('2d')
      const gradient = ctx.createLinearGradient(0, 0, 1024, 1024)
      gradient.addColorStop(0, '#ff8a00')
      gradient.addColorStop(1, '#6957e8')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 1024, 1024)
      ctx.clearRect(0, 0, 160, 160) // 透明角 —— result 源二次编辑若不归一必带 alpha
    }
    // ④ 已知底色（蓝 + 黄块）的 1600x900 PNG 源图 —— 必须 PNG：检测器 createImageBitmap
    // 解码源图做"源本黑"判定，SVG blob 在 Chromium 不可 createImageBitmap（会保守放行）。
    const sourcePng = document.createElement('canvas')
    sourcePng.width = 1600
    sourcePng.height = 900
    {
      const ctx = sourcePng.getContext('2d')
      ctx.fillStyle = '#2767c8'
      ctx.fillRect(0, 0, 1600, 900)
      ctx.fillStyle = '#ffd35a'
      ctx.fillRect(520, 260, 560, 320)
    }
    const toB64 = (canvas) => canvas.toDataURL('image/png').split(',')[1]
    return {
      outOfMaskB64: toB64(outOfMask),
      allBlackB64: toB64(allBlack),
      cleanAlphaB64: toB64(cleanAlpha),
      sourcePngDataUrl: sourcePng.toDataURL('image/png'),
    }
  })

  // ── 公共 mock：enhance 快速返回 generate mode ──
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mode: 'generate', scene: 'general', reasoning: 'e2e blackblock', richPrompt: 'e2e blackblock rich prompt', imgRatio: '1:1', quality: 'medium', enhanced: true }),
    })
  })

  // ── 公共画布/编辑器操作 ──
  const resetScene = async () => {
    await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().loadScene('character-flow')
      useCanvasStore.getState().resetCurrentScene()
    }, spec)
    await waitForNodeRendered(page, rendererMode, 'ref-hero')
  }

  // 已知底色（蓝 + 黄块）的 1600x900 PNG 源图 —— 检测器"源本黑"判定不受 demo 资产
  // 像素干扰，且 PNG 可被 createImageBitmap 解码（SVG 不行）。
  const addKnownSource = async () => {
    return page.evaluate(async ({ moduleSpec, assetUrl }) => {
      const { useCanvasStore } = await import(moduleSpec)
      useCanvasStore.getState().addImportedImage(assetUrl, 'E2E blackblock source', 'source', { x: -280, y: 260 }, {
        dimensions: { width: 1600, height: 900 },
        mimeType: 'image/png',
        originalName: 'e2e-blackblock-source.png',
      })
      return useCanvasStore.getState().selectedNodeId
    }, { moduleSpec: spec, assetUrl: synth.sourcePngDataUrl })
  }

  // BB-3 迭代目标（result 节点）默认落在源图右侧、可能超出视口。viewport 是组件内
  // 状态（无 store 动作可平移），改为把目标节点挪回已验证可点的画布坐标 (-280,260)，
  // 其余 image 节点停到远处避免同点堆叠抢 click。
  const stageNodeForEditing = async (targetId) => {
    await page.evaluate(async ({ moduleSpec, targetId }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const state = useCanvasStore.getState()
      let parkY = -600
      for (const node of state.nodes) {
        if (node.type !== 'image' || node.hidden || node.id === targetId) continue
        parkY += 700
        state.updateNodePosition(node.id, 3600, parkY)
      }
      state.updateNodePosition(targetId, -280, 260)
    }, { moduleSpec: spec, targetId })
    await waitForNodeRendered(page, rendererMode, targetId)
  }

  const openMaskEditorOn = async (nodeId) => {
    await ensureChatPanelCollapsed(page)
    await clickCanvasNode(page, rendererMode, nodeId)
    await page.waitForSelector('.selection-quick-toolbar')
    await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
    await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
    await page.waitForSelector('.image-mask-edit-stage')
    await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '点选', exact: true }).click()
  }

  const submitMaskEdit = async (nodeId, prompt) => {
    await openMaskEditorOn(nodeId)
    const stage = await page.locator('.image-mask-edit-stage').boundingBox()
    if (!stage) throw new Error('Mask edit stage should be visible')
    await page.mouse.click(stage.x + stage.width * 0.52, stage.y + stage.height * 0.5)
    await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
    await fillMaskPrompt(page, prompt)
    await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
    await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
    await ensureChatPanelOpen(page)
  }

  const countImages = async () => {
    return page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      const state = useCanvasStore.getState()
      return {
        images: state.nodes.filter((n) => n.type === 'image' && !n.hidden).length,
        slots: state.nodes.filter((n) => n.type === 'ai-slot' && !n.hidden).length,
      }
    }, spec)
  }

  // 落库结果像素断言：解码 resultNode 的存储资产，全图找近黑连通组件（黑盘不得进画布）。
  const assertCommittedResultHasNoBlackComponents = async (nodeId, label) => {
    const verdict = await page.evaluate(async ({ moduleSpec, nodeId }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
      if (!node?.assetUrl) return { error: `node/assetUrl missing for ${nodeId}` }
      const { readImportedAssetFile } = await import('/src/lib/assetStorage.ts')
      const asset = await readImportedAssetFile(node.assetUrl)
      if (!asset) return { error: `asset not readable: ${node.assetUrl}` }
      const bitmap = await createImageBitmap(asset.blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return { error: 'no 2d context' }
      ctx.drawImage(bitmap, 0, 0)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const { findNearBlackComponents } = await import('/src/lib/maskResultInspection.ts')
      const components = findNearBlackComponents(imageData.data, { width: canvas.width, height: canvas.height })
      return { components: components.length, width: canvas.width, height: canvas.height }
    }, { moduleSpec: spec, nodeId })
    if (verdict.error) throw new Error(`${label}: committed-result pixel check failed: ${verdict.error}`)
    if (verdict.components !== 0) {
      throw new Error(`${label}: committed result must not contain black components, got ${verdict.components} (${verdict.width}x${verdict.height})`)
    }
    return verdict
  }

  // ═══ BB-1 自愈成功：区域外黑块检出 → 换 key 重试 → done ═══════════════════
  {
    await resetScene()
    const sourceNodeId = await addKnownSource()
    if (!sourceNodeId) throw new Error('BB-1: failed to add known source image')

    const editRequests = []
    await page.unroute('**/api/mivo/tasks/edit')
    await page.route('**/api/mivo/tasks/edit', async (route) => {
      const entry = await parseEditRequest(route).catch((error) => ({ prompt: '', idempotencyKey: '', image: null, parseError: String(error) }))
      editRequests.push(entry)
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: `task-bb1-${editRequests.length}` }) })
    })
    let getCalls = 0
    await page.unroute('**/api/mivo/tasks/*')
    await page.route('**/api/mivo/tasks/*', async (route) => {
      const method = route.request().method()
      if (method === 'DELETE') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) }); return }
      if (method !== 'GET') { await route.fallback(); return }
      getCalls += 1
      const taskId = `task-bb1-${Math.min(editRequests.length, 2)}`
      // 第一个 task 的 GET 返区域外黑块；重试 task 的 GET 返 clean
      const b64 = editRequests.length <= 1 ? synth.outOfMaskB64 : synth.cleanAlphaB64
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: taskId, kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-bb1', model: 'gpt-image-2', result: { images: [{ b64 }] } }),
      })
    })

    const before = await countImages()
    await submitMaskEdit(sourceNodeId, 'BB-1 out-of-mask black then clean')

    // 两次 /tasks/edit，不同 Idempotency-Key（BFF 按 key dedupe，复用会拿回缓存黑块 task）
    await waitForCondition(() => editRequests.length >= 2, { label: 'BB-1 second /tasks/edit POST' })
    if (editRequests.length !== 2) {
      await new Promise((r) => setTimeout(r, 300))
      if (editRequests.length !== 2) throw new Error(`BB-1: expected exactly 2 /tasks/edit POSTs, got ${editRequests.length}`)
    }
    if (!editRequests[0].idempotencyKey || !editRequests[1].idempotencyKey) {
      throw new Error(`BB-1: each /tasks/edit must carry Idempotency-Key, got ${JSON.stringify(editRequests.map((e) => e.idempotencyKey))}`)
    }
    if (editRequests[0].idempotencyKey === editRequests[1].idempotencyKey) {
      throw new Error(`BB-1: self-heal retry must use a NEW Idempotency-Key, got duplicate ${editRequests[0].idempotencyKey}`)
    }

    const doneState = await waitForAssistantTerminal(page, chatStoreSpec)
    if (doneState.status !== 'done' || !doneState.resultNodeIds.length) {
      throw new Error(`BB-1: assistant should be done with resultNodeIds after self-heal, got ${JSON.stringify(doneState)}`)
    }
    const after = await countImages()
    if (after.images !== before.images + 1) {
      throw new Error(`BB-1: exactly one result image should land, before=${before.images} after=${after.images}`)
    }

    // 结果节点带历史洞区元数据（maskBounds + maskSourceSize=本次源图 1600x900）
    const resultMeta = await page.evaluate(async ({ moduleSpec, nodeId }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
      return node?.generation ? { maskBounds: node.generation.maskBounds || null, maskSourceSize: node.generation.maskSourceSize || null } : null
    }, { moduleSpec: spec, nodeId: doneState.resultNodeIds[0] })
    if (!resultMeta?.maskBounds || !resultMeta?.maskSourceSize) {
      throw new Error(`BB-1: result node should carry generation.maskBounds + maskSourceSize, got ${JSON.stringify(resultMeta)}`)
    }
    if (resultMeta.maskSourceSize.width !== 1600 || resultMeta.maskSourceSize.height !== 900) {
      throw new Error(`BB-1: maskSourceSize should be the submit-time source natural size 1600x900, got ${JSON.stringify(resultMeta.maskSourceSize)}`)
    }
    // 落画布的是重试的 clean 图，不是第一次的黑块图
    await assertCommittedResultHasNoBlackComponents(doneState.resultNodeIds[0], 'BB-1')
  }

  console.log('[mask-blackblock] BB-1 passed (self-heal retry with new idempotency key → done)')

  // ═══ BB-2 自愈失败不 commit：两次全黑 → 卡片 error，无坏图落画布 ═══════════
  {
    await resetScene()
    const sourceNodeId = await addKnownSource()
    if (!sourceNodeId) throw new Error('BB-2: failed to add known source image')

    const editRequests = []
    await page.unroute('**/api/mivo/tasks/edit')
    await page.route('**/api/mivo/tasks/edit', async (route) => {
      const entry = await parseEditRequest(route).catch(() => ({ prompt: '', idempotencyKey: '', image: null }))
      editRequests.push(entry)
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: `task-bb2-${editRequests.length}` }) })
    })
    await page.unroute('**/api/mivo/tasks/*')
    await page.route('**/api/mivo/tasks/*', async (route) => {
      const method = route.request().method()
      if (method === 'DELETE') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) }); return }
      if (method !== 'GET') { await route.fallback(); return }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: `task-bb2-${Math.max(1, editRequests.length)}`, kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-bb2', model: 'gpt-image-2', result: { images: [{ b64: synth.allBlackB64 }] } }),
      })
    })

    const before = await countImages()
    await submitMaskEdit(sourceNodeId, 'BB-2 both attempts black')

    const failState = await waitForAssistantTerminal(page, chatStoreSpec)
    if (failState.status !== 'error') {
      throw new Error(`BB-2: assistant should be error after two black attempts, got ${JSON.stringify(failState)}`)
    }
    if (failState.error !== REJECT_MESSAGE) {
      throw new Error(`BB-2: error text should be ${JSON.stringify(REJECT_MESSAGE)}, got ${JSON.stringify(failState.error)}`)
    }
    if (editRequests.length !== 2) {
      throw new Error(`BB-2: should retry exactly once (2 POSTs), got ${editRequests.length}`)
    }
    const after = await countImages()
    if (after.images !== before.images) {
      throw new Error(`BB-2: black result must NOT land as an image node, before=${before.images} after=${after.images}`)
    }
    if (after.slots !== 0) {
      throw new Error(`BB-2: placeholder should be removed on reject, got ${after.slots} ai-slot(s)`)
    }
  }

  console.log('[mask-blackblock] BB-2 passed (double-black rejected, no bad image committed)')

  // ═══ BB-3 迭代重绘（N=5）：连续编辑 result 节点，submit 源恒不透明 + 结果恒无黑块 ═══
  {
    await resetScene()
    const sourceNodeId = await addKnownSource()
    if (!sourceNodeId) throw new Error('BB-3: failed to add known source image')

    const editRequests = []
    await page.unroute('**/api/mivo/tasks/edit')
    await page.route('**/api/mivo/tasks/edit', async (route) => {
      const entry = await parseEditRequest(route).catch((error) => ({ prompt: '', idempotencyKey: '', image: null, parseError: String(error) }))
      editRequests.push(entry)
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: `task-bb3-${editRequests.length}` }) })
    })
    await page.unroute('**/api/mivo/tasks/*')
    await page.route('**/api/mivo/tasks/*', async (route) => {
      const method = route.request().method()
      if (method === 'DELETE') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'canceled' }) }); return }
      if (method !== 'GET') { await route.fallback(); return }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: `task-bb3-${Math.max(1, editRequests.length)}`, kind: 'edit', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-bb3', model: 'gpt-image-2', result: { images: [{ b64: synth.cleanAlphaB64 }] } }),
      })
    })

    // 第 0 次：imported 源 → result-1（此次 submit 源是 SVG，不做 PNG 断言）
    await submitMaskEdit(sourceNodeId, 'BB-3 seed edit')
    let lastState = await waitForAssistantTerminal(page, chatStoreSpec)
    if (lastState.status !== 'done' || !lastState.resultNodeIds.length) {
      throw new Error(`BB-3: seed edit should be done, got ${JSON.stringify(lastState)}`)
    }

    // 迭代 5 次：每次对上一次的 resultNodeId 再做 mask edit（上轮结果作下轮源）
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const targetNodeId = lastState.resultNodeIds[0]
      const requestCountBefore = editRequests.length
      await stageNodeForEditing(targetNodeId)
      await submitMaskEdit(targetNodeId, `BB-3 iteration ${iteration}`)
      await waitForCondition(() => editRequests.length > requestCountBefore, { label: `BB-3 iteration ${iteration} /tasks/edit POST` })
      lastState = await waitForAssistantTerminal(page, chatStoreSpec)
      if (lastState.status !== 'done' || !lastState.resultNodeIds.length) {
        throw new Error(`BB-3 iteration ${iteration}: should be done, got ${JSON.stringify(lastState)}`)
      }

      // ①源归一断言：result 源提交的 multipart image 必须是全不透明 PNG（alphaLt255=0）。
      // mock 的 clean 结果带 160x160 透明角 —— 不归一必然出现 alpha<255。
      const submitted = editRequests[requestCountBefore]
      if (!submitted?.image) throw new Error(`BB-3 iteration ${iteration}: edit request should carry an image part`)
      if (submitted.image.type !== 'image/png') {
        throw new Error(`BB-3 iteration ${iteration}: result source should be normalized to PNG, got type=${submitted.image.type}`)
      }
      const alphaStats = countPngAlphaLt255(submitted.image.base64)
      if (alphaStats.alphaLt255 !== 0) {
        throw new Error(`BB-3 iteration ${iteration}: submitted source must be fully opaque, got alphaLt255=${alphaStats.alphaLt255} (${alphaStats.width}x${alphaStats.height})`)
      }
      console.log(`[mask-blackblock] BB-3 iteration ${iteration}: submitted image ${alphaStats.width}x${alphaStats.height} alphaLt255=${alphaStats.alphaLt255}`)

      // ②结果无黑块断言：返回图全图跑 inspectMaskResultForBlackArtifacts（source=本次提交源图）。
      const inspection = await page.evaluate(async ({ resultB64, sourceBase64, sourceWidth, sourceHeight }) => {
        const { inspectMaskResultForBlackArtifacts } = await import('/src/lib/maskResultInspection.ts')
        const bytes = Uint8Array.from(atob(sourceBase64), (c) => c.charCodeAt(0))
        const sourceBlob = new Blob([bytes], { type: 'image/png' })
        return inspectMaskResultForBlackArtifacts(
          { sourceSizePx: { width: sourceWidth, height: sourceHeight } },
          { sourceBlob, resultB64 },
        )
      }, { resultB64: synth.cleanAlphaB64, sourceBase64: submitted.image.base64, sourceWidth: alphaStats.width, sourceHeight: alphaStats.height })
      if (inspection.hasArtifact) {
        throw new Error(`BB-3 iteration ${iteration}: clean result must not flag artifacts, got ${JSON.stringify(inspection)}`)
      }
      console.log(`[mask-blackblock] BB-3 iteration ${iteration}: inspection hasArtifact=${inspection.hasArtifact} components=${inspection.components.length}`)

      // ③落库断言：本轮 resultNodeIds[0] 的存储资产无大黑连通域（黑盘不得进画布）。
      const committed = await assertCommittedResultHasNoBlackComponents(lastState.resultNodeIds[0], `BB-3 iteration ${iteration}`)
      console.log(`[mask-blackblock] BB-3 iteration ${iteration}: committed asset ${committed.width}x${committed.height} blackComponents=${committed.components}`)
    }
  }
}

