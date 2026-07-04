// scripts/e2e/api-mocks.mjs
// P2-C1b: generation now flows through the async tasks API (POST /api/mivo/tasks/
// generate|edit → 202 {taskId} → poll GET /tasks/:id → done.result.images). The
// default mock returns a progressive progress sequence (10→30→60→done 100) so the
// chat-generation scenario can assert ≥3 increasing, non-hardcoded progress samples.
// Per-scenario overrides in chat-generation.mjs re-route /tasks/** for timeout,
// retry, scene-scoped, and cancel cases. /enhance stays (chatStore calls it directly).

const DEFAULT_TASK_ID = 'task-e2e'

// Default GET /tasks/:id progressive sequence. Non-hardcoded: distinct increasing
// samples culminating in done+result. Per-scenario overrides replace this.
const defaultProgressSequence = (generatedImageB64) => [
  { id: DEFAULT_TASK_ID, kind: 'generate', status: 'running', progress: 10, stage: 'submit', requestId: 'e2e-1', model: 'gpt-image-2' },
  { id: DEFAULT_TASK_ID, kind: 'generate', status: 'running', progress: 30, stage: 'poll', requestId: 'e2e-1', model: 'gpt-image-2' },
  { id: DEFAULT_TASK_ID, kind: 'generate', status: 'running', progress: 60, stage: 'poll', requestId: 'e2e-1', model: 'gpt-image-2' },
  { id: DEFAULT_TASK_ID, kind: 'generate', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-1', model: 'gpt-image-2', result: { images: [{ b64: generatedImageB64 }] } },
]

const editRequestEntry = (formData, parseError) => parseError
  ? { prompt: '', fileKeys: [], parseError }
  : {
      prompt: String(formData.get('prompt') || ''),
      fileKeys: ['image', 'mask', 'reference[]', 'reference']
        .map((key) => `${key}:${formData.getAll(key).length}`)
        .filter((entry) => !entry.endsWith(':0')),
    }

export const attachDefaultMivoApiMocks = async (page, { generatedImageB64, mivoEditRequests }) => {
  // /enhance — chatStore calls this directly (unchanged by C1b).
  await page.route('**/api/mivo/enhance', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'generate',
        scene: 'general',
        reasoning: 'e2e',
        richPrompt: 'e2e derived concept image',
        imgRatio: '1:1',
        quality: 'medium',
        enhanced: true,
      }),
    })
  })

  // POST /api/mivo/tasks/generate → 202 {taskId}
  await page.route('**/api/mivo/tasks/generate', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: DEFAULT_TASK_ID }),
    })
  })

  // POST /api/mivo/tasks/edit → 202 {taskId}; capture prompt/fileKeys like the old
  // /edit mock so retry-edit assertions (image:1 replay) still work.
  await page.route('**/api/mivo/tasks/edit', async (route) => {
    const request = route.request()
    try {
      const formRequest = new Request('http://127.0.0.1/api/mivo/tasks/edit', {
        method: 'POST',
        headers: request.headers(),
        body: request.postDataBuffer(),
      })
      const formData = await formRequest.formData()
      mivoEditRequests.push(editRequestEntry(formData))
    } catch (error) {
      mivoEditRequests.push(editRequestEntry(null, error instanceof Error ? error.message : 'Unable to inspect edit request'))
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: DEFAULT_TASK_ID }),
    })
  })

  // P2-C1b residual: the mask-edit path (src/canvas/MivoCanvas.tsx submitMaskEdit)
  // calls editMivoImage directly against the SYNC /api/mivo/edit route — it bypasses
  // generationSlice and is outside C1b's "5 generation actions" scope. Keep the sync
  // /edit mock so the mask e2e scenario still passes; switching mask-edit to the
  // tasks API is a follow-up (flagged in the PR description).
  await page.route('**/api/mivo/edit', async (route) => {
    const request = route.request()
    try {
      const formRequest = new Request('http://127.0.0.1/api/mivo/edit', {
        method: 'POST',
        headers: request.headers(),
        body: request.postDataBuffer(),
      })
      const formData = await formRequest.formData()
      mivoEditRequests.push(editRequestEntry(formData))
    } catch (error) {
      mivoEditRequests.push(editRequestEntry(null, error instanceof Error ? error.message : 'Unable to inspect edit request'))
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ images: [{ b64: generatedImageB64 }] }),
    })
  })

  // GET/DELETE /api/mivo/tasks/:id — default progressive → done. Per-scenario
  // overrides in chat-generation.mjs replace this route.
  const sequence = defaultProgressSequence(generatedImageB64)
  let getCalls = 0
  await page.route('**/api/mivo/tasks/*', async (route) => {
    const method = route.request().method()
    if (method === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: DEFAULT_TASK_ID, status: 'canceled' }),
      })
      return
    }
    if (method !== 'GET') {
      // W2/W3 (QoL batch): mask-edit now POSTs /tasks/edit (async) instead of the
      // sync /edit route. This catch-all must NOT continue POSTs to /tasks/edit or
      // /tasks/generate through to the real BFF (it would burn a real upstream call
      // and bypass the mivoEditRequests capture). Defer to the more-specific routes
      // registered above (L48 /tasks/generate, L58 /tasks/edit) via fallback; only
      // fall through to the network if no other route matches.
      await route.fallback()
      return
    }
    getCalls += 1
    const view = sequence[Math.min(getCalls - 1, sequence.length - 1)]
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(view),
    })
  })
}

// Helper for per-scenario GET overrides: build a failed-view payload.
export const failedTaskView = (error, { status = 'failed', progress = 50, stage = 'failed' } = {}) => ({
  id: DEFAULT_TASK_ID,
  kind: 'generate',
  status,
  progress,
  stage,
  requestId: 'e2e-1',
  model: 'gpt-image-2',
  error,
})

// Helper for per-scenario GET overrides: build a done-view payload.
export const doneTaskView = (images) => ({
  id: DEFAULT_TASK_ID,
  kind: 'generate',
  status: 'done',
  progress: 100,
  stage: 'done',
  requestId: 'e2e-1',
  model: 'gpt-image-2',
  result: { images },
})
