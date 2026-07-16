// projectsSlice — Project as a first-class entity (Phase 1 / C1·C2·C7).
//
// A CanvasProject is a named grouping owned by the canvas store; canvases attach
// via the existing `CanvasDocument.projectId`. CRUD lives here so the UI layer
// (sidebar rows / context menus) can stay thin. Logging follows the project
// invariant: every user-visible outcome hits debugLogger (log on success, warn
// on skip); the UI layer adds toastFeedback for create/rename/delete where the
// user benefits from immediate acknowledgement (see Phase 5).
import type { SliceCreator } from './canvasStateTypes'
import { logCanvas, warnCanvas } from './canvasStoreLog'
import { DEMO_PROJECTS } from './demoScenes'
import { enqueuePersistWrite, isPersistWriteActive } from '../lib/persistBoot'
import { normalizeDocument, documentFor } from './canvasDocumentModel'
// Phase 1 项4(复活加固):store delete action 发起时写持久 tombstone(与队列记录生死解耦,覆盖溢出驱逐/重试
//   耗尽离队后 pending-delete 失效的复活)。详见 src/lib/deletionTombstones.ts。
import { recordDeletionTombstone } from '../lib/deletionTombstones'

// Project ids use a `project-` prefix (distinct from `canvas-` / `group-`) so a
// projectId is never confused with a canvasId. Mirrors createCanvasId's fallback
// when crypto.randomUUID is unavailable.
export const createProjectId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `project-${crypto.randomUUID()}`
  }
  return `project-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const nowIso = () => new Date().toISOString()

const DEFAULT_PROJECT_NAME = 'Untitled Project'

export const createProjectsSlice: SliceCreator = (set, get) => ({
  // Fresh default state seeds the two demo projects (Concept Battlepass /
  // 商品图方向) so the sidebar shows the demo grouping on a clean install.
  // A copy per store creation so slice mutations never touch the shared constant.
  // v9→v10 migration re-seeds the same projects (canvasGenerationHydration); v10+
  // persisted state is used as-is so user-deleted demo projects do not revive.
  projects: DEMO_PROJECTS.map((project) => ({ ...project })),
  createProject: (name) => {
    const id = createProjectId()
    const trimmed = name?.trim() || DEFAULT_PROJECT_NAME

    set((state) => ({
      projects: [...state.projects, { id, name: trimmed, createdAt: nowIso() }],
    }))

    logCanvas(`Created project "${trimmed}" (${id})`)
    // G1-a P1-1:server/shadow 模式 enqueue createProject(POST 幂等,带本地 id);local no-op。
    enqueuePersistWrite({ kind: 'createProject', name: trimmed, id })
    return id
  },
  renameProject: (projectId, name) => {
    const trimmed = name.trim()
    if (!trimmed) {
      warnCanvas(`Rename project skipped: empty name (${projectId})`)
      return
    }

    const existing = get().projects.find((p) => p.id === projectId)
    if (!existing) {
      warnCanvas(`Rename project skipped: missing project ${projectId}`)
      return
    }

    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, name: trimmed } : project,
      ),
    }))

    logCanvas(`Renamed project "${existing.name}" to "${trimmed}" (${projectId})`)
    // G1-a P1-1:server/shadow 模式 enqueue updateProject(PATCH,If-Match = server hydrate 带来的 revision);
    // demo/local 项目 revision 缺省 → 428 rejected(fail-visible:demo 不在 server,需先 create)。
    enqueuePersistWrite({
      kind: 'updateProject',
      projectId,
      name: trimmed,
      baseRevision: existing.revision,
    })
  },
  deleteProject: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId)
    if (!project) {
      warnCanvas(`Delete project skipped: missing project ${projectId}`)
      return { status: 'skipped', reason: 'missing' }
    }

    // A2 前置 b / soft-delete-semantics.md §6:对齐服务端整树软删语义。
    //   server 模式(queue active,isPersistWriteActive)→ 从本地 store 移除 project + 其下所有 canvas
    //     (服务端 softDeleteProjectTree 已级联软删 project+canvas+chat-collection+share_links;hydrate
    //     不再返回它们 → 刷新不复现"迁回 standalone")。restore 经 restoreProject(POST ensureCreate →
    //     restoreProjectTree 整树复活)。content(nodes/edges)全量 hydrate 属 G1-c/阶段4,本轮删除的画板
    //     content 随本地 store 移除(阶段4 content 持久化后,restore 整树含 content)——已知 phase-1 gap。
    //   local 模式(queue inert)→ 保留旧 standalone 回落(画板 body 保留,projectId→undefined)。
    //     软删基础设施仅服务端有;local 不具备可恢复软删,"standalone 回落理由消失"以软删落地为前提,
    //     local 无软删 → 保留回落防 IDB 数据丢失(决策 §6 目标针对服务端软删落地后的行为)。
    // P1-2(sol 返修):server 模式删完须维护 active-document 不变量——active canvas 被删时原子切首个
    //   存活 canvas 并同步顶层 flattened document(nodes/edges/tasks/selection/tool/history),否则 sceneId
    //   指向已删 document → 顶层 state 悬空 → 后续 generation/mask 读 canvases[sceneId] 崩。无 survivor
    //   (删完会零 canvas)→ 按 ≥1 canvas 不变量阻止删除(soft-delete-semantics.md:128 guard;不自动建
    //   fallback 避免副作用,用户先移画板到其他项目再删)。local 模式无此问题(画板 standalone 回落)。
    // 函数式 set:与 createProject/renameProject 一致,不用外层 snapshot,避免并发 set 间丢更新。
    const serverAligned = isPersistWriteActive()
    let removedCanvasIds: string[] = []
    let blockedNoSurvivor = false
    set((state) => {
      removedCanvasIds = []
      blockedNoSurvivor = false
      if (!serverAligned) {
        // local: cascade canvases to standalone (body 保留,projectId→undefined)
        const canvases = Object.fromEntries(
          Object.entries(state.canvases).map(([canvasId, document]) => {
            if (document.projectId === projectId) {
              removedCanvasIds.push(canvasId)
              return [canvasId, { ...document, projectId: undefined }]
            }
            return [canvasId, document]
          }),
        )
        return { projects: state.projects.filter((p) => p.id !== projectId), canvases }
      }
      // server: collect removed canvas ids + remove from store (soft-deleted server-side; restorable via restoreProject)
      removedCanvasIds = Object.entries(state.canvases)
        .filter(([, document]) => document.projectId === projectId)
        .map(([canvasId]) => canvasId)
      const survivingEntries = Object.entries(state.canvases).filter(
        ([, document]) => document.projectId !== projectId,
      )
      // P1-2:无 survivor → 阻止删除(≥1 canvas 不变量;返 {} 不改 state,blockedNoSurvivor 标记外层 warn+return)
      if (survivingEntries.length === 0) {
        blockedNoSurvivor = true
        return {}
      }
      const canvases = Object.fromEntries(survivingEntries)
      // P1-2:active canvas 未被删 → 只移除 project+canvases,sceneId/顶层 state 不动
      if (!removedCanvasIds.includes(state.sceneId)) {
        return { projects: state.projects.filter((p) => p.id !== projectId), canvases }
      }
      // P1-2:active canvas 被删 → 原子切首个存活 canvas + 同步顶层 flattened document/tool/history
      const survivorId = survivingEntries[0][0]
      const survivorDoc = normalizeDocument(documentFor(canvases, survivorId))
      return {
        projects: state.projects.filter((p) => p.id !== projectId),
        canvases,
        sceneId: survivorId,
        nodes: survivorDoc.nodes,
        edges: survivorDoc.edges || [],
        tasks: survivorDoc.tasks,
        selectedNodeId: survivorDoc.selectedNodeId,
        selectedNodeIds: survivorDoc.selectedNodeIds || [],
        activeTool: 'select',
        historyPast: [],
        historyFuture: [],
      }
    })

    // P1-2:无 survivor 阻止删除——warn + return(不 enqueue,不动 store/server)
    if (blockedNoSurvivor) {
      warnCanvas(
        `Delete project "${project.name}" blocked: would leave zero canvases (≥1 canvas invariant; soft-delete-semantics.md:128). Move canvases to another project before deleting.`,
      )
      return { status: 'blocked', reason: 'no-survivor' }
    }

    logCanvas(
      serverAligned
        ? `Deleted project "${project.name}" (${projectId}); ${removedCanvasIds.length} canvas(es) removed (server whole-tree soft-delete; restorable via restoreProject)`
        : `Deleted project "${project.name}" (${projectId}); ${removedCanvasIds.length} canvas(es) returned to standalone`,
    )
    // G1-a P1-1:server/shadow 模式 enqueue deleteProject(DELETE 幂等;服务端 softDeleteProjectTree 整树级联)。local no-op。
    enqueuePersistWrite({ kind: 'deleteProject', projectId })
    // A2 前置 b:server 模式为被移除画板 enqueue deleteCanvas ——
    //   ① 若画板有 pending createCanvas(未 drain),createCanvas+deleteCanvas 经 combineOps 净消,防
    //      parent 软删后 createCanvas 撞 404 unknown-project terminal(避免 A3 rejected/dead-letter 假阳性);
    //   ② 若画板已 drain(在 server),DELETE 幂等 204(softDeleteProjectTree 已级联软删,幂等无副作用)。
    if (serverAligned) {
      // Phase 1 项4:server 模式发起删除时写 tombstone(project + 其级联 canvas)。与队列记录生死解耦 ——
      //   DELETE 离队(重试耗尽 terminal / 队列溢出驱逐)后 pending-delete 差集过滤失效,tombstone 接力挡
      //   复活(hydrate step1/step2 并集 tombstone 过滤)。local 模式(serverAligned=false)无 hydrate/无复活,
      //   不写(避免 IDB 积累永不清的 tombstone)。fire-and-forget(recordDeletionTombstone 内部 best-effort,
      //   永不 throw);catch 兜底防 reject 逸出。clear 时机 = onOutcome DELETE 终态 success(persistBoot)。
      void recordDeletionTombstone('project', projectId).catch((e) =>
        warnCanvas(`tombstone record failed (project ${projectId}): ${e instanceof Error ? e.message : String(e)}`),
      )
      for (const canvasId of removedCanvasIds) {
        enqueuePersistWrite({ kind: 'deleteCanvas', canvasId })
        void recordDeletionTombstone('canvas', canvasId).catch((e) =>
          warnCanvas(`tombstone record failed (canvas ${canvasId}): ${e instanceof Error ? e.message : String(e)}`),
        )
      }
    }
    return { status: 'deleted' }
  },
  restoreProject: (projectId, name) => {
    const existing = get().projects.find((p) => p.id === projectId)
    if (existing) {
      warnCanvas(`Restore project skipped: already exists ${projectId}`)
      return
    }

    // A2 前置 b:restore 整树——本地重加 project(可见),enqueue createProject(POST /api/projects
    // 带被软删的 id → ensureCreate 命中 deleted → restoreProjectTree 原子恢复 project + 其 canvas meta
    // + chat-collection + share_links)。drain 后 hydrate 整树回填(画板 meta 回;content 全量 hydrate 属
    // G1-c/阶段4)。决策 §5.2 restore 原子性由服务端 restoreProjectTree 事务保证;前端只触发 + 回填。
    const trimmed = name?.trim() || DEFAULT_PROJECT_NAME
    set((state) => ({
      projects: [...state.projects, { id: projectId, name: trimmed, createdAt: nowIso() }],
    }))

    logCanvas(`Restored project "${trimmed}" (${projectId}; server restoreProjectTree via POST ensureCreate)`)
    // createProject POST 幂等:命中 deleted → restored(整树);命中 live → existing(no-op);missing → created。
    enqueuePersistWrite({ kind: 'createProject', name: trimmed, id: projectId })
  },
})
