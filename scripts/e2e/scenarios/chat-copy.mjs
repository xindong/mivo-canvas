// chat 复制粘贴三验收(feat/chat-copy-paste):
//  SC1 chat 输入框内 cmd+C/V 不触发画布节点复制粘贴,浏览器默认行为可用
//  SC2 chat 气泡选中文本 cmd+C 复制到系统剪贴板(全局快捷键不再劫持)
//  SC3 画布选中节点 cmd+C/V 照常(clipboardNodes + 节点数增长)
//  SC4 用户提示词气泡下的拷贝按钮复制全文 + toast「已复制」
// harness 已授予 clipboard-read/write 权限(harness.mjs grantPermissions)。

const storeHelpers = async (context) => {
  const spec = await context.canvasStoreSpec()
  const readClipboardNodesCount = () =>
    context.page.evaluate(async (moduleSpec) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().clipboardNodes.length
    }, spec)
  return { spec, readClipboardNodesCount }
}

export const runChatCopyScenario = async (context) => {
  const { page, readCanvasState } = context
  const { spec, readClipboardNodesCount } = await storeHelpers(context)

  if (await page.locator('.ai-panel.collapsed').isVisible()) {
    await page.getByRole('button', { name: 'Open AI panel' }).click()
    await page.waitForSelector('.chat-composer-textarea', { state: 'visible' })
  }

  // 种一条用户消息(不走生成管线,只为渲染气泡 + 拷贝按钮)。
  const promptText = 'E2E 提示词:一只在霓虹雨夜里撑伞的橘猫'
  await page.evaluate(async ({ moduleSpec, text }) => {
    const resource = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('chatStore.ts'))
    const chatSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/chatStore.ts'
    const { useChatStore } = await import(chatSpec)
    const { useCanvasStore } = await import(moduleSpec)
    const sceneId = useCanvasStore.getState().sceneId
    useChatStore.setState((s) => ({
      messagesByScene: {
        ...s.messagesByScene,
        [sceneId]: [
          ...(s.messagesByScene[sceneId] || []),
          { id: 'e2e-copy-user-msg', role: 'user', status: 'done', text },
        ],
      },
    }))
  }, { moduleSpec: spec, text: promptText })
  await page.waitForSelector('.chat-message-user .chat-bubble-user')

  // ── SC1: composer 内 cmd+C/V 走浏览器默认,不碰画布 ──
  const composer = page.locator('.chat-composer-textarea')
  await composer.fill('hello')
  await composer.focus()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  const clipboardAfterComposerCopy = await page.evaluate(() => navigator.clipboard.readText())
  if (clipboardAfterComposerCopy !== 'hello') {
    throw new Error(`SC1: composer cmd+C should copy the selected text, clipboard=${JSON.stringify(clipboardAfterComposerCopy)}`)
  }
  if ((await readClipboardNodesCount()) !== 0) {
    throw new Error('SC1: composer cmd+C must not trigger canvas copySelectedNodes')
  }
  const nodesBeforeComposerPaste = (await readCanvasState()).nodes.length
  await page.keyboard.press('End')
  await page.keyboard.press('ControlOrMeta+v')
  await page.waitForFunction(() => {
    const el = document.querySelector('.chat-composer-textarea')
    return el && el.value === 'hellohello'
  }, undefined, { timeout: 5000 })
  if ((await readCanvasState()).nodes.length !== nodesBeforeComposerPaste) {
    throw new Error('SC1: composer cmd+V must not paste canvas nodes')
  }
  await composer.fill('')

  // SC1b: 点击 composer 之外的画布应让输入框失焦，#108 的聚焦边框恢复默认色。
  await composer.fill('blur target')
  await composer.focus()
  const focusedComposerStyle = await page.evaluate(() => {
    const shell = document.querySelector('.chat-composer-input-shell')
    const textarea = document.querySelector('.chat-composer-textarea')
    return {
      focused: document.activeElement === textarea,
      borderTopColor: shell ? getComputedStyle(shell).borderTopColor : '',
    }
  })
  if (!focusedComposerStyle.focused) {
    throw new Error(`SC1b: composer should be focused before outside click: ${JSON.stringify(focusedComposerStyle)}`)
  }
  await page.locator('.canvas-shell').click({ position: { x: 32, y: 32 }, force: true })
  await page.waitForFunction(() => document.activeElement !== document.querySelector('.chat-composer-textarea'))
  const blurredComposerStyle = await page.evaluate(() => {
    const shell = document.querySelector('.chat-composer-input-shell')
    const textarea = document.querySelector('.chat-composer-textarea')
    return {
      focused: document.activeElement === textarea,
      borderTopColor: shell ? getComputedStyle(shell).borderTopColor : '',
    }
  })
  if (blurredComposerStyle.focused || blurredComposerStyle.borderTopColor === focusedComposerStyle.borderTopColor) {
    throw new Error(
      `SC1b: outside canvas click should blur composer and restore the default border: ${JSON.stringify({ focusedComposerStyle, blurredComposerStyle })}`,
    )
  }
  await composer.fill('')

  // ── SC2: chat 气泡选中文本 cmd+C 复制到系统剪贴板 ──
  await page.evaluate(() => {
    const bubble = document.querySelector('.chat-message-user .chat-bubble-user')
    const range = document.createRange()
    range.selectNodeContents(bubble)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.keyboard.press('ControlOrMeta+c')
  const clipboardAfterBubbleCopy = await page.evaluate(() => navigator.clipboard.readText())
  if (clipboardAfterBubbleCopy !== promptText) {
    throw new Error(`SC2: bubble text cmd+C should copy selection, clipboard=${JSON.stringify(clipboardAfterBubbleCopy)}`)
  }
  if ((await readClipboardNodesCount()) !== 0) {
    throw new Error('SC2: bubble text cmd+C must not trigger canvas copySelectedNodes')
  }
  await page.evaluate(() => window.getSelection()?.removeAllRanges())

  // ── SC3: 画布选中节点 cmd+C/V 照常 ──
  const firstNodeId = await page.locator('.dom-node').first().getAttribute('data-node-id')
  await page.evaluate(async ({ moduleSpec, nodeId }) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().selectNode(nodeId)
  }, { moduleSpec: spec, nodeId: firstNodeId })
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.keyboard.press('ControlOrMeta+c')
  await page.waitForFunction(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().clipboardNodes.length === 1
  }, spec, { timeout: 5000 })
  const nodesBeforeCanvasPaste = (await readCanvasState()).nodes.length
  await page.keyboard.press('ControlOrMeta+v')
  await page.waitForFunction(
    async ({ moduleSpec, before }) => {
      const { useCanvasStore } = await import(moduleSpec)
      return useCanvasStore.getState().nodes.length === before + 1
    },
    { moduleSpec: spec, before: nodesBeforeCanvasPaste },
    { timeout: 5000 },
  )

  // ── SC4: 拷贝按钮复制提示词全文 + toast「已复制」──
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await page.locator('.chat-message-user .chat-copy-prompt-btn').first().click()
  await page.waitForFunction(async (expected) => (await navigator.clipboard.readText()) === expected, promptText, { timeout: 5000 })
  const copyToastVisible = await page.locator('.toast-item.success .toast-message', { hasText: '已复制' }).first().isVisible().catch(() => false)
  if (!copyToastVisible) {
    throw new Error('SC4: copy button should toast 已复制')
  }

  console.log('chat-copy scenario passed')
}
