import { installE2EStoreBridge } from '../harness.mjs'

export const runMigrationScenario = async (context) => {
  const { baseUrl, browser, generatedImageB64, isProdTopology, prodExtraHTTPHeaders } = context

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
    const migrationPage = await migrationContext.newPage()
    try {
      await migrationPage.route('**/api/mivo/generate', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ images: [{ b64: generatedImageB64 }] }) })
      })
      await migrationPage.route('**/api/mivo/edit', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ images: [{ b64: generatedImageB64 }] }) })
      })
      await migrationPage.route('**/api/mivo/enhance', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mode: 'generate', scene: 'general', reasoning: 'e2e', richPrompt: 'e2e derived', imgRatio: '1:1', quality: 'medium', enhanced: true }) })
      })
      // 注入 v1 storage（version:1）——含 21:9 override 与一条 21:9 旧 error 消息的 generationContext
      await migrationPage.addInitScript(() => {
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
        window.localStorage.setItem('mivo-chat-demo', JSON.stringify(v1State))
      })
      await migrationPage.goto(baseUrl, { waitUntil: 'networkidle' })
      await migrationPage.waitForSelector('img[src="/demo-assets/courage-1.jpg"]')
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
