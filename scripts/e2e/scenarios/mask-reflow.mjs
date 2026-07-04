// scripts/e2e/scenarios/mask-reflow.mjs
// 局部重绘占位符 + 挤开（reflow）e2e（docs/ai-slot-placeholder-fix-plan.md P4）。
// submitMaskEdit 生成前在源图右侧 AI_SLOT_GAP(56) 预建 generating 占位符并
// reflowRightObstacles 挤开右侧障碍，出图后原地替换。
//
// 覆盖 SC:
//  SC4.1 对图 A 局部重绘 → A 右侧 56px 出现带 loading 动画+logo 的 generating 占位符
//  SC4.2 A 右侧原有图 B（及连锁 C）自动右移、互不重叠
//  SC4.3 出图后占位符原地替换为结果图（位置=A 右侧 56px、复用 slot id、血缘挂原图 A）
//  SC4.5 非局部重绘生成（beside）不触发挤开：右侧障碍不被推走
//
// W2 (QoL batch): mask-edit 从 sync /api/mivo/edit 迁移到 async tasks API
// (POST /tasks/edit → 202 → poll GET /tasks/:id)。用一个 gated /tasks/* GET mock
// 把 poll 挂起，以便在「预建槽 + reflow 已发生、出图前」观测 SC4.1/SC4.2；release
// 后返 done（SC4.3 原地替换）或 failed（SC5.3 回滚）。SC4.5 用默认 progressive mock，
// 故每次 gated 段结束后须 unroute + 恢复默认 /tasks/* 给后续用例。
import { doneTaskView, failedTaskView } from '../api-mocks.mjs'

// 恢复默认 progressive /tasks/* GET mock（SC4.5 beside 生成依赖它 poll 到 done）。
// 与 api-mocks.attachDefaultMivoApiMocks 的 /tasks/* 路由同形；mask-reflow 在 gated
// 段 unroute 后调用本函数重建。内联而非 import 是为避免改共享文件误伤其他 e2e。
const restoreDefaultTasksGetMock = async (page, generatedImageB64) => {
  const sequence = [
    { id: 'task-e2e', kind: 'generate', status: 'running', progress: 10, stage: 'submit', requestId: 'e2e-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'generate', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'generate', status: 'running', progress: 60, stage: 'poll', requestId: 'e2e-1', model: 'gpt-image-2' },
    { id: 'task-e2e', kind: 'generate', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-1', model: 'gpt-image-2', result: { images: [{ b64: generatedImageB64 }] } },
  ]
  let getCalls = 0
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    getCalls += 1
    const view = sequence[Math.min(getCalls - 1, sequence.length - 1)]
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) })
  })
}

// Gated /tasks/* GET mock：poll 被 gate Promise 挂起直到 release()；释放后返回 releaseView。
// POST/DELETE 走 fallback/取消，不阻塞 /tasks/edit POST（落到默认 /tasks/edit 路由）。
const attachGatedTasksGetMock = async (page, releaseView) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    if (method !== 'GET') { await route.fallback(); return }
    await gate
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(releaseView) })
  })
  return release
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
      status: node.aiWorkflow?.status,
      operation: node.aiWorkflow?.operation,
      sourceNodeId: node.sourceNodeId,
      parentIds: node.parentIds,
    }))
  }, spec)

// Poll the store until node `id` becomes `type` (see ai-slot-placeholder.mjs note).
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

const waitForGeneratingSlot = async (page, spec, { timeout = 15000 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = await page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.some((n) => n.type === 'ai-slot' && n.aiWorkflow?.status === 'generating')
    }, spec)
    if (found) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Timed out waiting for a generating ai-slot')
}

const rectOf = (n) => ({ left: n.x, top: n.y, right: n.x + n.width, bottom: n.y + n.height })
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

const createBlankCanvasWithImages = async (page, spec, images) =>
  page.evaluate(async ({ moduleSpec, images }) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().createCanvas('E2E Mask Reflow')
    // Use a real served demo asset (loads with a real naturalWidth) so the mask-edit
    // stage can map drawn regions — a 1x1 data URL yields sub-pixel/empty regions.
    const assetUrl = '/demo-assets/courage-1.jpg'
    const created = []
    for (const image of images) {
      useCanvasStore.getState().addImportedImage(assetUrl, image.title, 'source', { x: image.x, y: image.y }, {
        dimensions: { width: image.width, height: image.height },
        mimeType: 'image/jpeg',
        originalName: `${image.title}.jpg`,
      })
      const state = useCanvasStore.getState()
      const node = state.nodes[state.nodes.length - 1]
      created.push({ id: node.id, x: node.x, y: node.y, width: node.width, height: node.height })
    }
    useCanvasStore.getState().selectNode(undefined)
    return created
  }, { moduleSpec: spec, images })

// rev4: local repaint is point-select only (box/brush tools removed). Open the mask
// editor and drop one circular point region.
const openMaskPointRegion = async (page) => {
  await page.waitForSelector('.selection-quick-toolbar')
  await page.locator('.selection-quick-toolbar').getByRole('button', { name: 'AI Edit' }).click()
  await page.locator('.selection-quick-toolbar-menu').getByRole('menuitem', { name: 'Select area' }).click()
  await page.waitForSelector('.image-mask-edit-stage')
  // Point tool is the default and only tool; click it explicitly for robustness.
  await page.locator('.image-mask-edit-toolbar').getByRole('button', { name: '点选', exact: true }).click()
  const stage = await page.locator('.image-mask-edit-stage').boundingBox()
  if (!stage) throw new Error('Mask edit stage should be visible')
  await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.5)
  await page.waitForFunction(() => Number(document.querySelector('.image-mask-edit-overlay')?.getAttribute('data-region-count') || '0') > 0)
}

const countAiSlots = async (page, spec) =>
  page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.filter((n) => n.type === 'ai-slot').length
  }, spec)

const waitForNoAiSlot = async (page, spec, { timeout = 15000 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await countAiSlots(page, spec)) === 0) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Timed out waiting for ai-slot placeholder to be removed')
}

export const runMaskReflowScenario = async (context) => {
  const { page, generatedImageB64, canvasStoreSpec, nearlyEqual, wait } = context
  const spec = await canvasStoreSpec()

  // ── SC4.1 / SC4.2 / SC4.3 — mask edit on A with obstacles B, C on its right ──
  const [imgA, imgB, imgC] = await createBlankCanvasWithImages(page, spec, [
    { title: 'reflow-A', x: 0, y: 0, width: 300, height: 300 },
    { title: 'reflow-B', x: 500, y: 0, width: 300, height: 300 },
    { title: 'reflow-C', x: 900, y: 0, width: 300, height: 300 },
  ])
  await page.waitForFunction(
    async ({ moduleSpec, id }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.some((n) => n.id === id && n.type === 'image')
    },
    { moduleSpec: spec, id: imgC.id },
  )

  await page.locator(`[data-node-id="${imgA.id}"]`).click()
  await openMaskPointRegion(page)

  // submitMaskEdit → POST /tasks/edit (202) → poll GET /tasks/:id. Unroute the
  // default progressive /tasks/* mock and attach a gated one that holds the poll
  // so the prebuilt generating slot + reflow are observable before the result
  // lands; releaseEdit() lets the poll return done (SC4.3 in-place replace).
  await page.unroute('**/api/mivo/tasks/*')
  const releaseEdit = await attachGatedTasksGetMock(page, doneTaskView([{ b64: generatedImageB64 }]))

  let slotId
  try {
    await page.locator('.image-mask-edit-prompt textarea').fill('E2E reflow local repaint')
    await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()

    // Prebuilt generating slot appears at A.right + 56 (SC4.1). Held by editGate.
    await waitForGeneratingSlot(page, spec)
    const during = await readNodeGeometry(page, spec)
    const slot = during.find((n) => n.type === 'ai-slot' && n.status === 'generating')
    if (!slot) throw new Error('SC4.1: a generating ai-slot should be prebuilt for the local repaint')
    slotId = slot.id

    // SC4.1: slot at A right + 56, same top as A.
    if (!nearlyEqual(slot.x, imgA.x + imgA.width + 56, 2)) {
      throw new Error(`SC4.1: slot.x should be A.right+56 (${imgA.x + imgA.width + 56}), got ${slot.x}`)
    }
    if (!nearlyEqual(slot.y, imgA.y, 2)) {
      throw new Error(`SC4.1: slot.y should equal A.y (${imgA.y}), got ${slot.y}`)
    }
    // SC4.1: loading animation + logo present.
    const hasLogo = await page.evaluate((id) => Boolean(document.querySelector(`.dom-node[data-node-id="${id}"] .mivo-logo.ai-slot-mivo-logo`)), slotId)
    if (!hasLogo) throw new Error('SC4.1: generating placeholder should render the centered mivo logo')

    // SC4.2: B pushed to slot.right + 56, C cascaded to B.right + 56, no overlaps.
    const bAfter = during.find((n) => n.id === imgB.id)
    const cAfter = during.find((n) => n.id === imgC.id)
    if (!bAfter || !cAfter) throw new Error('SC4.2: obstacles B/C should still exist')
    if (!nearlyEqual(bAfter.x, slot.x + slot.width + 56, 2)) {
      throw new Error(`SC4.2: B should be pushed to slot.right+56 (${slot.x + slot.width + 56}), got ${bAfter.x}`)
    }
    if (!nearlyEqual(cAfter.x, bAfter.x + bAfter.width + 56, 2)) {
      throw new Error(`SC4.2: C should cascade to B.right+56 (${bAfter.x + bAfter.width + 56}), got ${cAfter.x}`)
    }
    if (overlaps(rectOf(slot), rectOf(bAfter)) || overlaps(rectOf(bAfter), rectOf(cAfter))) {
      throw new Error(`SC4.2: reflowed nodes should not overlap: ${JSON.stringify({ slot, bAfter, cAfter })}`)
    }

    // Let the edit result land → in-place replace (SC4.3).
    releaseEdit()
    await waitForNodeType(page, spec, slotId, 'image')
    const after = await readNodeGeometry(page, spec)
    const resultNode = after.find((n) => n.id === slotId)
    if (!resultNode || resultNode.type !== 'image') {
      throw new Error(`SC4.3: result should replace the slot in place (reuse id ${slotId} as image), got ${JSON.stringify(resultNode)}`)
    }
    if (!nearlyEqual(resultNode.x, imgA.x + imgA.width + 56, 2) || !nearlyEqual(resultNode.y, imgA.y, 2)) {
      throw new Error(`SC4.3: result should sit at A.right+56 / A.y (${imgA.x + imgA.width + 56},${imgA.y}), got (${resultNode.x},${resultNode.y})`)
    }
    // Lineage attaches to the real source A (not the reused slot id).
    const lineageOk = await page.evaluate(async ({ moduleSpec, resultId, sourceId }) => {
      const { useCanvasStore } = await import(moduleSpec)
      const state = useCanvasStore.getState()
      const node = state.nodes.find((n) => n.id === resultId)
      const edge = state.edges.find((e) => e.from === sourceId && e.to === resultId && e.type === 'edit')
      return {
        sourceNodeId: node?.sourceNodeId,
        parentIncludesSource: Array.isArray(node?.parentIds) && node.parentIds.includes(sourceId),
        parentIncludesSelf: Array.isArray(node?.parentIds) && node.parentIds.includes(resultId),
        edgeExists: Boolean(edge),
      }
    }, { moduleSpec: spec, resultId: slotId, sourceId: imgA.id })
    if (!lineageOk.edgeExists || lineageOk.sourceNodeId !== imgA.id || lineageOk.parentIncludesSelf) {
      throw new Error(`SC4.3: result lineage should point at source A, not itself: ${JSON.stringify(lineageOk)}`)
    }
  } finally {
    // Ensure the gate is released, the gated /tasks/* mock is removed, and the
    // default progressive /tasks/* is restored for the SC4.5 beside generation.
    releaseEdit()
    await page.unroute('**/api/mivo/tasks/*')
    await restoreDefaultTasksGetMock(page, generatedImageB64)
    await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' }).catch(() => {})
  }

  // ── SC4.5 — beside generation with a right-side obstacle must NOT push it ──
  const [besideA, besideB] = await createBlankCanvasWithImages(page, spec, [
    { title: 'beside-A', x: 0, y: 0, width: 300, height: 300 },
    { title: 'beside-B', x: 400, y: 0, width: 300, height: 300 },
  ])
  await page.waitForFunction(
    async ({ moduleSpec, id }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.some((n) => n.id === id && n.type === 'image')
    },
    { moduleSpec: spec, id: besideB.id },
  )
  const besideImagesBefore = (await readNodeGeometry(page, spec)).filter((n) => n.type === 'image').length
  // Drive the real beside-generation action (chat's non-slot path) directly — a
  // legit store-hook technique; the default /tasks/** progressive mock completes it.
  await page.evaluate(async ({ moduleSpec, id }) => {
    const { useCanvasStore } = await import(moduleSpec)
    await useCanvasStore.getState().generateBesideNode(id, 'e2e beside no-reflow', {})
  }, { moduleSpec: spec, id: besideA.id })
  {
    const deadline = Date.now() + 15000
    let ok = false
    while (Date.now() < deadline) {
      const count = await page.evaluate(async (moduleSpec) => {
        const { useCanvasStore } = await import(moduleSpec)
        return useCanvasStore.getState().nodes.filter((n) => n.type === 'image').length
      }, spec)
      if (count >= besideImagesBefore + 1) { ok = true; break }
      await wait(100)
    }
    if (!ok) throw new Error('SC4.5: beside generation should add a result image')
  }
  const besideAfter = await readNodeGeometry(page, spec)
  const bStill = besideAfter.find((n) => n.id === besideB.id)
  if (!bStill || !nearlyEqual(bStill.x, besideB.x, 2) || !nearlyEqual(bStill.y, besideB.y, 2)) {
    throw new Error(`SC4.5: beside generation must not reflow the right obstacle B (expected ${besideB.x},${besideB.y}), got ${JSON.stringify(bStill)}`)
  }
  await wait(50)

  // ── SC5.3 — 局部重绘预建槽失败 → 槽移除 且被挤开的图恢复原位（①b） ──
  const [failA, failB] = await createBlankCanvasWithImages(page, spec, [
    { title: 'fail-A', x: 0, y: 0, width: 300, height: 300 },
    { title: 'fail-B', x: 500, y: 0, width: 300, height: 300 },
  ])
  await page.waitForFunction(
    async ({ moduleSpec, id }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.some((n) => n.id === id && n.type === 'image')
    },
    { moduleSpec: spec, id: failB.id },
  )
  await page.locator(`[data-node-id="${failA.id}"]`).click()
  await openMaskPointRegion(page)

  // Gate the /tasks/:id poll, then release with a failed view so the poll loop
  // throws → submitMaskEdit's catch → removeMaskEditPlaceholder (rollback to the
  // pre-slot baseline: slot removed + reflow displacement undone). failedTaskView
  // drives failure through runMaskEditGeneration's debugLogger.error path (not
  // console.error), so the harness console-error guard isn't tripped — same pattern
  // as mask.mjs SC-W2② terminal-failure e2e.
  await page.unroute('**/api/mivo/tasks/*')
  const releaseFail = await attachGatedTasksGetMock(page, failedTaskView('mask edit e2e failure', { status: 'failed', progress: 50 }))
  try {
    await page.locator('.image-mask-edit-prompt textarea').fill('E2E mask edit failure cleanup')
    await page.locator('.image-mask-edit-prompt').getByRole('button', { name: '局部重绘' }).click()

    // While held: generating slot prebuilt + B pushed right (reflow applied).
    await waitForGeneratingSlot(page, spec)
    const held = await readNodeGeometry(page, spec)
    const failSlot = held.find((n) => n.type === 'ai-slot' && n.status === 'generating')
    const bPushed = held.find((n) => n.id === failB.id)
    if (!failSlot) throw new Error('SC5.3: generating slot should be prebuilt before failure')
    if (!bPushed || nearlyEqual(bPushed.x, failB.x, 2)) {
      throw new Error(`SC5.3: precondition — B should be pushed right while generating (from ${failB.x}), got ${bPushed?.x}`)
    }

    // Release with 500 → failure → placeholder removed + B restored.
    releaseFail()
    await waitForNoAiSlot(page, spec)
    const after = await readNodeGeometry(page, spec)
    const failedSlotLeft = after.find((n) => n.type === 'ai-slot')
    if (failedSlotLeft) throw new Error(`SC5.3: failed placeholder should be removed, got ${JSON.stringify(failedSlotLeft)}`)
    const bRestored = after.find((n) => n.id === failB.id)
    if (!bRestored || !nearlyEqual(bRestored.x, failB.x, 2) || !nearlyEqual(bRestored.y, failB.y, 2)) {
      throw new Error(`SC5.3: pushed obstacle B should return to its original position (${failB.x},${failB.y}), got ${JSON.stringify(bRestored)}`)
    }
  } finally {
    releaseFail()
    await page.unroute('**/api/mivo/tasks/*')
    await restoreDefaultTasksGetMock(page, generatedImageB64)
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForSelector('.image-mask-edit-overlay', { state: 'detached' }).catch(() => {})
  }
  await wait(50)
}
