import { doneTaskView } from '../api-mocks.mjs'

// scripts/e2e/scenarios/anchor-mvp.mjs
// P2-D2 — Anchor MVP DOM closed-loop (roadmap §7 组 D). Mock upstream; verify the
// 「point/box + instruction → generate → tracked」paradigm end-to-end.
//
// Assertions:
//  ① anchor created (store action) → overlay mark visible
//  ② select anchor (window hook) → instruction input appears
//  ③ fill instruction → Generate (window hook) → result node appears
//  ④ mock-captured prompt includes the instruction (+ geometry context)
//  ⑤ anchor.resultNodeIds[0] === derivation edge.to === result node id (三者一致)
//  ⑥ snapshot roundtrip preserves experimentalAnchors (deep equal)
//
// Anchor creation + selection + generate are driven via store/window hooks, not
// real mark/button clicks: the mark is 10px + the canvas pointer-down races the
// click + the floating panel is off-screen-prone (Playwright hit-test unstable).
// The hooks call the same React closures (ref-backed), so this validates the data
// flow. P3-0 (interaction dispatch) lands → switch back to real clicks.

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

export const runAnchorMvpScenario = async (context) => {
  const { baseUrl, page, generatedImageB64 } = context

  const spec = await resolveCanvasStoreSpec(page)

  // Mock generate + edit, capturing the prompt (the default page mocks don't capture).
  // /edit is multipart — parse via new Request(postDataBuffer).formData() (mirrors the
  // existing /edit mock); /generate is JSON.
  let anchorGeneratePrompt = null
  const captureAndFulfill = async (route) => {
    const req = route.request()
    const method = req.method()
    const url = req.url()
    if (method === 'POST' && url.includes('/api/mivo/tasks/generate')) {
      try { anchorGeneratePrompt = req.postDataJSON()?.prompt || null } catch { anchorGeneratePrompt = null }
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'POST' && url.includes('/api/mivo/tasks/edit')) {
      try {
        const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', {
          method: 'POST',
          headers: req.headers(),
          body: req.postDataBuffer(),
        })
        const formData = await formRequest.formData()
        anchorGeneratePrompt = String(formData.get('prompt') || '')
      } catch {
        anchorGeneratePrompt = null
      }
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
      return
    }
    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doneTaskView([{ b64: generatedImageB64 }])) })
      return
    }
    if (method === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
      return
    }
    await route.continue()
  }
  await page.route('**/api/mivo/tasks/**', captureAndFulfill)

  // Select an image node so the overlay + generate can target it.
  const anchorImageNodeId = await page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    const state = useCanvasStore.getState()
    const image = state.nodes.find((n) => n.type === 'image' && !n.hidden)
    return image?.id || null
  }, spec)
  if (!anchorImageNodeId) throw new Error('Anchor MVP: no image node to anchor onto')
  await page.locator(`[data-node-id="${anchorImageNodeId}"]`).click()

  // ① Create a point anchor via the store action (debug entry — real canvas tool
  //    integration deferred per the task's allowance). The mark overlay then renders.
  await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const node = useCanvasStore.getState().nodes.find((n) => n.id === moduleSpecAndId.id)
    if (!node) throw new Error('anchor target node missing')
    useCanvasStore.getState().addAnchor(moduleSpecAndId.id, {
      type: 'point',
      targetNodeId: moduleSpecAndId.id,
      x: Math.round(node.x + node.width * 0.5),
      y: Math.round(node.y + node.height * 0.5),
      instruction: '',
    })
  }, { spec, id: anchorImageNodeId })
  await page.waitForSelector('.anchor-mark', { timeout: 2000 })
  const anchorMarkCount = await page.locator('.anchor-mark').count()
  if (anchorMarkCount === 0) throw new Error('Anchor MVP: anchor mark overlay should be visible after add')

  // ② Select the anchor via the dev hook → instruction panel renders.
  const anchorId = await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const node = useCanvasStore.getState().nodes.find((n) => n.id === moduleSpecAndId.id)
    return node?.experimentalAnchors?.[0]?.id || null
  }, { spec, id: anchorImageNodeId })
  if (!anchorId) throw new Error('Anchor MVP: created anchor should have an id')
  await page.evaluate((id) => {
    const setter = window.__setSelectedAnchorId
    if (setter) setter(id)
  }, anchorId)
  await page.waitForSelector('[data-testid="anchor-instruction-input"]', { state: 'attached', timeout: 2000 })

  // ③ Type instruction + generate (via the dev hook — button is off-screen-prone).
  await page.locator('[data-testid="anchor-instruction-input"]').fill('make it neon', { force: true })
  await new Promise((r) => setTimeout(r, 100)) // let React state settle
  const beforeAnchorNodeCount = await page.locator('.dom-node').count()
  await page.evaluate(() => {
    const fn = window.__anchorGenerate
    if (fn) void fn()
  })
  await page.waitForFunction((c) => document.querySelectorAll('.dom-node').length >= c + 1, beforeAnchorNodeCount)

  // ④ Request prompt includes the instruction (+ geometry context).
  if (!anchorGeneratePrompt || !anchorGeneratePrompt.includes('make it neon')) {
    throw new Error(`Anchor MVP: generate prompt should include instruction, got: ${JSON.stringify(anchorGeneratePrompt)}`)
  }

  // ⑤ anchor.resultNodeIds + derivation edge point consistently.
  const anchorState = await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const state = useCanvasStore.getState()
    const node = state.nodes.find((n) => n.id === moduleSpecAndId.id)
    const anchor = node?.experimentalAnchors?.[0]
    const resultNodeId = anchor?.resultNodeIds?.[0]
    const resultNode = state.nodes.find((n) => n.id === resultNodeId)
    const edge = state.edges.find((e) => e.from === moduleSpecAndId.id && e.to === resultNodeId)
    return {
      hasResultNodeIds: Boolean(anchor?.resultNodeIds?.length),
      resultNodeId,
      resultNodeExists: Boolean(resultNode),
      edgeExists: Boolean(edge),
      edgeTo: edge?.to,
    }
  }, { spec, id: anchorImageNodeId })
  if (!anchorState.hasResultNodeIds) throw new Error('Anchor MVP: anchor.resultNodeIds should be recorded after generate')
  if (!anchorState.resultNodeExists) throw new Error('Anchor MVP: result node should exist for the recorded id')
  if (!anchorState.edgeExists) throw new Error('Anchor MVP: derivation edge should exist from source to result')
  if (anchorState.edgeTo !== anchorState.resultNodeId) {
    throw new Error(`Anchor MVP: edge.to (${anchorState.edgeTo}) should match anchor.resultNodeIds[0] (${anchorState.resultNodeId})`)
  }

  // ⑥ Snapshot roundtrip preserves experimentalAnchors (UI-produced data, deep equal).
  const anchorRoundtripOk = await page.evaluate(async (moduleSpecAndId) => {
    const { useCanvasStore } = await import(moduleSpecAndId.spec)
    const store = useCanvasStore.getState()
    const before = store.getSnapshot()
    store.replaceSnapshot(JSON.parse(JSON.stringify(before)))
    const after = useCanvasStore.getState().getSnapshot()
    const beforeAnchors = before.nodes.find((n) => n.id === moduleSpecAndId.id)?.experimentalAnchors
    const afterAnchors = after.nodes.find((n) => n.id === moduleSpecAndId.id)?.experimentalAnchors
    return JSON.stringify(beforeAnchors) === JSON.stringify(afterAnchors)
  }, { spec, id: anchorImageNodeId })
  if (!anchorRoundtripOk) throw new Error('Anchor MVP: experimentalAnchors should survive snapshot roundtrip (deep equal)')

  await page.unroute('**/api/mivo/tasks/**', captureAndFulfill)
}
