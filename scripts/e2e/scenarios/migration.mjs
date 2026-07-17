import { installE2EStoreBridge, writePersistedKv } from '../harness.mjs'
import { waitForCanvasReady } from '../renderer-evidence.mjs'

export const runMigrationScenario = async (context) => {
  const { browser, canvasUrl, generatedImageB64, isProdTopology, prodExtraHTTPHeaders, rendererMode } = context

  // ③ persist v1→v2 迁移（SC-6）：独立 browser context（不挂全局 localStorage.clear），
  // 注入 v1 结构（gemini + 21:9 override + 含 generationContext.imgRatio=21:9 的旧 error 消息），
  // rehydrate 后断言 override=auto + 消息 context 已 clamp + 弹层无 21:9
  {
    const migrationContext = await browser.newContext({
      viewport: { width: 1512, height: 900 },
      deviceScaleFactor: 1,
      extraHTTPHeaders: prodExtraHTTPHeaders,
    })
    if (isProdTopology) {
      await installE2EStoreBridge(migrationContext)
    }
    // mainfix R3 把 __MIVO_E2E_ENABLED__ flag 从 installE2EStoreBridge 挪到 createSmokePage
    // (harness.mjs:599-601),让 main.tsx 在两拓扑都填 window.__MIVO_E2E__。本场景用
    // browser.newContext 自建上下文(line 19 注释:bypasses createSmokePage),flag 漏设 →
    // main.tsx 不填 bridge global → chatStore bridge module 抛 'Missing E2E store bridge:
    // useChatStore'(nightly-e2e 红灯 run 29598669120)。此处补 flag,与 createSmokePage 同源;
    // bridge 路由拦截已在 installE2EStoreBridge 装好,evaluate 动态 import chatStore.ts 在 prod
    // 走 bridge module(读 globalThis.__MIVO_E2E__.useChatStore)、dev 走 Vite 真模块——两拓扑
    // 都能验证 v1→v2 迁移(prod-relevant,不可 skip)。
    await migrationContext.addInitScript(() => { window.__MIVO_E2E_ENABLED__ = true })
    // feat/auth-sso: this custom context bypasses createSmokePage, so the harness's
    // default AutoPrompt suppression doesn't apply. Dev stub → logged-in + no keys →
    // AutoPrompt would auto-open the settings panel + intercept clicks. Suppress here.
    await migrationContext.addInitScript(() => { window.__MIVO_E2E_DISABLE_AUTO_PROMPT__ = true })
    const migrationPage = await migrationContext.newPage()
    try {
      await migrationPage.route('**/api/mivo/tasks/**', async (route) => {
        const method = route.request().method()
        if (method === 'POST') {
          await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId: 'task-e2e' }) })
          return
        }
        if (method === 'GET') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', kind: 'generate', status: 'done', progress: 100, stage: 'done', requestId: 'e2e-mig', model: 'gpt-image-2', result: { images: [{ b64: generatedImageB64 }] } }) })
          return
        }
        if (method === 'DELETE') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'task-e2e', status: 'canceled' }) })
          return
        }
        await route.continue()
      })
      await migrationPage.route('**/api/mivo/enhance', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'generate', scene: 'general', reasoning: 'e2e', richPrompt: 'e2e derived', imgRatio: '1:1', quality: 'medium', enhanced: true }) })
      })
      // 注入 v1 storage（version:1）——含 21:9 override 与一条 21:9 旧 error 消息的 generationContext
      // FU4-2: inject v1 chat state into IDB (was localStorage.setItem via
      // addInitScript). addInitScript can't await an async IDB write, so establish
      // origin first (goto loads app with empty IDB → defaults), write v1 to IDB,
      // then reload to trigger v1→v2 migration on the hydration gate.
      const v1State = {
        state: {
          messagesByScene: {
            'character-flow': [
              {
                id: 'msg-user-legacy',
                role: 'user',
                kind: 'text',
                text: 'legacy 21:9 prompt',
                createdAt: 1719900000000,
                status: 'done',
                generationContext: {
                  model: 'gemini-3-pro-image',
                  requestedImgRatio: '21:9',
                  imgRatio: '21:9',
                  quality: 'high',
                  finalPrompt: 'legacy 21:9 prompt',
                },
              },
              {
                id: 'msg-asst-legacy',
                role: 'assistant',
                kind: 'text',
                text: '',
                createdAt: 1719900000001,
                status: 'error',
                error: '上游生成超时，可降低质量重试',
                errorKind: 'upstream-timeout',
                generationContext: {
                  model: 'gemini-3-pro-image',
                  requestedImgRatio: '21:9',
                  imgRatio: '21:9',
                  quality: 'high',
                  finalPrompt: 'legacy 21:9 prompt',
                },
              },
            ],
          },
          selectedModel: 'gemini-3-pro-image',
          paramOverrides: { imgRatio: '21:9', quality: 'auto' },
        },
        version: 1,
      }
      // 默认渲染器切 leafer 后,子页面不再依赖"无参数=dom":显式携带当前矩阵的
      // renderer 参数,就绪信号复用 renderer-evidence 的按渲染器分流封装。
      await migrationPage.goto(canvasUrl, { waitUntil: 'networkidle' })
      await writePersistedKv(migrationPage, 'mivo-chat-demo', JSON.stringify(v1State))
      await migrationPage.reload({ waitUntil: 'networkidle' })
      await waitForCanvasReady(migrationPage, rendererMode, { timeout: 15000 })
      const migrated = await migrationPage.evaluate(async () => {
        const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
        const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
        const { useChatStore } = await import(moduleSpec)
        const state = useChatStore.getState()
        const legacyUser = (state.messagesByScene['character-flow'] || []).find((m) => m.id === 'msg-user-legacy')
        const legacyAsst = (state.messagesByScene['character-flow'] || []).find((m) => m.id === 'msg-asst-legacy')
        return {
          selectedModel: state.selectedModel,
          paramOverridesImgRatio: state.paramOverrides.imgRatio,
          userRequestedImgRatio: legacyUser?.generationContext?.requestedImgRatio,
          userImgRatio: legacyUser?.generationContext?.imgRatio,
          asstRequestedImgRatio: legacyAsst?.generationContext?.requestedImgRatio,
          asstImgRatio: legacyAsst?.generationContext?.imgRatio,
        }
      })
      if (!migrated) throw new Error('Migration test could not load chatStore')
      if (migrated.selectedModel !== 'gemini-3-pro-image') {
        throw new Error(`Persist v1→v2 should keep selectedModel=gemini, got ${migrated.selectedModel}`)
      }
      if (migrated.paramOverridesImgRatio !== 'auto') {
        throw new Error(`Persist v1→v2 should clamp paramOverrides.imgRatio 21:9→auto, got ${migrated.paramOverridesImgRatio}`)
      }
      if (migrated.userRequestedImgRatio !== 'auto') {
        throw new Error(`Persist v1→v2 should clamp legacy user requestedImgRatio 21:9→auto, got ${migrated.userRequestedImgRatio}`)
      }
      if (migrated.userImgRatio !== undefined) {
        throw new Error(`Persist v1→v2 should clamp legacy user imgRatio off 21:9 (to undefined), got ${JSON.stringify(migrated.userImgRatio)}`)
      }
      if (migrated.asstRequestedImgRatio !== 'auto') {
        throw new Error(`Persist v1→v2 should clamp legacy asst requestedImgRatio 21:9→auto, got ${migrated.asstRequestedImgRatio}`)
      }
      if (migrated.asstImgRatio !== undefined) {
        throw new Error(`Persist v1→v2 should clamp legacy asst imgRatio off 21:9 (to undefined), got ${JSON.stringify(migrated.asstImgRatio)}`)
      }
      // 弹层无 21:9（含 4:3）
      await migrationPage.locator('[aria-label="选择比例和质量"]').click()
      await migrationPage.waitForSelector('#chat-ratio-popover .chat-ratio-btn')
      const migrationRatioLabels = (await migrationPage.locator('#chat-ratio-popover .chat-ratio-btn').allInnerTexts()).map((t) => t.trim())
      if (migrationRatioLabels.some((t) => t === '21:9')) {
        throw new Error(`Migration: ratio popover should not include 21:9, got ${JSON.stringify(migrationRatioLabels)}`)
      }
      if (!migrationRatioLabels.some((t) => t === '4:3')) {
        throw new Error(`Migration: ratio popover should include 4:3, got ${JSON.stringify(migrationRatioLabels)}`)
      }
      // 采纳 8：RatioPopover 质量项 title 标注 高(2K)/中(1K)/低(1K)
      const qualityTitles = await migrationPage.locator('#chat-ratio-popover .chat-quality-btn').evaluateAll((btns) => btns.map((b) => b.getAttribute('title') || ''))
      if (!qualityTitles.some((t) => t.includes('2K'))) {
        throw new Error(`RatioPopover quality title should include 2K for high, got ${JSON.stringify(qualityTitles)}`)
      }
      if (!qualityTitles.some((t) => t.includes('1K') && !t.includes('2K'))) {
        throw new Error(`RatioPopover quality title should include 1K for medium/low, got ${JSON.stringify(qualityTitles)}`)
      }
    } finally {
      await migrationContext.close()
    }
  }
}
