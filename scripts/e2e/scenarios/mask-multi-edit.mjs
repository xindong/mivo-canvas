// scripts/e2e/scenarios/mask-multi-edit.mjs
// End-to-end coverage for one local repaint submission with three regions:
// remove one object and recolor two others on the same source image.

import pngjs from 'pngjs'
import { clickCanvasNode, waitForNodeRendered } from '../renderer-evidence.mjs'

const { PNG } = pngjs

const fillMaskPrompt = async (page, text) => {
  const editor = page.locator('.image-mask-edit-prompt .image-mask-edit-editor')
  await editor.click()
  await page.evaluate((value) => { document.execCommand('insertText', false, value) }, text)
}

const ensureChatPanelOpen = async (page) => {
  if (await page.locator('.ai-panel.collapsed').isVisible()) {
    await page.getByRole('button', { name: 'Open AI panel' }).click()
    await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
  }
  await page.waitForSelector('.ai-panel-header')
}

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
          origin: last.origin,
          resultNodeIds: last.resultNodeIds || [],
          error: last.error,
          errorKind: last.errorKind,
          text: last.text || '',
        }
      : null
  }, spec)
}

const parseJsonField = (formData, key) => {
  const raw = String(formData.get(key) || '')
  if (!raw) return undefined
  return JSON.parse(raw)
}

const fileInfo = async (formData, key) => {
  const file = formData.get(key)
  if (!file || typeof file.arrayBuffer !== 'function') return null
  const buffer = Buffer.from(await file.arrayBuffer())
  return {
    name: file.name || '',
    type: file.type || '',
    bytes: buffer.length,
    base64: buffer.toString('base64'),
  }
}

const parseEditRequest = async (route) => {
  const request = route.request()
  const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', {
    method: 'POST',
    headers: request.headers(),
    body: request.postDataBuffer(),
  })
  const formData = await formRequest.formData()
  return {
    prompt: String(formData.get('prompt') || ''),
    model: String(formData.get('model') || ''),
    quality: String(formData.get('quality') || ''),
    imgRatio: String(formData.get('imgRatio') || ''),
    maskBounds: parseJsonField(formData, 'maskBounds'),
    sourceSize: parseJsonField(formData, 'sourceSize'),
    subjects: parseJsonField(formData, 'subjects'),
    image: await fileInfo(formData, 'image'),
    mask: await fileInfo(formData, 'mask'),
    markedImage: await fileInfo(formData, 'markedImage'),
    idempotencyKey: request.headers()['idempotency-key'] || '',
  }
}

const alphaAt = (png, x, y) => {
  const index = (y * png.width + x) * 4
  return png.data[index + 3]
}

const assertMaskCoversThreeTargets = (maskBase64) => {
  const png = PNG.sync.read(Buffer.from(maskBase64, 'base64'))
  const samples = [
    { label: 'removed red circle', x: 260, y: 400 },
    { label: 'recolored blue square', x: 610, y: 400 },
    { label: 'recolored green triangle', x: 930, y: 400 },
  ]
  for (const sample of samples) {
    const alpha = alphaAt(png, sample.x, sample.y)
    if (alpha > 16) {
      throw new Error(`mask should include ${sample.label} at ${sample.x},${sample.y}; alpha=${alpha}`)
    }
  }
  for (const sample of [
    { label: 'top-left background', x: 80, y: 80 },
    { label: 'lower background', x: 600, y: 720 },
  ]) {
    const alpha = alphaAt(png, sample.x, sample.y)
    if (alpha < 240) {
      throw new Error(`mask should preserve ${sample.label} at ${sample.x},${sample.y}; alpha=${alpha}`)
    }
  }
}

const assertNearColor = (actual, expected, label, tolerance = 24) => {
  const delta = Math.max(
    Math.abs(actual.r - expected.r),
    Math.abs(actual.g - expected.g),
    Math.abs(actual.b - expected.b),
  )
  if (delta > tolerance) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} (delta=${delta})`)
  }
}

const waitForCondition = async (fn, { timeout = 10000, interval = 50, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

export const runMaskMultiEditScenario = async (context) => {
  const { canvasStoreSpec, chatStoreSpec, page, rendererMode, isProdTopology } = context
  const spec = await canvasStoreSpec()

  const fixture = await page.evaluate(() => {
    const width = 1200
    const height = 800
    const makeCanvas = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas
    }
    const paintBase = (ctx) => {
      ctx.fillStyle = '#f3f4f7'
      ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#e2e8f0'
      for (let x = 0; x <= width; x += 120) ctx.fillRect(x, 0, 2, height)
      for (let y = 0; y <= height; y += 120) ctx.fillRect(0, y, width, 2)
    }
    const paintBlueSquare = (ctx, color) => {
      ctx.fillStyle = color
      ctx.fillRect(520, 310, 180, 180)
    }
    const paintTriangle = (ctx, color) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(930, 285)
      ctx.lineTo(810, 520)
      ctx.lineTo(1050, 520)
      ctx.closePath()
      ctx.fill()
    }
    const source = makeCanvas()
    {
      const ctx = source.getContext('2d')
      paintBase(ctx)
      ctx.fillStyle = '#ef4444'
      ctx.beginPath()
      ctx.arc(260, 400, 92, 0, Math.PI * 2)
      ctx.fill()
      paintBlueSquare(ctx, '#2563eb')
      paintTriangle(ctx, '#22c55e')
    }
    const result = makeCanvas()
    {
      const ctx = result.getContext('2d')
      paintBase(ctx)
      // Red circle removed: only the background remains at the left target.
      paintBlueSquare(ctx, '#facc15')
      paintTriangle(ctx, '#8b5cf6')
    }
    return {
      sourceDataUrl: source.toDataURL('image/png'),
      resultB64: result.toDataURL('image/png').split(',')[1],
    }
  })

  await page.evaluate(async ({ moduleSpec, assetUrl }) => {
    const { useCanvasStore } = await import(moduleSpec)
    const sceneId = useCanvasStore.getState().createCanvas('E2E multi-region mask edit')
    useCanvasStore.getState().loadScene(sceneId)
    useCanvasStore.getState().addImportedImage(assetUrl, 'E2E three-object source', 'source', { x: -220, y: 180 }, {
      dimensions: { width: 1200, height: 800 },
      sourceDimensions: { width: 1200, height: 800 },
      mimeType: 'image/png',
      originalName: 'e2e-three-object-source.png',
    })
  }, { moduleSpec: spec, assetUrl: fixture.sourceDataUrl })

  const sourceNodeId = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().selectedNodeId
  }, spec)
  if (!sourceNodeId) throw new Error('mask-multi-edit: source node was not selected after import')
  await waitForNodeRendered(page, rendererMode, sourceNodeId)

  let enhanceCalls = 0
  let describeCalls = 0
  const labels = [
    [{ label: '红色圆形', scope: 'part' }],
    [{ label: '蓝色方块', scope: 'part' }],
    [{ label: '绿色三角', scope: 'part' }],
  ]
  await page.unroute('**/api/mivo/enhance')
  await page.route('**/api/mivo/enhance', async (route) => {
    enhanceCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enhanced: false, degradedReason: 'mask-edit-should-not-call-enhance' }),
    })
  })
  await page.unroute('**/api/mivo/describe-region')
  await page.route('**/api/mivo/describe-region', async (route) => {
    const candidates = labels[Math.min(describeCalls, labels.length - 1)]
    describeCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ candidates, label: candidates.at(-1)?.label || '', description: 'e2e region label' }),
    })
  })

  const composeBodies = []
  await page.unroute('**/api/mivo/compose-mask-edit')
  await page.route('**/api/mivo/compose-mask-edit', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    composeBodies.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        requirements: [
          '1.务必只去除图2中1号红圈（最左侧）范围内的红色圆形。画面中其他内容一律保留。',
          '2.将图2中2号红圈范围内的蓝色方块改成黄色。红圈范围内除蓝色方块以外的内容保持不变。',
          '3.将图2中3号红圈（最右侧）范围内的绿色三角改成紫色。其他相似内容不要误改。',
        ],
      }),
    })
  })

  const editRequests = []
  await page.unroute('**/api/mivo/tasks/edit')
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    editRequests.push(await parseEditRequest(route))
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'task-mask-multi-edit' }),
    })
  })

  let getCalls = 0
  await page.unroute('**/api/mivo/tasks/*')
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-mask-multi-edit', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') {
      await route.fallback()
      return
    }
    getCalls += 1
    const running = { id: 'task-mask-multi-edit', kind: 'edit', status: 'running', progress: 55, stage: 'poll', requestId: 'e2e-mask-multi', model: 'gemini-3-pro-image' }
    const done = { ...running, status: 'done', progress: 100, stage: 'done', result: { images: [{ b64: fixture.resultB64 }] } }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getCalls < 2 ? running : done) })
  })

  await clickCanvasNode(page, rendererMode, sourceNodeId)
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
  await page.waitForSelector('.image-mask-edit-stage')
  await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '椭圆', exact: true }).click()

  const drawEllipseRegion = async ({ cx, cy, rx, ry }) => {
    const stage = await page.locator('.image-mask-edit-stage').boundingBox()
    if (!stage) throw new Error('Mask edit stage should be visible')
    await page.mouse.move(stage.x + (cx - rx) * stage.width, stage.y + (cy - ry) * stage.height)
    await page.mouse.down()
    await page.mouse.move(stage.x + (cx + rx) * stage.width, stage.y + (cy + ry) * stage.height, { steps: 8 })
    await page.mouse.up()
  }

  await drawEllipseRegion({ cx: 260 / 1200, cy: 400 / 800, rx: 120 / 1200, ry: 120 / 800 })
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-mask-region-count') || '0') >= 1)
  await drawEllipseRegion({ cx: 610 / 1200, cy: 400 / 800, rx: 120 / 1200, ry: 120 / 800 })
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-mask-region-count') || '0') >= 2)
  await drawEllipseRegion({ cx: 930 / 1200, cy: 400 / 800, rx: 140 / 1200, ry: 150 / 800 })
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-mask-region-count') || '0') === 3)

  await waitForCondition(
    () => page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('.image-mask-edit-chip-label')).map((node) => node.textContent?.trim())
      return ['红色圆形', '蓝色方块', '绿色三角'].every((label) => labels.includes(label))
    }),
    { timeout: 5000, label: 'three recognized region chips' },
  )

  const userPrompt = '请在同一张图里完成三处局部修改：去除左侧红色圆形，把中间蓝色方块改成黄色，把右侧绿色三角改成紫色。'
  await fillMaskPrompt(page, userPrompt)
  await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()
  await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' })
  await ensureChatPanelOpen(page)
  await page.waitForSelector('.chat-message-assistant .chat-result-image', { timeout: 10000 })

  await waitForCondition(() => editRequests.length === 1, { label: 'single /tasks/edit request' })
  const editRequest = editRequests[0]
  if (enhanceCalls !== 0) throw new Error(`mask-multi-edit: /enhance should not be called, got ${enhanceCalls}`)
  if (describeCalls !== 3) throw new Error(`mask-multi-edit: expected 3 /describe-region calls, got ${describeCalls}`)
  if (composeBodies.length !== 1) throw new Error(`mask-multi-edit: expected 1 compose call, got ${composeBodies.length}`)
  if (!Array.isArray(composeBodies[0].anchors) || composeBodies[0].anchors.length !== 3) {
    throw new Error(`mask-multi-edit: compose should receive 3 anchors, got ${JSON.stringify(composeBodies[0])}`)
  }

  if (editRequest.model !== 'gemini-3-pro-image') throw new Error(`mask-multi-edit: expected gemini model, got ${editRequest.model}`)
  if (editRequest.quality !== 'high') throw new Error(`mask-multi-edit: expected high quality, got ${editRequest.quality}`)
  if (!editRequest.idempotencyKey) throw new Error('mask-multi-edit: missing Idempotency-Key')
  if (!editRequest.image || !editRequest.mask || !editRequest.markedImage) {
    throw new Error(`mask-multi-edit: expected image + mask + markedImage, got ${JSON.stringify({
      image: Boolean(editRequest.image),
      mask: Boolean(editRequest.mask),
      markedImage: Boolean(editRequest.markedImage),
    })}`)
  }
  if (editRequest.sourceSize?.width !== 1200 || editRequest.sourceSize?.height !== 800) {
    throw new Error(`mask-multi-edit: sourceSize should be 1200x800, got ${JSON.stringify(editRequest.sourceSize)}`)
  }
  if (!editRequest.maskBounds || editRequest.maskBounds.width < 700 || editRequest.maskBounds.height < 200) {
    throw new Error(`mask-multi-edit: maskBounds should cover all three objects, got ${JSON.stringify(editRequest.maskBounds)}`)
  }
  const subjectLabels = (editRequest.subjects || []).map((subject) => subject.label)
  for (const label of ['红色圆形', '蓝色方块', '绿色三角']) {
    if (!subjectLabels.includes(label)) {
      throw new Error(`mask-multi-edit: subjects should include ${label}, got ${JSON.stringify(subjectLabels)}`)
    }
  }
  for (const expected of ['图2', '1号红圈', '2号红圈', '3号红圈', '去除', '改成黄色', '改成紫色']) {
    if (!editRequest.prompt.includes(expected)) {
      throw new Error(`mask-multi-edit: prompt should include ${expected}, got ${JSON.stringify(editRequest.prompt)}`)
    }
  }
  assertMaskCoversThreeTargets(editRequest.mask.base64)

  const assistant = await readLastMaskEditAssistant(page, chatStoreSpec)
  if (!assistant || assistant.status !== 'done' || assistant.resultNodeIds.length !== 1) {
    throw new Error(`mask-multi-edit: assistant should be done with one result node, got ${JSON.stringify(assistant)}`)
  }

  // pixel-evidence(读结果图像素验证 remove/recolor)依赖浏览器侧动态 import
  // /src/lib/assetStorage.ts,仅 dev 拓扑有 Vite 服务 /src/;prod 拓扑只服务 dist/
  // 无 /src/,该 import 必失败。prod 显式 skip pixel 步骤,前置 payload/assistant/
  // 三区域断言一条不减;输出可见 skip 日志(不静默跳,遵 development-logging 哲学)。
  if (isProdTopology) {
    console.log('[mask-multi-edit] prod: pixel evidence skipped (dev-only /src import), payload+assistant assertions passed')
  } else {
    const pixelEvidence = await page.evaluate(async ({ moduleSpec, nodeId }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const node = useCanvasStore.getState().nodes.find((entry) => entry.id === nodeId)
      if (!node?.assetUrl) return { error: `result node missing assetUrl: ${nodeId}` }
      const { readImportedAssetFile } = await import('/src/lib/assetStorage.ts')
      const asset = await readImportedAssetFile(node.assetUrl)
      if (!asset) return { error: `asset not readable: ${node.assetUrl}` }
      const bitmap = await createImageBitmap(asset.blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return { error: '2d context unavailable' }
      ctx.drawImage(bitmap, 0, 0)
      const sample = (x, y) => {
        const [r, g, b, a] = Array.from(ctx.getImageData(x, y, 1, 1).data)
        return { r, g, b, a }
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        removedRedArea: sample(260, 400),
        recoloredSquare: sample(610, 400),
        recoloredTriangle: sample(930, 420),
        generation: node.generation || null,
      }
    }, { moduleSpec: spec, nodeId: assistant.resultNodeIds[0] })
    if (pixelEvidence.error) throw new Error(`mask-multi-edit: ${pixelEvidence.error}`)
    if (pixelEvidence.width !== 1200 || pixelEvidence.height !== 800) {
      throw new Error(`mask-multi-edit: result should keep 1200x800 pixels, got ${pixelEvidence.width}x${pixelEvidence.height}`)
    }
    assertNearColor(pixelEvidence.removedRedArea, { r: 243, g: 244, b: 247 }, 'removed red-circle area')
    assertNearColor(pixelEvidence.recoloredSquare, { r: 250, g: 204, b: 21 }, 'recolored square')
    assertNearColor(pixelEvidence.recoloredTriangle, { r: 139, g: 92, b: 246 }, 'recolored triangle')
    if (!pixelEvidence.generation?.maskBounds || !pixelEvidence.generation?.maskSourceSize) {
      throw new Error(`mask-multi-edit: result generation metadata should carry maskBounds + maskSourceSize, got ${JSON.stringify(pixelEvidence.generation)}`)
    }
    console.log('[mask-multi-edit] passed: one image, three regions, remove + recolor verified by request payload and result pixels')
  }
}
