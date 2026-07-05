/**
 * FU-11 markup 文字层 scenario（dom / leafer 双模式跑同一脚本）。
 *
 * 验收：leafer 模式下 note 正文、rect 标注文字、arrow 线上 label 可见可编辑，
 * 与 dom 模式行为一致（双击编辑、Escape/失焦提交）。leafer 侧文字以
 * "纯文字 DOM 壳"（.markup-text-overlay）渲染——本体（SVG/note 背景）由
 * Leafer 真画，壳内不允许出现本体元素；无文字的 markup 不产生空壳。
 *
 * 几何依据：右键 "New xxx markup" 在 context 点居中创建 160×96 的节点
 * （canvasActionModel.createMarkupAtContext: x-80, y-48），arrow 默认端点
 * (8,88)-(152,8) 的中点恰是节点中心 —— 因此对同一屏幕点 dblclick 一定命中
 * 本体（rect/note 面、arrow 线身），leafer 模式无 DOM 元素也能走画布 hit-test。
 */

export const runMarkupTextOverlayScenario = async (context) => {
  const { page, rendererMode } = context
  const leaferMode = rendererMode === 'leafer'
  const shell = page.locator('.canvas-shell')
  const shellBox = await shell.boundingBox()
  if (!shellBox) throw new Error('canvas-shell bounding box unavailable')

  // 画布全铺后（#122）左侧被浮动侧栏卡片盖住、demo 节点占据视口中部——先用滚轮
  // 把画布 pan 到远处空白区（滚轮=pan，Ctrl+滚轮才是 zoom），之后屏幕中部即为
  // 纯空白画布，dom / leafer 两种模式都不会误点到 demo 节点或侧栏。
  await page.mouse.move(shellBox.x + shellBox.width / 2, shellBox.y + shellBox.height / 2)
  await page.mouse.wheel(2400, 1800)
  await page.waitForTimeout(200)

  const readTotalNodeCount = () =>
    page.evaluate(() => Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0))
  const readTextShellCount = () =>
    page.evaluate(() => Number(document.querySelector('.canvas-shell')?.getAttribute('data-leafer-markup-text-shells') || 0))

  // hasInitialText: note 新建自带默认文字 'Note'（nodeCreationSlice addMarkupNode），
  // 因此 leafer 模式下 note 一落地就应有文字壳；rect/arrow 无初始文字则不允许空壳。
  const createMarkupAt = async (spot, menuItem, markupKind, { hasInitialText = false } = {}) => {
    const before = await readTotalNodeCount()
    await page.mouse.click(spot.x, spot.y, { button: 'right' })
    await page.getByRole('menuitem', { name: menuItem }).click()
    await page.waitForFunction(
      (expected) => Number(document.querySelector('.canvas-shell')?.getAttribute('data-total-node-count') || 0) === expected,
      before + 1,
    )
    const expectedShells = leaferMode && !hasInitialText ? 0 : 1
    const domShellCount = await page.locator(`.dom-node.markup-node[data-markup-kind="${markupKind}"]`).count()
    if (domShellCount !== expectedShells) {
      throw new Error(
        `${rendererMode} mode: freshly created ${markupKind} markup should render ${expectedShells} DOM node(s) (initialText=${hasInitialText}), got ${domShellCount}`,
      )
    }
  }

  const editSelector = (markupKind) => `.dom-node.markup-node[data-markup-kind="${markupKind}"].editing .dom-markup-text-editor`

  const assertOverlayShellPurity = async (markupKind) => {
    // leafer 壳内不允许出现本体：SVG（rect/ellipse/line/arrow）与 note 背景面。
    const impurities = await page.evaluate((kind) => {
      const shells = Array.from(document.querySelectorAll(`.dom-node.markup-node[data-markup-kind="${kind}"]`))
      return shells.map((element) => ({
        hasOverlayClass: element.classList.contains('markup-text-overlay'),
        svgCount: element.querySelectorAll('svg').length,
        noteFaceCount: element.querySelectorAll('.dom-markup-note').length,
      }))
    }, markupKind)
    for (const shellInfo of impurities) {
      if (!shellInfo.hasOverlayClass || shellInfo.svgCount !== 0 || shellInfo.noteFaceCount !== 0) {
        throw new Error(`leafer mode: ${markupKind} text shell must be text-only (markup-text-overlay, no svg/note face): ${JSON.stringify(impurities)}`)
      }
    }
  }

  // ---- rect：双击进入编辑（空文字也要有编辑壳）→ 输入 → Escape 提交 ----
  const rectSpot = { x: shellBox.x + shellBox.width * 0.45, y: shellBox.y + shellBox.height * 0.35 }
  await createMarkupAt(rectSpot, 'New rectangle markup', 'rect')
  await page.mouse.dblclick(rectSpot.x, rectSpot.y)
  await page.waitForSelector(editSelector('rect'))
  if (leaferMode) await assertOverlayShellPurity('rect')
  await page.keyboard.type('Overlay 标注')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.dom-node.markup-node[data-markup-kind="rect"]:not(.editing) .dom-markup-label.shape-label')
  const rectLabelText = await page.locator('.dom-node.markup-node[data-markup-kind="rect"] .dom-markup-label.shape-label').textContent()
  if (!rectLabelText?.includes('Overlay 标注')) {
    throw new Error(`rect markup label should keep committed text, got ${rectLabelText}`)
  }
  if (leaferMode) {
    await assertOverlayShellPurity('rect')
    if ((await readTextShellCount()) !== 1) {
      throw new Error(`leafer mode: data-leafer-markup-text-shells should be 1 after rect text commit, got ${await readTextShellCount()}`)
    }
  } else if ((await page.locator('.dom-node.markup-node.markup-text-overlay').count()) !== 0) {
    throw new Error('dom mode: markup-text-overlay shell must never appear (default behavior unchanged)')
  }

  // ---- note：双击编辑 → 输入 → 点击空白失焦提交 ----
  const noteSpot = { x: shellBox.x + shellBox.width * 0.45, y: shellBox.y + shellBox.height * 0.62 }
  await createMarkupAt(noteSpot, 'New markup note', 'note', { hasInitialText: true })
  if (leaferMode) {
    // note 自带 'Note' 默认正文——落地即有文字壳可见。
    await assertOverlayShellPurity('note')
    const initialNoteText = await page.locator('.dom-node.markup-node[data-markup-kind="note"] .dom-markup-label').textContent()
    if (!initialNoteText?.includes('Note')) {
      throw new Error(`leafer mode: new note should show its default 'Note' text via the overlay shell, got ${initialNoteText}`)
    }
  }
  await page.mouse.dblclick(noteSpot.x, noteSpot.y)
  await page.waitForSelector(editSelector('note'))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.type('便签正文')
  // 失焦提交：点远处空白画布（不按 Escape）。
  await page.mouse.click(shellBox.x + shellBox.width * 0.8, shellBox.y + shellBox.height * 0.62)
  await page.waitForSelector('.dom-node.markup-node[data-markup-kind="note"]:not(.editing) .dom-markup-label.shape-label.kind-note')
  const noteLabelText = await page.locator('.dom-node.markup-node[data-markup-kind="note"] .dom-markup-label.shape-label').textContent()
  if (!noteLabelText?.includes('便签正文')) {
    throw new Error(`note markup body text should commit on blur, got ${noteLabelText}`)
  }
  if (leaferMode) await assertOverlayShellPurity('note')

  // ---- arrow：双击线身中点 → 输入 → Escape → 线上 label ----
  const arrowSpot = { x: shellBox.x + shellBox.width * 0.68, y: shellBox.y + shellBox.height * 0.35 }
  await createMarkupAt(arrowSpot, 'New arrow markup', 'arrow')
  await page.mouse.dblclick(arrowSpot.x, arrowSpot.y)
  await page.waitForSelector(editSelector('arrow'))
  await page.keyboard.type('Flow label')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.dom-node.markup-node[data-markup-kind="arrow"]:not(.editing) .dom-markup-label.line-label')
  if (leaferMode) {
    await assertOverlayShellPurity('arrow')
    if ((await readTextShellCount()) !== 3) {
      throw new Error(`leafer mode: expected 3 markup text shells after rect/note/arrow, got ${await readTextShellCount()}`)
    }
  } else {
    // dom 模式：线体因 label 分成两段（缺口）——既有行为保持。
    const segments = await page.locator('.dom-node.markup-node[data-markup-kind="arrow"] .markup-visible-line').count()
    if (segments !== 2) {
      throw new Error(`dom mode: arrow with label should render 2 visible segments, got ${segments}`)
    }
  }

  // ---- rect 二次编辑：清空文字 → 提交 → label 消失；leafer 模式壳一并回收 ----
  await page.mouse.dblclick(rectSpot.x, rectSpot.y)
  await page.waitForSelector(editSelector('rect'))
  const editorValue = await page.locator(editSelector('rect')).inputValue()
  if (!editorValue.includes('Overlay 标注')) {
    throw new Error(`re-editing rect should preload committed text, got ${editorValue}`)
  }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')
  await page.waitForFunction(
    () => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="rect"] .dom-markup-label').length === 0,
  )
  if (leaferMode) {
    // 无文字 → 壳回收，不留空 DOM。
    await page.waitForFunction(
      () => document.querySelectorAll('.dom-node.markup-node[data-markup-kind="rect"]').length === 0,
    )
    if ((await readTextShellCount()) !== 2) {
      throw new Error(`leafer mode: clearing rect text should drop its shell (expect 2 left), got ${await readTextShellCount()}`)
    }
  } else if ((await page.locator('.dom-node.markup-node[data-markup-kind="rect"]').count()) !== 1) {
    throw new Error('dom mode: rect markup node should stay rendered after clearing text')
  }
}
