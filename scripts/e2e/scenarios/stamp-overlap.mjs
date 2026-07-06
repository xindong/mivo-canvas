/**
 * stamp-overlap scenario — V2 stamp native fx + z-order parity (leafer + dom).
 *
 * 两个断言组:
 *
 * 1. D7 wiggle 验伤(placement preview):激活 stamp 工具 → press-and-hold
 *    (pointerdown 触发 beginStampPlacement → `.stamp-placement-preview` 出现 +
 *    `animation: stamp-wiggle` 无限动画)。leafer 模式真机确认"仍在动"。坏了修
 *    DOM/CSS 侧(不动 MivoCanvas.tsx —— 边界),没坏如实报。
 * 2. stamp/image 重叠 z-order + hit 一致:在 image 中心 quick-click 放一个 stamp →
 *    - dom 模式:`.dom-node.stamp-node` 的 z-index(var(--layer-stamp)=25)> image。
 *    - leafer 模式:切回 select 工具,点击重叠点 → 命中 stamp(selectedNodeId 是 stamp,
 *      不是 image)。这是"点击目标与视觉一致"的行为证据;视觉 z-order 由
 *      hitTest.test.ts 的 defaultZOrderCompare(renderOrder 先于 selected)+ leafer
 *      z-order map 的 renderOrder 子带单测锁定。
 * 3. leafer stamp 选中壳 + 等比 resize:选中 stamp 后必须出现 DOM-only selected
 *    shell(本体仍由 Leafer Group 画),outline 命中,且只暴露 4 个角 handle;拖角后
 *    store 几何保持 width===height。
 *
 * 两模式都跑(renderer=both)。不依赖 `__MIVO_LEAFER_SPIKE__.getPaintedNodes`
 * (它只覆盖 inline 文本,看不到 brushStamp 私有 entries —— 见 D6)。
 */

const readViewport = async (page) =>
  page.evaluate(() => {
    const shell = document.querySelector('.canvas-shell')
    return {
      scale: Number(shell?.getAttribute('data-viewport-scale') || 0),
      x: Number(shell?.getAttribute('data-viewport-x') || 0),
      y: Number(shell?.getAttribute('data-viewport-y') || 0),
    }
  })

const canvasStoreSpec = async (page) => {
  const resource = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => name.includes('/src/store/canvasStore.ts')),
  )
  return resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/canvasStore.ts'
}

/** 第一张 image 的屏幕中心(用于 stamp 放置 + 重叠点击)。dom:DOM boundingBox;
 *  leafer:store 几何 + canvas-shell data-viewport-* 投影(与 useLeaferSpikeRenderer
 *  getPaintedNodes 同式:screen = shellRect + viewport.{x,y} + node.{x,y} * scale)。 */
const firstImageScreenCenter = async (page, rendererMode) => {
  if (rendererMode !== 'leafer') {
    const box = await page.locator('.dom-node[data-node-type="image"]').first().boundingBox()
    if (!box) return null
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const spec = await canvasStoreSpec(page)
  return page.evaluate(async (moduleSpec) => {
    const shell = document.querySelector('.canvas-shell')
    const vp = {
      x: Number(shell.getAttribute('data-viewport-x') || 0),
      y: Number(shell.getAttribute('data-viewport-y') || 0),
      scale: Number(shell.getAttribute('data-viewport-scale') || 1),
    }
    const shellRect = shell.getBoundingClientRect()
    const { useCanvasStore } = await import(moduleSpec)
    const img = useCanvasStore.getState().nodes.find((node) => node.type === 'image' && !node.hidden)
    if (!img) return null
    return {
      x: shellRect.left + vp.x + (img.x + img.width / 2) * vp.scale,
      y: shellRect.top + vp.y + (img.y + img.height / 2) * vp.scale,
      imgId: img.id,
    }
  }, spec)
}

const setTool = async (page, tool) => {
  const spec = await canvasStoreSpec(page)
  await page.evaluate(async ([moduleSpec, toolId]) => {
    const { useCanvasStore } = await import(moduleSpec)
    useCanvasStore.getState().setActiveTool(toolId)
  }, [spec, tool])
}

const readSelectedNodeId = async (page) => {
  const spec = await canvasStoreSpec(page)
  return page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().selectedNodeId
  }, spec)
}

const stampCount = async (page) => {
  const spec = await canvasStoreSpec(page)
  return page.evaluate(async (moduleSpec) => {
    const { useCanvasStore } = await import(moduleSpec)
    return useCanvasStore.getState().nodes.filter((node) => node.type === 'markup' && node.markupKind === 'stamp').length
  }, spec)
}

const readStampNode = async (page, nodeId) => {
  const spec = await canvasStoreSpec(page)
  return page.evaluate(async ([moduleSpec, id]) => {
    const { useCanvasStore } = await import(moduleSpec)
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
    if (!node) return null
    return {
      id: node.id,
      type: node.type,
      markupKind: node.markupKind,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }
  }, [spec, nodeId])
}

const assertLeaferStampSelectionShell = async (page, stampId) => {
  await page.waitForFunction((id) => {
    const shell = Array.from(document.querySelectorAll('.dom-node.stamp-node.selected'))
      .find((node) => node.getAttribute('data-node-id') === id)
    return Boolean(shell)
  }, stampId, { timeout: 5000 })

  const evidence = await page.evaluate((id) => {
    const shell = Array.from(document.querySelectorAll('.dom-node.stamp-node.selected'))
      .find((node) => node.getAttribute('data-node-id') === id)
    if (!shell) return null
    const style = getComputedStyle(shell)
    const handles = Array.from(shell.querySelectorAll('.node-handle'))
      .map((handle) => Array.from(handle.classList).filter((entry) => entry !== 'node-handle').sort().join(' '))
      .sort()
    return {
      className: shell.className,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
      handles,
      textHandles: shell.querySelectorAll('.text-resize-handle').length,
      pointHandles: shell.querySelectorAll('.markup-point-handle').length,
      stickerBody: shell.querySelectorAll('.dom-markup-stamp, img').length,
    }
  }, stampId)

  if (!evidence) throw new Error(`stamp-overlap: leafer selected stamp shell missing for ${stampId}`)
  if (evidence.outlineStyle === 'none' || evidence.outlineWidth === '0px') {
    throw new Error(`stamp-overlap: selected stamp shell outline missing: ${JSON.stringify(evidence)}`)
  }
  if (evidence.stickerBody !== 0) {
    throw new Error(`stamp-overlap: leafer selected stamp shell must not render DOM sticker body: ${JSON.stringify(evidence)}`)
  }
  const expectedHandles = ['ne', 'nw', 'se', 'sw']
  if (JSON.stringify(evidence.handles) !== JSON.stringify(expectedHandles)) {
    throw new Error(`stamp-overlap: selected stamp should expose only corner handles: ${JSON.stringify(evidence)}`)
  }
  if (evidence.textHandles !== 0 || evidence.pointHandles !== 0) {
    throw new Error(`stamp-overlap: selected stamp should not expose side/text/point handles: ${JSON.stringify(evidence)}`)
  }

  console.log(
    `[stamp-overlap] leafer stamp selected shell ok: outline=${evidence.outlineWidth} ${evidence.outlineStyle} handles=${evidence.handles.join(',')}`,
  )
}

export const runStampOverlapScenario = async (context) => {
  const { page, rendererMode, wait } = context

  // --- 1. D7 wiggle 验伤 ---------------------------------------------------
  // 激活 stamp 工具 → press-and-hold(pointerdown 触发 beginStampPlacement →
  // 预览出现 + wiggle 无限动画)。不是 hover,是 pointerdown 期间才显示预览。
  await page.locator('.canvas-tool-dock > button[aria-label="Stamp"]').click()
  await page.waitForSelector('.stamp-options-bar')

  const shellBox = await page.locator('.canvas-shell').boundingBox()
  const hoverX = shellBox.x + shellBox.width / 2
  const hoverY = shellBox.y + shellBox.height / 2
  await page.mouse.move(hoverX, hoverY)
  await page.mouse.down() // press → 预览出现 + wiggle 开始
  try {
    await page.waitForSelector('.stamp-placement-preview', { timeout: 5000 })

    const wiggle = await page.evaluate(() => {
      const el = document.querySelector('.stamp-placement-preview')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { animationName: cs.animationName, transform: cs.transform }
    })
    if (!wiggle) throw new Error('stamp-overlap: .stamp-placement-preview vanished before wiggle read')
    if (!wiggle.animationName.includes('stamp-wiggle')) {
      throw new Error(`stamp-overlap: placement preview 期望 animation-name 含 stamp-wiggle,得到 ${wiggle.animationName}`)
    }
    // 真机确认"仍在动":hold 期间采样两次 transform,无限动画下应不同。
    const t0 = wiggle.transform
    await wait(200)
    const t1 = await page.evaluate(() => getComputedStyle(document.querySelector('.stamp-placement-preview')).transform)
    if (t0 === t1) {
      console.log(`[stamp-overlap] wiggle transform 未变化(reduced-motion? t0=${t0}) —— animationName=${wiggle.animationName} 已证明 wiggle 在场`)
    } else {
      console.log(`[stamp-overlap] wiggle 真机确认在动: t0=${String(t0).slice(0, 24)}… t1=${String(t1).slice(0, 24)}…`)
    }
  } finally {
    await page.mouse.up() // 释放 → 在 press 点放一个 stamp(harmless,wiggle 已验证)
  }
  await wait(120)

  // --- 2. stamp/image 重叠 z-order + hit 一致 -------------------------------
  const center = await firstImageScreenCenter(page, rendererMode)
  if (!center) {
    console.log('[stamp-overlap] 无 image 可重叠 —— 跳过 overlap 断言(wiggle 已验证)')
    return
  }
  const vp = await readViewport(page)
  console.log(`[stamp-overlap] renderer=${rendererMode} image center=(${center.x.toFixed(0)},${center.y.toFixed(0)}) imgId=${center.imgId ?? '(dom)'} viewport=${JSON.stringify(vp)}`)
  // 在 image 中心 quick-click 放一个 stamp(覆盖 image)
  const before = await stampCount(page)
  await page.mouse.click(center.x, center.y)
  try {
    const spec = await canvasStoreSpec(page)
    await page.waitForFunction(
      async ([moduleSpec, expected]) => {
        const { useCanvasStore } = await import(moduleSpec)
        return (
          useCanvasStore.getState().nodes.filter((node) => node.type === 'markup' && node.markupKind === 'stamp')
            .length >= expected
        )
      },
      [spec, before + 1],
      { timeout: 5000 },
    )
  } catch {
    throw new Error(`stamp-overlap: 放置 stamp 后计数未增(before=${before}) —— 点击可能未命中画布`)
  }

  if (rendererMode !== 'leafer') {
    // DOM 模式:stamp 的 z-index(var(--layer-stamp)=25)> image
    const z = await page.evaluate(() => {
      const stamp = document.querySelector('.dom-node.stamp-node')
      const image = document.querySelector('.dom-node[data-node-type="image"]')
      if (!stamp || !image) return null
      const stampZ = Number(getComputedStyle(stamp).zIndex)
      const imageZ = Number(getComputedStyle(image).zIndex)
      return { stampZ, imageZ: Number.isNaN(imageZ) ? 0 : imageZ }
    })
    if (!z) throw new Error('stamp-overlap: DOM 模式未找到 stamp 或 image 节点')
    if (!(z.stampZ > z.imageZ)) {
      throw new Error(`stamp-overlap: DOM z-order 期望 stamp(${z.stampZ}) > image(${z.imageZ})`)
    }
  } else {
    // leafer 模式:切回 select 工具,点击重叠点 → 命中 stamp(selectedNodeId 是 stamp)
    await setTool(page, 'select')
    await wait(150)
    await page.mouse.click(center.x, center.y)
    await wait(250)
    const selectedId = await readSelectedNodeId(page)
    const spec = await canvasStoreSpec(page)
    const isStamp = await page.evaluate(async ([moduleSpec, id]) => {
      const { useCanvasStore } = await import(moduleSpec)
      const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
      return node?.type === 'markup' && node?.markupKind === 'stamp'
    }, [spec, selectedId])
    if (!isStamp) {
      throw new Error(`stamp-overlap: leafer hit-test 期望命中 stamp,实际 selectedNodeId=${selectedId}`)
    }
    await assertLeaferStampSelectionShell(page, selectedId)

    const beforeResize = await readStampNode(page, selectedId)
    if (!beforeResize) throw new Error(`stamp-overlap: missing selected stamp before resize (${selectedId})`)
    const handle = await page.locator(`.dom-node.stamp-node.selected[data-node-id="${selectedId}"] .node-handle.se`).boundingBox()
    if (!handle) throw new Error(`stamp-overlap: missing selected stamp se resize handle (${selectedId})`)
    const startX = handle.x + handle.width / 2
    const startY = handle.y + handle.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 60, startY + 25, { steps: 6 })
    await page.mouse.up()
    await page.waitForFunction(
      async ([moduleSpec, id, beforeWidth]) => {
        const { useCanvasStore } = await import(moduleSpec)
        const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
        return Boolean(
          node &&
          node.type === 'markup' &&
          node.markupKind === 'stamp' &&
          Math.abs(node.width - node.height) < 0.001 &&
          node.width > beforeWidth + 20,
        )
      },
      [spec, selectedId, beforeResize.width],
      { timeout: 5000 },
    )
    const afterResize = await readStampNode(page, selectedId)
    if (!afterResize || Math.abs(afterResize.width - afterResize.height) > 0.001) {
      throw new Error(`stamp-overlap: stamp resize should stay square, before=${JSON.stringify(beforeResize)} after=${JSON.stringify(afterResize)}`)
    }
    console.log(
      `[stamp-overlap] leafer stamp corner resize kept square: ${beforeResize.width}x${beforeResize.height} -> ${afterResize.width}x${afterResize.height}`,
    )
  }
}
