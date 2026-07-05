// renderer-evidence — e2e 场景的 renderer-aware 证据层。
//
// 背景:leafer 模式下 image / frame / markup 由 Leafer 真画(leaferSpikeFilter),
// 设计上不存在 .dom-node / img[src] / [data-node-id] 等 DOM 结构;DOM-only 断言
// 在 leafer 模式必然超时,但这不是产品 bug,而是测试口径问题。本模块把
// "节点存在/可见/可点击/计数"这些证据按 renderer 模式分派:
//
// - dom 模式:与既有断言完全一致(waitForSelector / locator.click / boundingBox),
//   默认行为零变化。
// - leafer 模式:走 Leafer 观测面 —— .canvas-shell 上的 data-leafer-children /
//   data-leafer-expected-children / data-leafer-pixel-nonempty / data-viewport-* /
//   data-total-node-count 观测属性 + canvasStore 节点几何。屏幕坐标投影公式与
//   useLeaferSpikeRenderer.getPaintedNodes 完全同式:
//   screen = shellRect + viewport.{x,y} + node.{x,y} * viewport.scale。
//   (注:__MIVO_LEAFER_SPIKE__.getPaintedNodes 的 paintedRef 只覆盖 bench-only
//   inline 文本,常规 leafer 模式恒为空,不能作为 image/shape 的存在性证据。)
//
// 点击/双击在 leafer 分支用投影矩形中心打真实鼠标事件,由画布 hit-test
// (interactionAdapter)完成命中,与用户真实交互同路径。
//
// 注意:text / annotation / ai-slot / task-placeholder / markdown 等非 Leafer 真画
// 类型在 leafer 模式仍渲染 DOM,对这些节点 helper 的 leafer 分支优先接受 DOM 证据。
//
// store 模块解析:与 e2e-smoke 的 canvasStoreSpec 同策略——先从 performance
// resource entries 找带 query 的真实模块 URL,兜底裸路径(dev 由 vite 直接服务;
// prod topology 由 installE2EStoreBridge 的 route 拦截返回 bridge 模块,两者都可导入)。

/** 画布就绪(demo 场景 3 张图已可见)。dom:等 demo 首图 <img>;leafer:等
 *  data-leafer-children 追平 expected 且像素采样非空(与 e2e-smoke
 *  bootstrapBaseCanvas 同口径)。场景内 reload / 切回 Canvas tab 后使用。 */
export const waitForCanvasReady = async (page, rendererMode, { timeout = 30000 } = {}) => {
  if (rendererMode === 'leafer') {
    await page.waitForFunction(() => {
      const shell = document.querySelector('.canvas-shell')
      const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
      const children = Number(shell?.getAttribute('data-leafer-children') || 0)
      return expected > 0 && children === expected && shell?.getAttribute('data-leafer-pixel-nonempty') === 'true'
    }, { timeout })
    return
  }
  await page.waitForSelector('img[src="/demo-assets/courage-1.jpg"]', { timeout })
}

/** 节点已渲染。dom:waitForSelector([data-node-id]) 可见;leafer:DOM 壳存在
 *  (非真画类型)即证据;真画类型等 store 有该节点且 Leafer sync 追平
 *  (children === expected)——paint diff 是同步 effect,追平即已入画。 */
export const waitForNodeRendered = async (page, rendererMode, nodeId, { timeout = 30000 } = {}) => {
  if (rendererMode !== 'leafer') {
    await page.waitForSelector(`[data-node-id="${nodeId}"]`, { timeout })
    return
  }
  await page.waitForFunction(async (id) => {
    if (document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)) return true
    const resource = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('/src/store/canvasStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/canvasStore.ts'
    const { useCanvasStore } = await import(moduleSpec)
    if (!useCanvasStore.getState().nodes.some((node) => node.id === id && !node.hidden)) return false
    const shell = document.querySelector('.canvas-shell')
    const expected = Number(shell?.getAttribute('data-leafer-expected-children') || 0)
    const children = Number(shell?.getAttribute('data-leafer-children') || 0)
    return expected > 0 && children === expected
  }, nodeId, { timeout })
}

/** 节点屏幕矩形 {x,y,width,height}。dom:boundingBox;leafer:优先 DOM 壳
 *  boundingBox(非真画类型),否则 store 几何 × data-viewport-* 投影
 *  (与 getPaintedNodes screenRect 同式)。找不到返回 null。 */
export const nodeScreenRect = async (page, rendererMode, nodeId) => {
  if (rendererMode !== 'leafer') {
    return page.locator(`[data-node-id="${nodeId}"]`).boundingBox()
  }
  return page.evaluate(async (id) => {
    const element = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
    if (element) {
      const rect = element.getBoundingClientRect()
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    }
    const resource = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => name.includes('/src/store/canvasStore.ts'))
    const moduleSpec = resource ? new URL(resource).pathname + new URL(resource).search : '/src/store/canvasStore.ts'
    const { useCanvasStore } = await import(moduleSpec)
    const node = useCanvasStore.getState().nodes.find((entry) => entry.id === id)
    const shell = document.querySelector('.canvas-shell')
    if (!node || !shell) return null
    const shellRect = shell.getBoundingClientRect()
    const scale = Number(shell.getAttribute('data-viewport-scale') || 1)
    const viewportX = Number(shell.getAttribute('data-viewport-x') || 0)
    const viewportY = Number(shell.getAttribute('data-viewport-y') || 0)
    return {
      x: shellRect.left + viewportX + node.x * scale,
      y: shellRect.top + viewportY + node.y * scale,
      width: node.width * scale,
      height: node.height * scale,
    }
  }, nodeId)
}

/** 点击节点(默认中心)。dom:locator.click(与既有行为一致);leafer:投影
 *  矩形中心打真实 mouse click,画布 hit-test 命中。position 为相对节点左上角
 *  的偏移(与 Playwright click position 语义一致)。 */
export const clickCanvasNode = async (page, rendererMode, nodeId, { button = 'left', position } = {}) => {
  if (rendererMode !== 'leafer') {
    await page.locator(`[data-node-id="${nodeId}"]`).click({ button, position })
    return
  }
  const rect = await nodeScreenRect(page, rendererMode, nodeId)
  if (!rect) throw new Error(`clickCanvasNode: node ${nodeId} not rendered (no DOM shell, no store geometry)`)
  const x = rect.x + (position ? position.x : rect.width / 2)
  const y = rect.y + (position ? position.y : rect.height / 2)
  await page.mouse.click(x, y, { button })
}

/** 双击节点(默认中心)。分派逻辑同 clickCanvasNode。 */
export const dblclickCanvasNode = async (page, rendererMode, nodeId, { position } = {}) => {
  if (rendererMode !== 'leafer') {
    await page.locator(`[data-node-id="${nodeId}"]`).dblclick({ position })
    return
  }
  const rect = await nodeScreenRect(page, rendererMode, nodeId)
  if (!rect) throw new Error(`dblclickCanvasNode: node ${nodeId} not rendered (no DOM shell, no store geometry)`)
  const x = rect.x + (position ? position.x : rect.width / 2)
  const y = rect.y + (position ? position.y : rect.height / 2)
  await page.mouse.dblclick(x, y)
}

/** 读全量节点数(未虚拟化、未按 renderer 过滤)。两种模式都读
 *  data-total-node-count(= 非 hidden 节点数),与 .dom-node 计数不同的是它
 *  不受虚拟化/Leafer 过滤影响,适合"交互后节点 +N"类断言。 */
export const readTotalNodeCount = (page) =>
  page.evaluate(() => Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0))

/** 等全量节点数 >= count(data-total-node-count 口径)。 */
export const waitForTotalNodeCountAtLeast = async (page, count, { timeout = 30000 } = {}) => {
  await page.waitForFunction(
    (expected) => Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0) >= expected,
    count,
    { timeout },
  )
}
