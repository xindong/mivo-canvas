// project-sidebar e2e — maker sidebar replication scenarios (Phase 6 / C13).
//
// Covers the 6 acceptance flows: project CRUD + inline rename, in-project canvas
// creation, right-click move (canvas↔project), canvas removal via the archive →
// trash 彻底删除 paradigm (PR-C2 P1-2: active rows无直接删除入口) + last-active-canvas
// archive guard, project removal via archive → trash whole-tree 彻底删除 (with
// canvas-count copy), collapse persistence + updatedAt ordering. Self-contained:
// each test resets to a known state via the store, then drives the UI. Must pass
// on dev/prod × dom/leafer (renderer=both).
import { waitForCanvasReady } from '../renderer-evidence.mjs'

// Wipe canvases/projects to a single blank canvas so each test starts clean
// (merge-mode setState preserves the store's action functions).
const resetState = async (page, canvasStoreSpec) => {
  await page.evaluate(async (spec) => {
    const { useCanvasStore } = await import(spec)
    const now = new Date().toISOString()
    const blankId = 'e2e-reset'
    useCanvasStore.setState({
      canvases: { [blankId]: { title: 'Reset', createdAt: now, updatedAt: now, nodes: [], edges: [], tasks: [], selectedNodeId: undefined, selectedNodeIds: [] } },
      projects: [],
      sceneId: blankId,
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
  }, await canvasStoreSpec())
}

// Create a known project + 3 canvases (2 in-project, 1 standalone) on top of reset.
// Self-contained: resets first so repeated calls don't accumulate duplicate projects.
const setupState = async (page, canvasStoreSpec) => {
  await resetState(page, canvasStoreSpec)
  return page.evaluate(async (spec) => {
    const { useCanvasStore } = await import(spec)
    const state = useCanvasStore.getState()
    const projectId = state.createProject('E2E Project')
    state.createCanvas('Canvas A', { projectId })
    state.createCanvas('Canvas B', { projectId })
    const standalone = state.createCanvas('Canvas Standalone')
    return { projectId, standalone }
  }, await canvasStoreSpec())
}

const readState = async (page, canvasStoreSpec) =>
  page.evaluate(async (spec) => {
    const { useCanvasStore } = await import(spec)
    const { projects, canvases, sceneId } = useCanvasStore.getState()
    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      canvasProjects: Object.fromEntries(Object.entries(canvases).map(([id, doc]) => [id, doc.projectId])),
      canvasTitles: Object.fromEntries(Object.entries(canvases).map(([id, doc]) => [id, doc.title])),
      canvasUpdatedAt: Object.fromEntries(Object.entries(canvases).map(([id, doc]) => [id, doc.updatedAt])),
      sceneId,
    }
  }, await canvasStoreSpec())

const branchFor = (page, name) =>
  page.locator('.project-branch').filter({ hasText: name }).first()

const canvasRowFor = (page, title) =>
  page.locator('.canvas-row').filter({ hasText: title }).first()

const openCanvasMenu = async (page, title) => {
  const row = canvasRowFor(page, title)
  await row.waitFor({ state: 'visible' })
  await row.click({ button: 'right' })
  await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' })
}

const openProjectMenu = async (page, name) => {
  const row = branchFor(page, name).locator('.project-row')
  await row.waitFor({ state: 'visible' })
  await row.click({ button: 'right' })
  await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' })
}

const clickMenuItem = async (page, text) => {
  await page.locator('.sidebar-context-menu-item').filter({ hasText: text }).click()
}

const moveToProjectViaMenu = async (page, projectName) => {
  await page.locator('.sidebar-context-menu-item').filter({ hasText: '移动到项目' }).click()
  await page.locator('.sidebar-context-menu-submenu').waitFor({ state: 'visible' })
  await page.locator('.sidebar-context-menu-submenu .sidebar-context-menu-item').filter({ hasText: projectName }).click()
}

const menuLabels = async (page) => page.locator('.sidebar-context-menu-item').allTextContents()

const switchView = async (page, filterView) => {
  await page.locator(`[data-filter-view="${filterView}"]`).click()
  await page.waitForFunction(
    (view) => document.querySelector(`[data-filter-view="${view}"]`)?.getAttribute('aria-pressed') === 'true',
    filterView,
  )
}

export const runProjectSidebarScenario = async (context) => {
  const { baseUrl, canvasUrl, canvasStoreSpec, page, rendererMode, wait } = context

  // The e2e-smoke harness already ran clearAllStorage + a bootstrapped goto before
  // this scenario, so storage is clean. We deliberately do NOT add an
  // addInitScript localStorage.clear — that would re-run on the test-6 reload and
  // wipe the collapsed-projects set we're trying to verify persists.
  await page.goto(canvasUrl || baseUrl, { waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)

  // --- 1. New project + inline rename ---------------------------------------
  {
    await resetState(page, canvasStoreSpec)
    await wait()
    await page.getByRole('button', { name: 'New project' }).click()
    const renameInput = page.locator('.sidebar-editable-name')
    await renameInput.waitFor({ state: 'visible' })
    await renameInput.fill('My New Project')
    await renameInput.press('Enter')
    await wait()
    const state = await readState(page, canvasStoreSpec)
    if (!state.projects.some((p) => p.name === 'My New Project')) {
      throw new Error(`New project rename should persist: ${JSON.stringify(state.projects)}`)
    }
  }

  // --- 2. New canvas in a project (hover +) ---------------------------------
  {
    const { projectId } = await setupState(page, canvasStoreSpec)
    await wait()
    const branch = branchFor(page, 'E2E Project')
    await branch.waitFor({ state: 'visible' })
    const projectRow = branch.locator('.project-row')
    await projectRow.hover()
    await branch.locator('.project-row-create').click({ force: true })
    await wait()
    const state = await readState(page, canvasStoreSpec)
    if (state.canvasProjects[state.sceneId] !== projectId) {
      throw new Error(
        `In-project new canvas should be active + belong to the project: sceneId=${state.sceneId} project=${state.canvasProjects[state.sceneId]} expected=${projectId}`,
      )
    }
    const newTitle = state.canvasTitles[state.sceneId]
    const canvasRowInProject = branch.locator('.canvas-row').filter({ hasText: newTitle })
    if ((await canvasRowInProject.count()) !== 1) {
      throw new Error('New canvas row should appear inside the project group')
    }
  }

  // --- 3. Right-click move: standalone → project → back to Canvas -----------
  {
    const { projectId, standalone } = await setupState(page, canvasStoreSpec)
    await wait()
    await openCanvasMenu(page, 'Canvas Standalone')
    await moveToProjectViaMenu(page, 'E2E Project')
    await wait()
    let state = await readState(page, canvasStoreSpec)
    if (state.canvasProjects[standalone] !== projectId) {
      throw new Error(`Move to project failed: ${state.canvasProjects[standalone]} expected ${projectId}`)
    }
    // Move back to Canvas via 移到 Canvas sub-item.
    await openCanvasMenu(page, 'Canvas Standalone')
    await page.locator('.sidebar-context-menu-item').filter({ hasText: '移动到项目' }).click()
    await page.locator('.sidebar-context-menu-submenu').waitFor({ state: 'visible' })
    await page.locator('.sidebar-context-menu-submenu .sidebar-context-menu-item').filter({ hasText: '移到 Canvas' }).click()
    await wait()
    state = await readState(page, canvasStoreSpec)
    if (state.canvasProjects[standalone] !== undefined) {
      throw new Error(`Move back to Canvas failed: ${state.canvasProjects[standalone]}`)
    }
  }

  // --- 4. 画板删除新范式(PR-C2 P1-2):active 菜单无「删除」;归档 → 回收站彻底删除;
  //        末块 active 画板归档 guard --------------------------------------------
  {
    await setupState(page, canvasStoreSpec)
    await wait()
    // active 视图画板菜单不再暴露直接删除入口(删除收敛为 归档 → 回收站「彻底删除」)。
    await openCanvasMenu(page, 'Canvas A')
    let labels = await menuLabels(page)
    if (labels.includes('删除')) {
      throw new Error(`active canvas menu must not expose direct delete: ${JSON.stringify(labels)}`)
    }
    if (!labels.includes('归档')) {
      throw new Error(`active canvas menu should expose archive: ${JSON.stringify(labels)}`)
    }
    await clickMenuItem(page, '归档')
    await wait()
    if ((await canvasRowFor(page, 'Canvas A').count()) !== 0) {
      throw new Error('archived canvas should leave the active view')
    }
    // 回收站彻底删除:确认弹窗明示不可恢复,确认后画板从 store 消失。
    await switchView(page, 'archived')
    await openCanvasMenu(page, 'Canvas A')
    await clickMenuItem(page, '彻底删除')
    const dialog = page.locator('.sidebar-confirm-dialog')
    await dialog.waitFor({ state: 'visible' })
    if (!(await dialog.textContent())?.includes('不可恢复')) {
      throw new Error('canvas permanent-delete dialog must say 不可恢复')
    }
    await dialog.locator('.sidebar-confirm-confirm').click()
    await wait()
    const state = await readState(page, canvasStoreSpec)
    const aId = Object.keys(state.canvasTitles).find((id) => state.canvasTitles[id] === 'Canvas A')
    if (aId) {
      throw new Error('Permanent delete should remove Canvas A from the store')
    }
    await switchView(page, 'active')

    // Guard(新范式):只剩一块 active 画板时归档被阻止(至少保留一个活跃画布)。
    await page.evaluate(async (spec) => {
      const { useCanvasStore } = await import(spec)
      const s = useCanvasStore.getState()
      const ids = Object.keys(s.canvases)
      for (const id of ids) {
        if (id !== s.sceneId) s.deleteCanvas(id)
      }
    }, await canvasStoreSpec())
    await wait()
    const guardState = await readState(page, canvasStoreSpec)
    const lastTitle = guardState.canvasTitles[guardState.sceneId]
    await openCanvasMenu(page, lastTitle)
    await clickMenuItem(page, '归档')
    const guardToast = page.locator('.toast-item').filter({ hasText: '至少保留一个活跃画布' })
    await guardToast.waitFor({ state: 'visible', timeout: 5000 })
    const after = await readState(page, canvasStoreSpec)
    if (Object.keys(after.canvasTitles).length !== 1) {
      throw new Error('Archive guard should have kept the last canvas')
    }
  }

  // --- 5. 项目删除新范式(PR-C2 P1-2):active 菜单无「删除项目」;归档 → 回收站
  //        彻底删除整树(含 canvas-count 文案) -----------------------------------
  {
    await resetState(page, canvasStoreSpec)
    const { projectId } = await setupState(page, canvasStoreSpec)
    await wait()
    // active 视图项目菜单不再暴露直接删除入口。
    await openProjectMenu(page, 'E2E Project')
    const labels = await menuLabels(page)
    if (labels.includes('删除项目')) {
      throw new Error(`active project menu must not expose direct delete: ${JSON.stringify(labels)}`)
    }
    if (!labels.includes('归档')) {
      throw new Error(`active project menu should expose archive: ${JSON.stringify(labels)}`)
    }
    await clickMenuItem(page, '归档')
    await wait()
    // 归档后:项目(连同级联归档的子画板)离开 active 视图;standalone survivor 仍在。
    if ((await branchFor(page, 'E2E Project').count()) !== 0) {
      throw new Error('archived project should leave the active view')
    }
    // 回收站彻底删除:确认文案含画板数 + 不可恢复;确认后整树从 store 移除(不回落 standalone)。
    await switchView(page, 'archived')
    await openProjectMenu(page, 'E2E Project')
    await clickMenuItem(page, '彻底删除')
    const dialog = page.locator('.sidebar-confirm-dialog')
    await dialog.waitFor({ state: 'visible' })
    const description = await dialog.locator('.sidebar-confirm-description').textContent()
    if (!description || !description.includes('2') || !description.includes('画板') || !description.includes('不可恢复')) {
      throw new Error(`Permanent-delete confirm copy should include canvas count + 画板 + 不可恢复: ${description}`)
    }
    await dialog.locator('.sidebar-confirm-confirm').click()
    await wait()
    const state = await readState(page, canvasStoreSpec)
    if (state.projects.some((p) => p.id === projectId)) {
      throw new Error('Permanent delete should remove the project entity')
    }
    const remainingTitles = Object.values(state.canvasTitles)
    if (remainingTitles.includes('Canvas A') || remainingTitles.includes('Canvas B')) {
      throw new Error('Permanent delete should remove the whole tree (no standalone fallback)')
    }
    if (!remainingTitles.includes('Canvas Standalone')) {
      throw new Error('Permanent delete must not touch canvases outside the project')
    }
    await switchView(page, 'active')
  }

  // --- 6. Collapse persistence + updatedAt ordering --------------------------
  {
    const { projectId } = await setupState(page, canvasStoreSpec)
    await wait()
    const projectRow = branchFor(page, 'E2E Project').locator('.project-row')
    await projectRow.waitFor({ state: 'visible' })
    await projectRow.click() // collapse
    await wait()
    let stored = await page.evaluate(() => {
      try { return window.localStorage.getItem('mivo.sidebar.collapsedProjects') } catch { return null }
    })
    if (!stored || !stored.includes(projectId)) {
      throw new Error(`Collapse should persist to localStorage: ${stored}`)
    }
    // Reload — collapse state survives. Wait for the sidebar (DOM, renderer-agnostic)
    // + the E2E Project row to confirm hydration landed on the persisted state
    // (waitForCanvasReady is unsuitable here: the persisted canvas is blank, no demo
    // image for dom mode / 0 expected children for leafer).
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('.project-sidebar').waitFor({ state: 'visible' })
    await branchFor(page, 'E2E Project').locator('.project-row').waitFor({ state: 'visible' })
    await wait()
    stored = await page.evaluate(() => {
      try { return window.localStorage.getItem('mivo.sidebar.collapsedProjects') } catch { return null }
    })
    if (!stored || !stored.includes(projectId)) {
      throw new Error(`Collapse should survive reload: ${stored}`)
    }
    // updatedAt ordering: make Canvas B newer than A → B floats to the top.
    await page.evaluate(async (spec) => {
      const { useCanvasStore } = await import(spec)
      const s = useCanvasStore.getState()
      const ids = Object.keys(s.canvases)
      const a = ids.find((id) => s.canvases[id].title === 'Canvas A')
      const b = ids.find((id) => s.canvases[id].title === 'Canvas B')
      if (a && b) {
        useCanvasStore.setState((state) => ({
          canvases: {
            ...state.canvases,
            [a]: { ...state.canvases[a], updatedAt: '2026-07-01T00:00:00.000Z' },
            [b]: { ...state.canvases[b], updatedAt: '2026-07-09T00:00:00.000Z' },
          },
        }))
      }
    }, await canvasStoreSpec())
    await wait()
    // Expand the project (it was collapsed) and read the canvas order from the DOM.
    const collapsedRow = branchFor(page, 'E2E Project').locator('.project-row')
    await collapsedRow.click()
    await wait()
    const titles = await branchFor(page, 'E2E Project').locator('.canvas-row-title').allTextContents()
    if (!titles.length || titles[0] !== 'Canvas B') {
      throw new Error(`Canvas list should be sorted by updatedAt desc (B first): ${JSON.stringify(titles)}`)
    }
  }
}
