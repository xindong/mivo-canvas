// archive-canvas e2e — PR-C1 直接归档画布 + SC-4 归档活跃画布切 survivor + CR-10 unarchive 自动恢复父项目。
//
// 覆盖:① 直接归档(非活跃)画布 → archivedByCascade=false + 离开 active 主列表;② 归档当前打开画布
//   → sceneId 切到 active survivor(SC-4,镜像 deleteCanvas survivor);③ CR-10:archived 项目下
//   unarchive 子画布 → 自动 unarchive 父项目 + 级联恢复同辈(archivedByCascade=true)。
import { waitForCanvasReady } from '../renderer-evidence.mjs'

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

const setupState = async (page, canvasStoreSpec) => {
  await resetState(page, canvasStoreSpec)
  return page.evaluate(async (spec) => {
    const { useCanvasStore } = await import(spec)
    const state = useCanvasStore.getState()
    const projectId = state.createProject('E2E Project')
    const a = state.createCanvas('Canvas A', { projectId })
    const b = state.createCanvas('Canvas B', { projectId })
    const standalone = state.createCanvas('Canvas Standalone')
    return { projectId, a, b, standalone }
  }, await canvasStoreSpec())
}

const readState = async (page, canvasStoreSpec) =>
  page.evaluate(async (spec) => {
    const { useCanvasStore } = await import(spec)
    const { projects, canvases, sceneId } = useCanvasStore.getState()
    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
      canvases: Object.fromEntries(
        Object.entries(canvases).map(([id, doc]) => [
          id,
          { title: doc.title, projectId: doc.projectId, status: doc.status, archivedByCascade: doc.archivedByCascade },
        ]),
      ),
      sceneId,
    }
  }, await canvasStoreSpec())

const canvasRowFor = (page, title) =>
  page.locator('.canvas-row').filter({ hasText: title }).first()

const openCanvasMenu = async (page, title) => {
  const row = canvasRowFor(page, title)
  await row.waitFor({ state: 'visible' })
  await row.click({ button: 'right' })
  await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' })
}

const clickMenuItem = async (page, text) => {
  await page.locator('.sidebar-context-menu-item').filter({ hasText: text }).click()
}

const loadScene = async (page, canvasStoreSpec, canvasId) =>
  page.evaluate(async ({ spec, cid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().loadScene(cid)
  }, { spec: await canvasStoreSpec(), cid: canvasId })

const archiveCanvasViaStore = async (page, canvasStoreSpec, canvasId) =>
  page.evaluate(async ({ spec, cid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().archiveCanvas(cid)
  }, { spec: await canvasStoreSpec(), cid: canvasId })

const archiveProjectViaStore = async (page, canvasStoreSpec, projectId) =>
  page.evaluate(async ({ spec, pid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().archiveProject(pid)
  }, { spec: await canvasStoreSpec(), pid: projectId })

const unarchiveCanvasViaStore = async (page, canvasStoreSpec, canvasId) =>
  page.evaluate(async ({ spec, cid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().unarchiveCanvas(cid)
  }, { spec: await canvasStoreSpec(), cid: canvasId })

export const runArchiveCanvasScenario = async (context) => {
  const { canvasUrl, canvasStoreSpec, page, rendererMode, wait } = context

  await page.goto(canvasUrl, { waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)

  // --- 1. 直接归档(非活跃)画布 → archivedByCascade=false + 离开 active 主列表 ---
  {
    const { a } = await setupState(page, canvasStoreSpec)
    await wait()
    await openCanvasMenu(page, 'Canvas A')
    await clickMenuItem(page, '归档')
    await wait()
    const toast = page.locator('.toast-item').filter({ hasText: '已归档画板' })
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    const state = await readState(page, canvasStoreSpec)
    const aDoc = state.canvases[a]
    if (aDoc.status !== 'archived' || aDoc.archivedByCascade !== false) {
      throw new Error(`directly-archived canvas should be archived+archivedByCascade=false: ${JSON.stringify(aDoc)}`)
    }
    // active 视图过滤:Canvas A 行离开主列表
    if ((await canvasRowFor(page, 'Canvas A').count()) !== 0) {
      throw new Error('archived canvas should be filtered out of the active sidebar')
    }
  }

  // --- 2. 归档当前打开画布 → SC-4 sceneId 切到 active survivor ---
  {
    const { a, b, standalone } = await setupState(page, canvasStoreSpec)
    await wait()
    // 让 Canvas A 成为活跃画布(loadScene),再归档它 → survivor 应为另一 active 画布。
    await loadScene(page, canvasStoreSpec, a)
    await wait()
    let state = await readState(page, canvasStoreSpec)
    if (state.sceneId !== a) {
      throw new Error(`precondition: sceneId should be A (${a}), got ${state.sceneId}`)
    }
    await archiveCanvasViaStore(page, canvasStoreSpec, a)
    await wait()
    state = await readState(page, canvasStoreSpec)
    // SC-4:sceneId 不应仍指向已归档的 A
    if (state.sceneId === a) {
      throw new Error('SC-4: sceneId must switch away from the archived active canvas')
    }
    // 切到的 survivor 必须是 active 画布(B 或 standalone)
    const survivor = state.canvases[state.sceneId]
    if (!survivor || survivor.status === 'archived') {
      throw new Error(`SC-4: survivor must be an active canvas, got ${JSON.stringify(survivor)}`)
    }
    // A 仍 archived + archivedByCascade=false(直接归档,非级联)
    const aDoc = state.canvases[a]
    if (aDoc.status !== 'archived' || aDoc.archivedByCascade !== false) {
      throw new Error(`archived A should be archived+archivedByCascade=false: ${JSON.stringify(aDoc)}`)
    }
  }

  // --- 3. CR-10:archived 项目下 unarchive 子画布 → 自动 unarchive 父项目 + 级联恢复同辈 ---
  {
    const { projectId, a, b, standalone } = await setupState(page, canvasStoreSpec)
    await wait()
    // 让 A 活跃,归档项目(级联归档 A、B;sceneId 切 survivor=standalone)
    await loadScene(page, canvasStoreSpec, a)
    await wait()
    await archiveProjectViaStore(page, canvasStoreSpec, projectId)
    await wait()
    let state = await readState(page, canvasStoreSpec)
    const projBefore = state.projects.find((p) => p.id === projectId)
    if (projBefore?.status !== 'archived') throw new Error(`precondition: project should be archived: ${JSON.stringify(projBefore)}`)
    const aBefore = state.canvases[a]
    const bBefore = state.canvases[b]
    if (aBefore.status !== 'archived' || aBefore.archivedByCascade !== true) throw new Error(`A should be cascade-archived: ${JSON.stringify(aBefore)}`)
    if (bBefore.status !== 'archived' || bBefore.archivedByCascade !== true) throw new Error(`B should be cascade-archived: ${JSON.stringify(bBefore)}`)
    // unarchiveCanvas(A) → CR-10:父项目自动恢复 + 级联同辈(B)恢复 + A active
    await unarchiveCanvasViaStore(page, canvasStoreSpec, a)
    await wait()
    state = await readState(page, canvasStoreSpec)
    const projAfter = state.projects.find((p) => p.id === projectId)
    if (projAfter?.status !== 'active') {
      throw new Error(`CR-10: parent project should auto-unarchive: ${JSON.stringify(projAfter)}`)
    }
    const aAfter = state.canvases[a]
    const bAfter = state.canvases[b]
    if (aAfter.status !== 'active') {
      throw new Error(`CR-10: unarchived canvas A should be active: ${JSON.stringify(aAfter)}`)
    }
    if (bAfter.status !== 'active' || bAfter.archivedByCascade !== false) {
      throw new Error(`CR-10: cascade-archived sibling B should be restored to active: ${JSON.stringify(bAfter)}`)
    }
  }

  // --- 4. 零 survivor:最后一个 active canvas 禁止归档 ---
  {
    await resetState(page, canvasStoreSpec)
    await wait()
    await archiveCanvasViaStore(page, canvasStoreSpec, 'e2e-reset')
    await wait()
    const state = await readState(page, canvasStoreSpec)
    if (state.canvases['e2e-reset']?.status === 'archived' || state.sceneId !== 'e2e-reset') {
      throw new Error(`zero-survivor archiveCanvas must be blocked: ${JSON.stringify(state)}`)
    }
    await page.locator('.toast-item.warning')
      .filter({ hasText: '至少保留一个活跃画布' })
      .waitFor({ state: 'visible', timeout: 5000 })
  }
}
