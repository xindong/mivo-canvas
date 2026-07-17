// archive-project e2e — PR-C1 归档动作 + 级联 + CR-5 恢复选择性(PR-C2 回收站视图的前置动作)。
//
// 覆盖:右键【归档】项目 → 级联子画布 archived(archivedByCascade=true)+ standalone 不受影响
//   + 被动过滤(archived 项离开 active 主列表);unarchiveProject → CR-5 仅恢复级联归档的子画布,
//   用户单独归档的(archivedByCascade=false)保留归档态。store 侧 action 已就绪,本场景只验 UI 接线
//   + 级联语义 + active 过滤。CR-10(unarchiveCanvas 自动恢复父项目)在 archive-canvas.mjs 验。
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

// Create a known project + 3 canvases (2 in-project, 1 standalone). Returns ids.
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

const branchFor = (page, name) =>
  page.locator('.project-branch').filter({ hasText: name }).first()

const openProjectMenu = async (page, name) => {
  const row = branchFor(page, name).locator('.project-row')
  await row.waitFor({ state: 'visible' })
  await row.click({ button: 'right' })
  await page.locator('.sidebar-context-menu').waitFor({ state: 'visible' })
}

const clickMenuItem = async (page, text) => {
  await page.locator('.sidebar-context-menu-item').filter({ hasText: text }).click()
}

const archiveProjectViaStore = async (page, canvasStoreSpec, projectId) =>
  page.evaluate(async ({ spec, pid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().archiveProject(pid)
  }, { spec: await canvasStoreSpec(), pid: projectId })

const unarchiveProjectViaStore = async (page, canvasStoreSpec, projectId) =>
  page.evaluate(async ({ spec, pid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().unarchiveProject(pid)
  }, { spec: await canvasStoreSpec(), pid: projectId })

const archiveCanvasViaStore = async (page, canvasStoreSpec, canvasId) =>
  page.evaluate(async ({ spec, cid }) => {
    const { useCanvasStore } = await import(spec)
    useCanvasStore.getState().archiveCanvas(cid)
  }, { spec: await canvasStoreSpec(), cid: canvasId })

export const runArchiveProjectScenario = async (context) => {
  const { canvasUrl, canvasStoreSpec, page, rendererMode, wait } = context

  await page.goto(canvasUrl, { waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)

  // --- 1. Right-click【归档】→ cascade children + filtered from active view ---
  {
    const { projectId, standalone } = await setupState(page, canvasStoreSpec)
    await wait()
    await openProjectMenu(page, 'E2E Project')
    await clickMenuItem(page, '归档')
    await wait()
    // 归档成功 toast
    const toast = page.locator('.toast-item').filter({ hasText: '已归档项目' })
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    const state = await readState(page, canvasStoreSpec)
    const proj = state.projects.find((p) => p.id === projectId)
    if (proj?.status !== 'archived') {
      throw new Error(`project should be archived: ${JSON.stringify(proj)}`)
    }
    // CR-5/D3 级联:in-project 子画布全 archived + archivedByCascade=true
    const inProject = Object.entries(state.canvases).filter(([, c]) => c.projectId === projectId)
    if (inProject.length !== 2) {
      throw new Error(`expected 2 in-project canvases, got ${inProject.length}`)
    }
    if (!inProject.every(([, c]) => c.status === 'archived' && c.archivedByCascade === true)) {
      throw new Error(`cascade children should be archived+archivedByCascade=true: ${JSON.stringify(inProject)}`)
    }
    // standalone 不受影响
    const standaloneDoc = state.canvases[standalone]
    if (standaloneDoc?.status === 'archived') {
      throw new Error('standalone canvas should NOT be archived by project archive')
    }
    // active 视图过滤:archived 项目离开主列表
    if ((await branchFor(page, 'E2E Project').count()) !== 0) {
      throw new Error('archived project should be filtered out of the active sidebar')
    }
  }

  // --- 2. unarchiveProject → CR-5 仅恢复级联归档的子画布,单独归档的保留 ---
  {
    const { projectId, a, b } = await setupState(page, canvasStoreSpec)
    await wait()
    // 先单独归档 Canvas A(archivedByCascade=false),再归档项目(级联归档 B;A 已归档不动)
    await archiveCanvasViaStore(page, canvasStoreSpec, a)
    await wait()
    await archiveProjectViaStore(page, canvasStoreSpec, projectId)
    await wait()
    let state = await readState(page, canvasStoreSpec)
    const aBefore = state.canvases[a]
    const bBefore = state.canvases[b]
    if (aBefore.status !== 'archived' || aBefore.archivedByCascade !== false) {
      throw new Error(`directly-archived A should have archivedByCascade=false: ${JSON.stringify(aBefore)}`)
    }
    if (bBefore.status !== 'archived' || bBefore.archivedByCascade !== true) {
      throw new Error(`cascade-archived B should have archivedByCascade=true: ${JSON.stringify(bBefore)}`)
    }
    // unarchive project → CR-5:仅恢复 archivedByCascade=true(B),A 保留归档
    await unarchiveProjectViaStore(page, canvasStoreSpec, projectId)
    await wait()
    state = await readState(page, canvasStoreSpec)
    const proj = state.projects.find((p) => p.id === projectId)
    if (proj?.status !== 'active') {
      throw new Error(`project should be active after unarchive: ${JSON.stringify(proj)}`)
    }
    const aAfter = state.canvases[a]
    const bAfter = state.canvases[b]
    if (aAfter.status !== 'archived') {
      throw new Error(`CR-5: directly-archived A should STAY archived: ${JSON.stringify(aAfter)}`)
    }
    if (bAfter.status !== 'active' || bAfter.archivedByCascade !== false) {
      throw new Error(`CR-5: cascade-archived B should be restored to active: ${JSON.stringify(bAfter)}`)
    }
  }
}
