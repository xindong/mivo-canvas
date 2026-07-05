// scripts/e2e/scenarios/variations-annotation.mjs
// P2-C2 — variations + annotation de-mock (SC4.1, roadmap §7 组 C). Mock the tasks
// API; verify the two de-mocked generation actions end-to-end:
//  ① variations partial (N=3, 2 success + 1 failure) → success subset committed as
//     result nodes + a visible "failed slot" ai-slot node for the failed variation
//  ② annotation area-edit → /tasks/edit carries normalized maskBounds (derived from
//     the annotation's canvas-coordinate annotationBounds) + a result node + edit edge
//
// Both actions are driven via store calls (page.evaluate + canvasStore module), not
// real button clicks: the InspectorPanel variations button + right-click annotation
// menu are off-screen-prone under Playwright (same hit-test flakiness as anchor-mvp).
// The store calls exercise the same React closures (submit → poll → commit).

import { doneTaskView } from '../api-mocks.mjs'
import { readTotalNodeCount, waitForTotalNodeCountAtLeast } from '../renderer-evidence.mjs'

const resolveCanvasStoreSpec = async (page) => {
  const spec = await page.evaluate(() => {
    const resource = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/src/store/canvasStore.ts'))
    return resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/canvasStore.ts'
  })
  return spec
}

export const runVariationsAnnotationScenario = async (context) => {
  const { page, generatedImageB64, rendererMode } = context
  // leafer 模式 image 无 DOM,节点计数走 data-total-node-count(全量口径);dom 模式保持原断言。
  const countRenderedNodes = () => (rendererMode === 'leafer' ? readTotalNodeCount(page) : page.locator('.dom-node').count())

  const spec = await resolveCanvasStoreSpec(page)

  // Single handler for /api/mivo/tasks/** — dispatches by method + task id. The
  // default page mocks (attachDefaultMivoApiMocks) are registered earlier; this
  // later registration takes precedence (Playwright matches LIFO).
  let annotationMaskBounds = null
  const handler = async (route) => {
    const req = route.request()
    const method = req.method()
    const url = req.url()

    // POST /api/mivo/tasks/variations → 202 {taskId, batchId, count}
    if (method === 'POST' && url.includes('/api/mivo/tasks/variations')) {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ taskId: 'task-var', batchId: 'b1', count: 3 }),
      })
      return
    }

    // POST /api/mivo/tasks/edit → 202 {taskId}; capture maskBounds + sourceSize to
    // verify the annotation area-edit path (BFF synthesizes the mask from these).
    if (method === 'POST' && url.includes('/api/mivo/tasks/edit')) {
      try {
        const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', {
          method: 'POST',
          headers: req.headers(),
          body: req.postDataBuffer(),
        })
        const formData = await formRequest.formData()
        annotationMaskBounds = {
          maskBounds: String(formData.get('maskBounds') || ''),
          sourceSize: String(formData.get('sourceSize') || ''),
        }
      } catch {
        annotationMaskBounds = null
      }
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ taskId: 'task-anno' }),
      })
      return
    }

    if (method === 'GET') {
      // variations task → partial (2 success + 1 failure)
      if (url.includes('/task-var')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'task-var',
            kind: 'variations',
            status: 'partial',
            progress: 100,
            stage: 'done',
            requestId: 'r-var',
            model: 'gpt-image-2',
            result: {
              images: [
                { b64: generatedImageB64, variationIndex: 0 },
                { b64: generatedImageB64, variationIndex: 1 },
              ],
            },
            failures: [{ variationIndex: 2, error: 'Upstream error (500)' }],
          }),
        })
        return
      }
      // annotation task → done (1 image)
      if (url.includes('/task-anno')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])),
        })
        return
      }
    }

    if (method === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'task-var', status: 'canceled' }),
      })
      return
    }

    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', handler)

  // Resolve the first image node on the canvas (the variations + annotation source).
  const imageId = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const state = useCanvasStore.getState()
    const image = state.nodes.find((n) => n.type === 'image' && !n.hidden)
    return image?.id || null
  }, spec)
  if (!imageId) throw new Error('variations-annotation: no image node to use as source')

  // ─── ① variations partial (2 success + 1 failure) ───────────────────────────
  const beforeVariationsCount = await countRenderedNodes()
  await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    await useCanvasStore.getState().generateVariations(moduleSpecAndId.id, [
      { prompt: 'variation one' },
      { prompt: 'variation two' },
      { prompt: 'variation three' },
    ])
  }, { spec, id: imageId })
  // 2 success result nodes + 1 failed slot = +3 nodes.
  if (rendererMode === 'leafer') {
    await waitForTotalNodeCountAtLeast(page, beforeVariationsCount + 3)
  } else {
    await page.waitForFunction(
      (c) => document.querySelectorAll('.dom-node').length >= c + 3,
      beforeVariationsCount,
    )
  }

  const variationsState = await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const state = useCanvasStore.getState()
    // Success subset = result nodes derived from the source (committed via
    // commitGenerationResult → type image, sourceNodeId set, not a failed slot).
    const successResults = state.nodes.filter(
      (n) => n.sourceNodeId === moduleSpecAndId.id && n.type !== 'ai-slot' && n.status !== 'failed',
    )
    // 失败槽位可见 = ai-slot node with status='failed' for the failed variation.
    const failedSlots = state.nodes.filter((n) => n.type === 'ai-slot' && n.status === 'failed')
    const task = state.tasks.find((t) => t.label?.startsWith('变体生成'))
    return {
      successCount: successResults.length,
      failedCount: failedSlots.length,
      taskStatus: task?.status,
      taskNodeIds: task?.nodeIds?.length ?? 0,
    }
  }, { spec, id: imageId })
  if (variationsState.successCount !== 2) {
    throw new Error(`variations: expected 2 success results, got ${variationsState.successCount}`)
  }
  if (variationsState.failedCount !== 1) {
    throw new Error(`variations: expected 1 failed slot (失败槽位可见), got ${variationsState.failedCount}`)
  }
  // partial resolves the success subset → task is 'done' carrying 2 nodeIds.
  if (variationsState.taskStatus !== 'done') {
    throw new Error(`variations: task should be done (partial resolves, not reject), got ${variationsState.taskStatus}`)
  }
  if (variationsState.taskNodeIds !== 2) {
    throw new Error(`variations: task.nodeIds should hold the 2 success ids, got ${variationsState.taskNodeIds}`)
  }

  // ─── ② annotation bounds → generation (area-edit) ──────────────────────────
  // Seed an annotation node with canvas-coordinate annotationBounds pointing at a
  // sub-region of the source image, + aiWorkflow.sourceNodeIds so the action can
  // resolve the source. Uses setState (mirrors seedCanvas) so the new field rides
  // along without a dedicated action.
  const annotationId = await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const state = useCanvasStore.getState()
    const sceneId = state.sceneId
    const doc = state.canvases[sceneId]
    if (!doc) throw new Error('annotation: active scene doc missing')
    const image = doc.nodes.find((n) => n.id === moduleSpecAndId.id)
    if (!image) throw new Error('annotation: source image missing')
    const id = `anno-e2e-${Date.now().toString(36)}`
    const annotation = {
      id,
      type: 'annotation',
      title: 'E2E annotation',
      x: image.x + 10,
      y: image.y + 10,
      width: 60,
      height: 60,
      status: 'ready',
      text: 'make the corner red',
      parentIds: [image.id],
      annotationBounds: { x: image.x + 10, y: image.y + 10, width: 60, height: 60 },
      aiWorkflow: { kind: 'annotation', sourceNodeIds: [image.id] },
    }
    const newNodes = [...doc.nodes, annotation]
    useCanvasStore.setState({
      canvases: { ...state.canvases, [sceneId]: { ...doc, nodes: newNodes } },
      nodes: newNodes,
      selectedNodeId: id,
      selectedNodeIds: [id],
    })
    return id
  }, { spec, id: imageId })

  const beforeAnnotationCount = await countRenderedNodes()
  await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    await useCanvasStore.getState().generateFromAnnotation(moduleSpecAndId.id)
  }, { spec, id: annotationId })
  // 1 result node from the edit.
  if (rendererMode === 'leafer') {
    await waitForTotalNodeCountAtLeast(page, beforeAnnotationCount + 1)
  } else {
    await page.waitForFunction(
      (c) => document.querySelectorAll('.dom-node').length >= c + 1,
      beforeAnnotationCount,
    )
  }

  // /tasks/edit carried maskBounds (normalized 0-1) + sourceSize — the BFF area-edit
  // path. Verify the normalization: the annotationBounds were a 60×60 region offset
  // 10px into the source, so normalized x/y/width/height should be 10/W, 10/H, 60/W,
  // 60/H (all in [0,1]).
  if (!annotationMaskBounds?.maskBounds) {
    throw new Error(`annotation: /tasks/edit should carry maskBounds, got ${JSON.stringify(annotationMaskBounds)}`)
  }
  const parsedBounds = JSON.parse(annotationMaskBounds.maskBounds)
  const parsedSize = JSON.parse(annotationMaskBounds.sourceSize)
  if (
    typeof parsedBounds?.x !== 'number' || typeof parsedBounds?.y !== 'number' ||
    typeof parsedBounds?.width !== 'number' || typeof parsedBounds?.height !== 'number' ||
    !parsedBounds.x || !parsedBounds.width ||
    parsedBounds.x < 0 || parsedBounds.x > 1 || parsedBounds.width <= 0 || parsedBounds.width > 1
  ) {
    throw new Error(`annotation: maskBounds should be normalized 0-1, got ${JSON.stringify(parsedBounds)}`)
  }
  if (typeof parsedSize?.width !== 'number' || typeof parsedSize?.height !== 'number') {
    throw new Error(`annotation: sourceSize should carry width/height, got ${JSON.stringify(parsedSize)}`)
  }

  const annotationState = await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const state = useCanvasStore.getState()
    // Result node from the annotation edit (type image, edit edge from the source).
    const task = state.tasks.find((t) => t.label?.startsWith('批注修图'))
    const editEdge = state.edges.find((e) => e.type === 'edit' && e.to === task?.nodeIds?.[0])
    return {
      taskStatus: task?.status,
      taskNodeIds: task?.nodeIds?.length ?? 0,
      editEdgeExists: Boolean(editEdge),
    }
  }, { spec, id: annotationId })
  if (annotationState.taskStatus !== 'done') {
    throw new Error(`annotation: task should be done, got ${annotationState.taskStatus}`)
  }
  if (annotationState.taskNodeIds !== 1) {
    throw new Error(`annotation: should commit 1 result node, got ${annotationState.taskNodeIds}`)
  }
  if (!annotationState.editEdgeExists) {
    throw new Error('annotation: an edit derivation edge should link source → result')
  }

  await page.unroute('**/api/mivo/tasks/**', handler)
}
