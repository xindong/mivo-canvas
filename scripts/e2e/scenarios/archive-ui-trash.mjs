// archive-ui-trash e2e — PR-C2 两态回收站视图 + 恢复 + 彻底删除。
// 覆盖：active/archived 列表互斥、回收站菜单边界、CR-10 子画布恢复父项目、
// “不可恢复”确认文案，以及彻底删除后两态列表均不可见。
import { waitForCanvasReady } from '../renderer-evidence.mjs'

const ids = {
  activeProject: 'e2e-active-project',
  archivedProject: 'e2e-archived-project',
  trashProject: 'e2e-trash-project',
  activeCanvas: 'e2e-active-canvas',
  directArchivedCanvas: 'e2e-direct-archived-canvas',
  cascadeArchivedCanvas: 'e2e-cascade-archived-canvas',
  trashProjectCanvas: 'e2e-trash-project-canvas',
  trashCanvas: 'e2e-trash-canvas',
}

const setupState = async (page, canvasStoreSpec) =>
  page.evaluate(async ({ spec, seedIds }) => {
    const { useCanvasStore } = await import(spec)
    const now = '2026-07-18T10:00:00.000Z'
    const document = (title, projectId, status = 'active', archivedByCascade = false) => ({
      title,
      projectId,
      status,
      archivedByCascade,
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })

    useCanvasStore.setState({
      projects: [
        { id: seedIds.activeProject, name: 'Active Project', createdAt: now, status: 'active' },
        { id: seedIds.archivedProject, name: 'Archived Project', createdAt: now, status: 'archived' },
        { id: seedIds.trashProject, name: 'Trash Project', createdAt: now, status: 'archived' },
      ],
      canvases: {
        [seedIds.activeCanvas]: document('Active Canvas', seedIds.activeProject),
        [seedIds.directArchivedCanvas]: document('Direct Archived', seedIds.archivedProject, 'archived', false),
        [seedIds.cascadeArchivedCanvas]: document('Cascade Archived', seedIds.archivedProject, 'archived', true),
        [seedIds.trashProjectCanvas]: document('Trash Project Canvas', seedIds.trashProject, 'archived', true),
        [seedIds.trashCanvas]: document('Trash Canvas', undefined, 'archived', false),
      },
      sceneId: seedIds.activeCanvas,
      nodes: [],
      edges: [],
      tasks: [],
      selectedNodeId: undefined,
      selectedNodeIds: [],
    })
  }, { spec: await canvasStoreSpec(), seedIds: ids })

const readState = async (page, canvasStoreSpec) =>
  page.evaluate(async (spec) => {
    const { useCanvasStore } = await import(spec)
    const { projects, canvases } = useCanvasStore.getState()
    return {
      projects: projects.map((project) => ({ id: project.id, status: project.status })),
      canvases: Object.fromEntries(
        Object.entries(canvases).map(([id, document]) => [id, {
          status: document.status,
          archivedByCascade: document.archivedByCascade,
          projectId: document.projectId,
        }]),
      ),
    }
  }, await canvasStoreSpec())

const projectRow = (page, name) => page.locator('.project-row').filter({ hasText: name }).first()
const canvasRow = (page, title) => page.locator('.canvas-row').filter({ hasText: title }).first()
const switchView = async (page, filterView) => {
  await page.locator(`[data-filter-view="${filterView}"]`).click()
  await page.waitForFunction(
    (view) => document.querySelector(`[data-filter-view="${view}"]`)?.getAttribute('aria-pressed') === 'true',
    filterView,
  )
}
const openMenu = async (row) => {
  await row.waitFor({ state: 'visible' })
  await row.click({ button: 'right' })
  await row.page().locator('.sidebar-context-menu').waitFor({ state: 'visible' })
}
const menuLabels = async (page) => page.locator('.sidebar-context-menu-item').allTextContents()
const chooseMenu = async (page, label) =>
  page.locator('.sidebar-context-menu-item').filter({ hasText: label }).click()

const assertGoneFromBothViews = async (page, rowFactory) => {
  await switchView(page, 'active')
  if ((await rowFactory().count()) !== 0) throw new Error('deleted item leaked into active view')
  await switchView(page, 'archived')
  if ((await rowFactory().count()) !== 0) throw new Error('deleted item leaked into archived view')
}

export const runArchiveUiTrashScenario = async (context) => {
  const { canvasUrl, canvasStoreSpec, page, rendererMode, wait } = context

  await page.goto(canvasUrl, { waitUntil: 'networkidle' })
  await waitForCanvasReady(page, rendererMode)
  await setupState(page, canvasStoreSpec)
  await wait()

  // SC-1：active 视图无 archived，archived 视图仅 archived。
  if ((await projectRow(page, 'Active Project').count()) !== 1 || (await canvasRow(page, 'Active Canvas').count()) !== 1) {
    throw new Error('active view should contain active project/canvas')
  }
  if ((await projectRow(page, 'Archived Project').count()) !== 0 || (await canvasRow(page, 'Trash Canvas').count()) !== 0) {
    throw new Error('active view must exclude archived records')
  }

  await switchView(page, 'archived')
  if ((await projectRow(page, 'Active Project').count()) !== 0 || (await canvasRow(page, 'Active Canvas').count()) !== 0) {
    throw new Error('archived view must exclude active records')
  }
  if ((await projectRow(page, 'Archived Project').count()) !== 1 || (await canvasRow(page, 'Trash Canvas').count()) !== 1) {
    throw new Error('archived view should contain archived project/canvas')
  }

  // SC-3：回收站 Row 只允许恢复/彻底删除，不得暴露改名/新建/移动/复制。
  await openMenu(projectRow(page, 'Archived Project'))
  let labels = await menuLabels(page)
  if (!labels.includes('恢复') || !labels.includes('彻底删除')) {
    throw new Error(`archived project menu missing restore/delete: ${JSON.stringify(labels)}`)
  }
  if (labels.some((label) => ['重命名', '在此项目新建画板', '移动到项目', '复制画板'].includes(label))) {
    throw new Error(`archived project menu exposes forbidden action: ${JSON.stringify(labels)}`)
  }
  await page.keyboard.press('Escape')

  await openMenu(canvasRow(page, 'Direct Archived'))
  labels = await menuLabels(page)
  if (!labels.includes('恢复') || !labels.includes('彻底删除')) {
    throw new Error(`archived canvas menu missing restore/delete: ${JSON.stringify(labels)}`)
  }
  if (labels.some((label) => ['重命名', '在此项目新建画板', '移动到项目', '复制画板'].includes(label))) {
    throw new Error(`archived canvas menu exposes forbidden action: ${JSON.stringify(labels)}`)
  }

  // SC-2：直接恢复 archived canvas，CR-10 自动恢复父项目及 cascade sibling；切 active 后均可见。
  await chooseMenu(page, '恢复')
  await wait()
  let state = await readState(page, canvasStoreSpec)
  const restoredProject = state.projects.find((project) => project.id === ids.archivedProject)
  if (restoredProject?.status !== 'active') throw new Error('CR-10 should auto-unarchive parent project')
  if (state.canvases[ids.directArchivedCanvas]?.status !== 'active') throw new Error('restored canvas should be active')
  if (
    state.canvases[ids.cascadeArchivedCanvas]?.status !== 'active' ||
    state.canvases[ids.cascadeArchivedCanvas]?.archivedByCascade !== false
  ) {
    throw new Error('CR-10 should restore cascade-archived sibling')
  }
  await switchView(page, 'active')
  if (
    (await projectRow(page, 'Archived Project').count()) !== 1 ||
    (await canvasRow(page, 'Direct Archived').count()) !== 1 ||
    (await canvasRow(page, 'Cascade Archived').count()) !== 1
  ) {
    throw new Error('restored project tree should appear in active view')
  }

  // SC-3：项目/画板彻底删除弹窗都明示“不可恢复”，确认后记录从 store 与两态列表消失。
  await switchView(page, 'archived')
  await openMenu(projectRow(page, 'Trash Project'))
  await chooseMenu(page, '彻底删除')
  const projectDialog = page.locator('.sidebar-confirm-dialog')
  await projectDialog.waitFor({ state: 'visible' })
  if (!(await projectDialog.textContent())?.includes('不可恢复')) {
    throw new Error('project permanent-delete dialog must say 不可恢复')
  }
  await projectDialog.locator('.sidebar-confirm-confirm').click()
  await wait()
  state = await readState(page, canvasStoreSpec)
  if (state.projects.some((project) => project.id === ids.trashProject)) {
    throw new Error('permanently deleted project must leave the live store')
  }
  if (state.canvases[ids.trashProjectCanvas] !== undefined) {
    throw new Error('permanently deleted project must remove its archived child tree')
  }
  await assertGoneFromBothViews(page, () => projectRow(page, 'Trash Project'))
  await assertGoneFromBothViews(page, () => canvasRow(page, 'Trash Project Canvas'))

  await openMenu(canvasRow(page, 'Trash Canvas'))
  await chooseMenu(page, '彻底删除')
  const canvasDialog = page.locator('.sidebar-confirm-dialog')
  await canvasDialog.waitFor({ state: 'visible' })
  if (!(await canvasDialog.textContent())?.includes('不可恢复')) {
    throw new Error('canvas permanent-delete dialog must say 不可恢复')
  }
  await canvasDialog.locator('.sidebar-confirm-confirm').click()
  await wait()
  state = await readState(page, canvasStoreSpec)
  if (state.canvases[ids.trashCanvas] !== undefined) {
    throw new Error('permanently deleted canvas must leave the live store')
  }
  await assertGoneFromBothViews(page, () => canvasRow(page, 'Trash Canvas'))
}
