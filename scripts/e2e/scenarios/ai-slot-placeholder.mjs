import { doneTaskView, failedTaskView } from '../api-mocks.mjs'

// scripts/e2e/scenarios/ai-slot-placeholder.mjs
// AI Slot 占位符功能 e2e（docs/ai-slot-placeholder-fix-plan.md）。走「聊天首次生成 =
// 未选中图 → prepareChatSlot 预建/定位 ai-slot → generating 动画 → 出图原地替换」路径。
//
// 覆盖 SC:
//  SC1.1 成功后无残留空 ai-slot；结果 image 在原占位符位置（±2px）+ 复用 slot id
//  SC1.2 基线时点=预建 slot 后、出图前（image=N/ai-slot=S）；成功后 image=N+1/ai-slot=S−1
//  SC1.6 原地替换结果 image 的 parentIds 不含自身 id、sourceNodeId 不指向自身（纯聊天无自环）
//  SC2.1 generating 态：135° 渐变扫描（ai-slot-shimmer 循环）+ 居中 mivo logo
//  SC2.2 empty/generating/ready 外观可区分（三态 border/background 计算值互不相同）
//  SC2.3 logo mask 引用 /mivo-logo.svg
//  SC3.1 已有图片时占位符落在首行首列图正下方、左对齐、y=anchor.y+anchor.height+56（±2px）
//  SC3.3 空画布/无 image 走兜底不崩、不落旧对角线
//
// 画布 hit-test/异步 mock 不稳时沿用既有「store hook 驱动」手法（createCanvas /
// addImportedImage / selectNode + gated /tasks/** mock）。e2e 必须走 mock。

// Poll the store until node `id` becomes `type` (or timeout). A plain evaluate poll
// is used instead of page.waitForFunction: an async dynamic-import predicate inside
// waitForFunction was observed to resolve prematurely under this harness.
const waitForNodeType = async (page, spec, id, type, { timeout = 15000 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const matched = await page.evaluate(async ({ moduleSpec, id, type }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
      return Boolean(node) && node.type === type
    }, { moduleSpec: spec, id, type })
    if (matched) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for node ${id} to become ${type}`)
}

const readNodeGeometry = async (page, spec) =>
  page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      hidden: node.hidden,
      status: node.aiWorkflow?.status,
      operation: node.aiWorkflow?.operation,
      sourceNodeId: node.sourceNodeId,
      parentIds: node.parentIds,
    }))
  }, spec)

// A gated /tasks/** mock: POST generate → 202; GET → holds at "running" until
// release() flips the flag, then returns done+image; DELETE → canceled. Lets the
// test observe the generating DOM/state before letting the result land.
const installGatedTasksMock = async (page, generatedImageB64) => {
  const state = { released: false, generatePosts: 0, getBeforeRelease: 0 }
  const handler = async (route) => {
    const method = route.request().method()
    const url = route.request().url()
    if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
      state.generatePosts += 1
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    if (method === 'GET') {
      if (!state.released) {
        state.getBeforeRelease += 1
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'task-e2e', kind: 'generate', status: 'running', progress: 45, stage: 'poll', requestId: 'e2e-slot', model: 'gpt-image-2' }),
        })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
      return
    }
    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', handler)
  return {
    state,
    release: () => { state.released = true },
    restore: async () => { await page.unroute('**/api/mivo/tasks/**', handler) },
  }
}

// Like installGatedTasksMock, but GET holds at "running" until fail() flips it to a
// failed task view — drives generateIntoAiSlot's failure branch (rev4: slot removed).
const installFailingTasksMock = async (page) => {
  const state = { failed: false }
  const handler = async (route) => {
    const method = route.request().method()
    const url = route.request().url()
    if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    if (method === 'GET') {
      if (!state.failed) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', kind: 'generate', status: 'running', progress: 40, stage: 'poll', requestId: 'e2e-fail', model: 'gpt-image-2' }) })
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(failedTaskView('e2e injected generation failure')) })
      return
    }
    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', handler)
  return {
    fail: () => { state.failed = true },
    restore: async () => { await page.unroute('**/api/mivo/tasks/**', handler) },
  }
}

const countType = async (page, spec, type) =>
  page.evaluate(async ({ moduleSpec, type }) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.filter((n) => n.type === type).length
  }, { moduleSpec: spec, type })

const waitForAiSlotCount = async (page, spec, expected, { timeout = 15000 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await countType(page, spec, 'ai-slot')) === expected) return
    await new Promise((r) => setTimeout(r, 100))
  }
  const last = await countType(page, spec, 'ai-slot')
  throw new Error(`Timed out waiting for ai-slot count=${expected}, last=${last}`)
}

const createBlankCanvasWithImages = async (page, spec, images) =>
  page.evaluate(async ({ moduleSpec, images }) => {
    const { useCanvasStore } = await import(moduleSpec)
    const store = useCanvasStore.getState()
    const id = store.createCanvas('E2E AI Slot Placeholder')
    const created = []
    // 1x1 transparent png fixture (data URL) — cheap, deterministic dimensions come
    // from the explicit `dimensions` we pass to addImportedImage.
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    for (const image of images) {
      useCanvasStore.getState().addImportedImage(dataUrl, image.title, 'source', { x: image.x, y: image.y }, {
        dimensions: { width: image.width, height: image.height },
        mimeType: 'image/png',
        originalName: `${image.title}.png`,
      })
      // addImportedImage places the node at the requested position but may center it
      // on the pointer; read back the actual id + geometry for the just-added image.
      const state = useCanvasStore.getState()
      const node = state.nodes[state.nodes.length - 1]
      created.push({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height })
    }
    useCanvasStore.getState().selectNode(undefined)
    return { canvasId: id, images: created }
  }, { moduleSpec: spec, images })

const submitChatPrompt = async (context, text) => {
  const { page } = context
  await context.ensureChatPanelOpen()
  await page.locator('.chat-composer-textarea').fill(text)
  await page.locator('.chat-composer-textarea').press('Enter')
}

export const runAiSlotPlaceholderScenario = async (context) => {
  const { page, generatedImageB64, canvasStoreSpec, nearlyEqual, wait } = context
  const spec = await canvasStoreSpec()

  // ───────────────────────────────────────────────────────────────────────────
  // SC3.1 + SC1.1 + SC1.2 + SC1.6 + SC2.x — single anchored slot, full lifecycle.
  // Layout: one image A at (0,0) 300x300 on a blank canvas. Slot should land below A.
  // ───────────────────────────────────────────────────────────────────────────
  const setup = await createBlankCanvasWithImages(page, spec, [{ title: 'anchor-A', x: 0, y: 0, width: 300, height: 300 }])
  const anchor = setup.images[0]
  await page.waitForFunction(
    async ({ moduleSpec, id }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.some((n) => n.id === id && n.type === 'image')
    },
    { moduleSpec: spec, id: anchor.id },
  )

  const gate = await installGatedTasksMock(page, generatedImageB64)
  let slotId
  try {
    const before = await readNodeGeometry(page, spec)
    const imagesBefore = before.filter((n) => n.type === 'image').length
    const slotsBefore = before.filter((n) => n.type === 'ai-slot').length

    await submitChatPrompt(context, 'e2e ai slot placeholder anchored')

    // Wait for the generating slot to appear (prepareChatSlot creates it, then
    // generateIntoAiSlot flips it to generating before the async result).
    await page.waitForSelector('.dom-node.ai-generating[data-node-type="ai-slot"]', { timeout: 15000 })

    // ── SC1.2 baseline: measured after slot built, before out. image=N, ai-slot=S. ──
    const baseline = await readNodeGeometry(page, spec)
    const imagesBaseline = baseline.filter((n) => n.type === 'image').length
    const slotsBaseline = baseline.filter((n) => n.type === 'ai-slot').length
    if (imagesBaseline !== imagesBefore) {
      throw new Error(`SC1.2: image count at baseline should equal pre-submit N (${imagesBefore}), got ${imagesBaseline}`)
    }
    if (slotsBaseline !== slotsBefore + 1) {
      throw new Error(`SC1.2: ai-slot count at baseline should be S=prebuilt (${slotsBefore + 1}), got ${slotsBaseline}`)
    }

    const generatingSlot = baseline.find((n) => n.type === 'ai-slot' && n.status === 'generating')
    if (!generatingSlot) throw new Error('SC1/SC3: expected exactly one generating ai-slot at baseline')
    slotId = generatingSlot.id

    // ── SC3.1: slot below first-row-first-col image, left-aligned, y=anchor.bottom+56 ──
    if (!nearlyEqual(generatingSlot.x, anchor.x, 2)) {
      throw new Error(`SC3.1: slot should be left-aligned with anchor (x=${anchor.x}), got ${generatingSlot.x}`)
    }
    if (!nearlyEqual(generatingSlot.y, anchor.y + anchor.height + 56, 2)) {
      throw new Error(`SC3.1: slot y should be anchor.bottom+56 (${anchor.y + anchor.height + 56}), got ${generatingSlot.y}`)
    }

    // ── SC2.1 / SC2.3: generating shimmer + centered mivo logo referencing svg ──
    const generatingVisual = await page.evaluate((slotNodeId) => {
      const domNode = document.querySelector(`.dom-node[data-node-id="${slotNodeId}"]`)
      const slot = domNode?.querySelector('.dom-ai-slot-node')
      const logo = domNode?.querySelector('.mivo-logo.ai-slot-mivo-logo')
      const afterStyle = slot ? window.getComputedStyle(slot, '::after') : null
      const logoStyle = logo ? window.getComputedStyle(logo) : null
      const logoRect = logo?.getBoundingClientRect()
      const slotRect = slot?.getBoundingClientRect()
      return {
        hasLogo: Boolean(logo),
        animationName: afterStyle?.animationName,
        afterBackgroundImage: afterStyle?.backgroundImage,
        logoMask: logoStyle ? (logoStyle.maskImage || logoStyle.webkitMaskImage || '') : '',
        logoCenterX: logoRect ? logoRect.left + logoRect.width / 2 : null,
        logoCenterY: logoRect ? logoRect.top + logoRect.height / 2 : null,
        slotCenterX: slotRect ? slotRect.left + slotRect.width / 2 : null,
        slotCenterY: slotRect ? slotRect.top + slotRect.height / 2 : null,
      }
    }, slotId)
    if (!generatingVisual.hasLogo) throw new Error('SC2.1/SC2.3: generating slot should render a centered .mivo-logo')
    if (generatingVisual.animationName !== 'ai-slot-shimmer') {
      throw new Error(`SC2.1: generating ::after should run ai-slot-shimmer, got ${JSON.stringify(generatingVisual.animationName)}`)
    }
    if (!/linear-gradient/.test(generatingVisual.afterBackgroundImage || '') || !/135deg/.test(generatingVisual.afterBackgroundImage || '')) {
      throw new Error(`SC2.1: generating ::after should use a 135deg linear-gradient sweep, got ${JSON.stringify(generatingVisual.afterBackgroundImage)}`)
    }
    if (!/mivo-logo\.svg/.test(generatingVisual.logoMask)) {
      throw new Error(`SC2.3: logo should reference /mivo-logo.svg via mask, got ${JSON.stringify(generatingVisual.logoMask)}`)
    }
    if (
      !nearlyEqual(generatingVisual.logoCenterX, generatingVisual.slotCenterX, 4) ||
      !nearlyEqual(generatingVisual.logoCenterY, generatingVisual.slotCenterY, 4)
    ) {
      throw new Error(`SC2.1: logo should be centered in the slot, got ${JSON.stringify(generatingVisual)}`)
    }

    // Record slot geometry before release so SC1.1 can assert in-place replacement.
    const slotRectBefore = { x: generatingSlot.x, y: generatingSlot.y, width: generatingSlot.width, height: generatingSlot.height }

    // Let the result land.
    gate.release()
    await waitForNodeType(page, spec, slotId, 'image')

    const after = await readNodeGeometry(page, spec)
    const imagesAfter = after.filter((n) => n.type === 'image').length
    const slotsAfter = after.filter((n) => n.type === 'ai-slot').length

    // ── SC1.1: no leftover empty ai-slot ──
    const leftoverGenerating = after.filter((n) => n.type === 'ai-slot')
    if (leftoverGenerating.length !== slotsBefore) {
      throw new Error(`SC1.1: no leftover ai-slot expected (back to ${slotsBefore}), got ${leftoverGenerating.length}`)
    }
    // ── SC1.2: image=N+1, ai-slot=S-1 ──
    if (imagesAfter !== imagesBaseline + 1) {
      throw new Error(`SC1.2: image count should be N+1 (${imagesBaseline + 1}), got ${imagesAfter}`)
    }
    if (slotsAfter !== slotsBaseline - 1) {
      throw new Error(`SC1.2: ai-slot count should be S-1 (${slotsBaseline - 1}), got ${slotsAfter}`)
    }

    // ── SC1.1: result image reuses slot id + position (±2px) ──
    const resultNode = after.find((n) => n.id === slotId)
    if (!resultNode || resultNode.type !== 'image') {
      throw new Error(`SC1.1: result should reuse the slot id (${slotId}) as an image node, got ${JSON.stringify(resultNode)}`)
    }
    if (!nearlyEqual(resultNode.x, slotRectBefore.x, 2) || !nearlyEqual(resultNode.y, slotRectBefore.y, 2)) {
      throw new Error(`SC1.1: result should be in the original slot position (${slotRectBefore.x},${slotRectBefore.y}), got (${resultNode.x},${resultNode.y})`)
    }

    // ── SC1.6: no self-loop lineage for pure chat/ai-slot generation ──
    if (Array.isArray(resultNode.parentIds) && resultNode.parentIds.includes(slotId)) {
      throw new Error(`SC1.6: result parentIds must not include its own reused id, got ${JSON.stringify(resultNode.parentIds)}`)
    }
    if (resultNode.sourceNodeId === slotId) {
      throw new Error(`SC1.6: result sourceNodeId must not point at its own reused id (${slotId})`)
    }
    const selfEdge = await page.evaluate(async ({ moduleSpec, id }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().edges.some((edge) => edge.from === id && edge.to === id)
    }, { moduleSpec: spec, id: slotId })
    if (selfEdge) throw new Error('SC1.6: no self→self derivation edge should exist for the reused id')
  } finally {
    await gate.restore()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SC2.2 — empty/generating/ready外观可区分. Compare computed border/background of
  // the three states. Drive states via store (empty from addAiSlotNode, generating
  // + ready forced) — a legit store-hook technique per the harness convention.
  // ───────────────────────────────────────────────────────────────────────────
  const styleSetup = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const store = useCanvasStore.getState()
    store.createCanvas('E2E AI Slot States')
    const mk = (x) => useCanvasStore.getState().addAiSlotNode({ x, y: 0 }, { width: 200, height: 200 }, 'state probe')
    const emptyId = mk(0)
    const generatingId = mk(300)
    const readyId = mk(600)
    useCanvasStore.setState((current) => {
      const document = current.canvases[current.sceneId]
      const nodes = document.nodes.map((node) => {
        if (node.id === generatingId) return { ...node, aiWorkflow: { ...node.aiWorkflow, status: 'generating' } }
        if (node.id === readyId) return { ...node, aiWorkflow: { ...node.aiWorkflow, status: 'ready' } }
        return node
      })
      return { nodes, canvases: { ...current.canvases, [current.sceneId]: { ...document, nodes } } }
    })
    return { emptyId, generatingId, readyId }
  }, spec)

  const stateStyles = await page.evaluate((ids) => {
    const read = (id) => {
      const slot = document.querySelector(`.dom-node[data-node-id="${id}"] .dom-ai-slot-node`)
      if (!slot) return null
      const style = window.getComputedStyle(slot)
      return { borderColor: style.borderColor, backgroundColor: style.backgroundColor }
    }
    return { empty: read(ids.emptyId), generating: read(ids.generatingId), ready: read(ids.readyId) }
  }, styleSetup)

  if (!stateStyles.empty || !stateStyles.generating || !stateStyles.ready) {
    throw new Error(`SC2.2: could not read all three ai-slot state styles, got ${JSON.stringify(stateStyles)}`)
  }
  const signature = (s) => `${s.borderColor}|${s.backgroundColor}`
  const emptySig = signature(stateStyles.empty)
  const generatingSig = signature(stateStyles.generating)
  const readySig = signature(stateStyles.ready)
  if (emptySig === generatingSig || generatingSig === readySig || emptySig === readySig) {
    throw new Error(`SC2.2: empty/generating/ready should be visually distinct, got ${JSON.stringify(stateStyles)}`)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SC3.3 — empty canvas / no image: slot lands at fallback (viewport-center-ish),
  // NOT the removed diagonal (-160 + nodes.length*18), and nothing crashes.
  // ───────────────────────────────────────────────────────────────────────────
  await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().createCanvas('E2E AI Slot Empty Canvas')
    useCanvasStore.getState().selectNode(undefined)
  }, spec)

  const emptyGate = await installGatedTasksMock(page, generatedImageB64)
  try {
    const emptyBefore = await readNodeGeometry(page, spec)
    if (emptyBefore.some((n) => n.type === 'image')) throw new Error('SC3.3: empty-canvas precondition failed (image present)')

    await submitChatPrompt(context, 'e2e ai slot placeholder empty canvas')
    await page.waitForSelector('.dom-node.ai-generating[data-node-type="ai-slot"]', { timeout: 15000 })
    const emptyState = await readNodeGeometry(page, spec)
    const fallbackSlot = emptyState.find((n) => n.type === 'ai-slot' && n.status === 'generating')
    if (!fallbackSlot) throw new Error('SC3.3: generating slot should be created on empty canvas without crashing')
    // Fallback = centered default (−w/2, −h/2) = (−160, −160) for a 320×320 slot.
    if (!nearlyEqual(fallbackSlot.x, -160, 2) || !nearlyEqual(fallbackSlot.y, -160, 2)) {
      throw new Error(`SC3.3: empty-canvas slot should use centered fallback (−160,−160), got (${fallbackSlot.x},${fallbackSlot.y})`)
    }
    emptyGate.release()
    await waitForNodeType(page, spec, fallbackSlot.id, 'image')
  } finally {
    await emptyGate.restore()
    await wait(50)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SC5.1 — 聊天首次生图失败 → 占位符 ai-slot 移除；计数回生成前；无 failed 卡（rev4）
  // ───────────────────────────────────────────────────────────────────────────
  await createBlankCanvasWithImages(page, spec, [{ title: 'fail-anchor', x: 0, y: 0, width: 300, height: 300 }])
  const failMock = await installFailingTasksMock(page)
  try {
    const slotsBefore = await countType(page, spec, 'ai-slot')
    const imagesBefore = await countType(page, spec, 'image')

    await submitChatPrompt(context, 'e2e chat first-time failure')
    await page.waitForSelector('.dom-node.ai-generating[data-node-type="ai-slot"]', { timeout: 15000 })
    // Placeholder exists mid-flight, then fail → it should be removed.
    failMock.fail()
    await waitForAiSlotCount(page, spec, slotsBefore)

    const after = await readNodeGeometry(page, spec)
    if (after.some((n) => n.type === 'ai-slot' && (n.status === 'failed' || n.status === 'generating'))) {
      throw new Error(`SC5.1: no failed/generating ai-slot placeholder should remain, got ${JSON.stringify(after.filter((n) => n.type === 'ai-slot'))}`)
    }
    const imagesAfter = await countType(page, spec, 'image')
    if (imagesAfter !== imagesBefore) {
      throw new Error(`SC5.1: failure should not add an image (before ${imagesBefore}, after ${imagesAfter})`)
    }
  } finally {
    await failMock.restore()
    await wait(50)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SC5.2 — 生成取消 → 同样移除占位符（rev4）
  // ───────────────────────────────────────────────────────────────────────────
  await createBlankCanvasWithImages(page, spec, [{ title: 'cancel-anchor', x: 0, y: 0, width: 300, height: 300 }])
  const cancelGate = await installGatedTasksMock(page, generatedImageB64)
  try {
    const slotsBefore = await countType(page, spec, 'ai-slot')

    await submitChatPrompt(context, 'e2e chat generation cancel')
    await page.waitForSelector('.dom-node.ai-generating[data-node-type="ai-slot"]', { timeout: 15000 })

    await page.evaluate(async () => {
      const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
      const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
      const { useChatStore } = await import(moduleSpec)
      useChatStore.getState().cancelGeneration()
    })
    await waitForAiSlotCount(page, spec, slotsBefore)

    const after = await readNodeGeometry(page, spec)
    if (after.some((n) => n.type === 'ai-slot')) {
      throw new Error(`SC5.2: canceled generation should remove the placeholder, got ${JSON.stringify(after.filter((n) => n.type === 'ai-slot'))}`)
    }
  } finally {
    await cancelGate.restore()
    await wait(50)
  }
}
