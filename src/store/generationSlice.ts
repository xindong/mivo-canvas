import type {
  CanvasEdge,
  CanvasId,
  CanvasTask,
  MivoCanvasNode,
  MivoCanvasSnapshot,
} from '../types/mivoCanvas'
import type { SliceCreator } from './canvasStore'
import type { VariationParam, NormalizedMaskBounds } from '../types/generation'
import { MivoImageRequestError, assetBlobForNode } from '../lib/mivoImageClient'
import {
  cancelTask,
  kindForFailedTask,
  pollTask,
  submitEditTask,
  submitGenerationTask,
  submitVariationsTask,
  taskPollIntervalMs,
  type TaskFailure,
  type TaskResultImage,
} from '../lib/mivoTaskClient'
import { errorCanvas, logCanvas, warnCanvas } from './canvasStore'
import { createEdgeId, createNodeId, edgeTypeForOperation } from './nodeFactory'
import {
  defaultDocument,
  nodePrompt,
  patchCanvasDocument,
  rollbackLatestHistoryBaseline,
} from './canvasDocumentModel'

const defaultMivoImageModel = 'gpt-image-2'
const upsertTask = (tasks: CanvasTask[], task: CanvasTask) => [
  task,
  ...tasks.filter((item) => item.id !== task.id),
].slice(0, 5)

// P1 fix (rev-behavior): failed/canceled tasks preserve the last observed progress
// (not hardcoded 100), matching the server contract "失败/取消停在最后值". The caller
// passes the LIVE task (read from the store at catch time) so its progress reflects
// the last patchRunning sample — the stale `runningTask` (progress 0) is NOT used.
const failedTask = (task: CanvasTask, label: string): CanvasTask => ({
  ...task,
  label,
  status: 'failed',
})

const canceledTask = (task: CanvasTask, label: string): CanvasTask => ({
  ...task,
  label,
  status: 'canceled',
})

const doneTask = (task: CanvasTask, label: string, nodeIds: string[]): CanvasTask => ({
  ...task,
  label,
  status: 'done',
  progress: 100,
  nodeIds,
})

const isCanceledGenerationError = (error: unknown, signal?: AbortSignal) =>
  Boolean(signal?.aborted) || (error instanceof MivoImageRequestError && error.kind === 'canceled')

// P2-C2: default variation params when the caller doesn't pass explicit ones
// (e.g. the InspectorPanel "Make variations" button). 4 variations reusing the
// source's prompt — matches the prior mock's "4 方向" intent. Explicit params
// (e2e N=3 with 2 success + 1 failure) override.
const defaultVariationParams = (fallbackPrompt: string): VariationParam[] =>
  Array.from({ length: 4 }, () => ({ prompt: fallbackPrompt }))

// P2-C2: create a visible "failed slot" ai-slot node for a variation that didn't
// settle successfully. Placed in a grid beside the source (mirrors the prior mock's
// variant grid). The node carries the variation prompt + desensitized error so the
// UI can render a marked-red slot ("失败槽位可见").
const createFailedVariationSlot = (
  source: MivoCanvasNode,
  failure: TaskFailure,
  prompt: string,
  model: string,
  taskId: string,
): { node: MivoCanvasNode; edge: CanvasEdge } => {
  const index = failure.variationIndex
  const createdAt = Date.now()
  const col = index % 2
  const row = Math.floor(index / 2)
  const id = createNodeId('variation-failed')
  const node: MivoCanvasNode = {
    id,
    type: 'ai-slot',
    title: `Variation ${index + 1} 失败`,
    x: source.x + source.width + 90 + col * 236,
    y: source.y + row * 404,
    width: 204,
    height: 362,
    status: 'failed',
    text: failure.error,
    sourceNodeId: source.id,
    groupId: `variation-${taskId}`,
    generation: { prompt, model, createdAt, taskId, strength: 0.58 },
    aiWorkflow: { kind: 'slot', status: 'failed', operation: 'variation', prompt, sourceNodeIds: [source.id] },
  }
  const edge: CanvasEdge = { id: createEdgeId(), from: source.id, to: id, type: 'generate', prompt, createdAt }
  return { node, edge }
}

// P2-C2: normalize an annotation node's canvas-coordinate annotationBounds to the
// source image's relative 0-1 maskBounds (BFF synthesizes the area mask PNG from
// this). Returns undefined when the annotation has no bounds (whole-image edit).
const normalizeAnnotationBounds = (
  source: MivoCanvasNode,
  annotation: MivoCanvasNode,
): NormalizedMaskBounds | undefined => {
  const bounds = annotation.annotationBounds
  if (!bounds || source.width <= 0 || source.height <= 0) return undefined
  return {
    x: (bounds.x - source.x) / source.width,
    y: (bounds.y - source.y) / source.height,
    width: bounds.width / source.width,
    height: bounds.height / source.height,
  }
}

// P2-C1b: one-time idempotency key per generation call. Retries (new action
// invocation) get a new key → new server task. Same-call re-submission (e.g. a
// transient POST timeout retried by the client) would reuse the key and dedupe
// server-side within the process lifetime. We don't currently retry in-action,
// so this is forward-compatible plumbing, not a retry loop.
const newIdempotencyKey = (): string => {
  const crypto = globalThis.crypto as Crypto | undefined
  if (crypto?.randomUUID) return crypto.randomUUID()
  return `mivo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// Sleep that rejects with MivoImageRequestError(kind='canceled') if the signal
// aborts mid-wait — so the poll loop's await sleep() surfaces cancel promptly
// without waiting for the next GET.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MivoImageRequestError('图片请求已取消。', 'canceled'))
      return
    }
    const onAbort = () => {
      window.clearTimeout(id)
      reject(new MivoImageRequestError('图片请求已取消。', 'canceled'))
    }
    const id = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

// P2-C1b: poll loop shared by the 3 real generation actions + P2-C2 variations.
// Submits already happened (serverTaskId in hand). Upserts the running task with
// the server's real progress/stage on each non-terminal poll. Returns nodeIds on
// done/partial (after onResult commits). Throws MivoImageRequestError on
// failed/canceled/unknown — the caller's catch sets the terminal task state and
// rethrows.
//
// Terminal-state mapping (per server/contracts/tasks-async.md):
//   done     → return nodeIds (caller sets doneTask)
//   partial  → return nodeIds (P2-C2 variations; onResult gets failures[] too;
//              the caller sets doneTask — partial resolves the success subset,
//              does NOT reject. Failures are surfaced via the task record.)
//   failed   → throw MivoImageRequestError(message, kindForFailedTask(message))
//              so chatStore.errorInfoForChat still classifies timeouts (怪癖 6)
//   canceled → throw canceled (caller sets canceledTask, never commits)
//   unknown  → throw 'task expired, retry' (server restarted; never commits)
const runTaskPollLoop = async (
  set: Parameters<SliceCreator>[0],
  args: {
    serverTaskId: string
    signal: AbortSignal | undefined
    localTask: CanvasTask
    sceneId: CanvasId
    onResult: (result: { images: TaskResultImage[]; failures?: TaskFailure[] }) => Promise<string[]>
  },
): Promise<string[]> => {
  const patchRunning = (progress: number, stage: string) =>
    set((current) => {
      const doc = current.canvases[args.sceneId]
      if (!doc) return {}
      return patchCanvasDocument(current, args.sceneId, {
        tasks: upsertTask(doc.tasks, { ...args.localTask, progress, stage, status: 'running' }),
      })
    })

  for (;;) {
    if (args.signal?.aborted) {
      throw new MivoImageRequestError('图片请求已取消。', 'canceled')
    }
    const view = await pollTask(args.serverTaskId, args.signal)

    if (view.status === 'running' || view.status === 'pending') {
      patchRunning(view.progress, view.stage)
      await sleep(taskPollIntervalMs(), args.signal)
      continue
    }
    if (view.status === 'done') {
      const images = view.result?.images ?? []
      return args.onResult({ images, failures: undefined })
    }
    // P2-C2: partial — variations batch where some edits succeeded. Resolve the
    // success subset (onResult commits it); failures[] travel along for the
    // caller to surface. Does NOT reject (only all-fail → failed → throws).
    if (view.status === 'partial') {
      const images = view.result?.images ?? []
      return args.onResult({ images, failures: view.failures })
    }
    if (view.status === 'failed') {
      const message = view.error || 'Generation failed'
      throw new MivoImageRequestError(message, kindForFailedTask(message))
    }
    if (view.status === 'canceled') {
      throw new MivoImageRequestError('图片请求已取消。', 'canceled')
    }
    // unknown — server restarted / task evicted. Never commit; surface retry.
    throw new MivoImageRequestError('任务已失效（服务端重启），请重试。', 'upstream-error')
  }
}

export const createGenerationSlice: SliceCreator = (set, get) => ({
  tasks: defaultDocument.tasks,
  generateVariations: async (sourceNodeId, variations, options = {}) => {
    const targetSceneId = options.sceneId || get().sceneId
    const state = get()
    const document = state.canvases[targetSceneId]
    if (!document) throw new Error('目标画布已删除，无法继续生成。')
    const source =
      (sourceNodeId
        ? document.nodes.find((node) => node.id === sourceNodeId && node.type === 'image' && !node.hidden)
        : undefined) ||
      document.nodes.find((node) => node.id === document.selectedNodeId && node.type === 'image' && !node.hidden) ||
      document.nodes.find((node) => node.type === 'image' && !node.hidden)
    if (sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')
    if (!source) throw new Error('没有可用的源图，无法生成变体。')

    const basePrompt = source.generation?.prompt || nodePrompt(source) || '基于当前参考图继续发散'
    const variationParams =
      variations && variations.length > 0
        ? variations.slice(0, 4)
        : defaultVariationParams(basePrompt)
    const count = variationParams.length
    const model = (variationParams[0]?.model || source.generation?.model || defaultMivoImageModel) as string
    const taskId = createNodeId('task-variations')
    const runningTask: CanvasTask = {
      id: taskId,
      label: `变体生成：${source.title}（${count} 个）`,
      status: 'running',
      progress: 0,
      nodeIds: [],
    }

    set((current) => {
      const doc = current.canvases[targetSceneId]
      if (!doc) return {}
      return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(doc.tasks, runningTask) })
    })

    let serverTaskId: string | undefined
    try {
      if (options.signal?.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const image = await assetBlobForNode(source)
      serverTaskId = (
        await submitVariationsTask({
          image,
          variations: variationParams,
          idempotencyKey: newIdempotencyKey(),
          signal: options.signal,
        })
      ).taskId
      const nodeIds = await runTaskPollLoop(set, {
        serverTaskId,
        signal: options.signal,
        localTask: runningTask,
        sceneId: targetSceneId,
        onResult: async ({ images, failures }) => {
          // Commit the success subset via the canonical path (asset save +
          // derivation edges). Empty images (all-fail) → runTaskPollLoop wouldn't
          // reach here (status='failed' throws), but guard anyway. Pass images
          // as-is: runtime images are {b64}, test mocks may carry {blob} — both
          // are handled by blobFromCommittedGenerationImage inside commit.
          const successIds =
            images.length > 0
              ? await get().commitGenerationResult({
                  sceneId: targetSceneId,
                  sourceNodeId: source.id,
                  resultImages: images,
                  prompt: basePrompt,
                  model,
                  kind: 'generate',
                  taskId,
                })
              : []
          // Surface failed variations as visible "failed slot" ai-slot nodes so
          // the UI can mark them red (contract: 失败槽位可见). Derivation edges
          // link them to the source for the variant grid.
          const failedSlots = (failures ?? []).map((failure) =>
            createFailedVariationSlot(source, failure, basePrompt, model, taskId),
          )
          if (failedSlots.length > 0) {
            set((current) => {
              const doc = current.canvases[targetSceneId]
              if (!doc) return {}
              return patchCanvasDocument(current, targetSceneId, {
                nodes: [...doc.nodes, ...failedSlots.map((s) => s.node)],
                edges: [...doc.edges, ...failedSlots.map((s) => s.edge)],
              })
            })
          }
          return successIds
        },
      })
      const successCount = nodeIds.length
      set((current) => {
        const doc = current.canvases[targetSceneId]
        if (!doc) return {}
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            doc.tasks,
            doneTask(runningTask, `变体生成：${source.title}（${successCount}/${count}）`, nodeIds),
          ),
        })
      })
      logCanvas(`Generated ${successCount}/${count} variations from "${source.title}"`)
      return nodeIds
    } catch (error) {
      const canceled = isCanceledGenerationError(error, options.signal)
      if (canceled && serverTaskId) {
        await cancelTask(serverTaskId)
      }
      const message = error instanceof Error ? error.message : 'Variations failed'
      set((current) => {
        const doc = current.canvases[targetSceneId]
        if (!doc) return {}
        const liveTask = doc.tasks.find((t) => t.id === runningTask.id) ?? runningTask
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            doc.tasks,
            canceled
              ? canceledTask(liveTask, `变体生成已取消：${source.title}`)
              : failedTask(liveTask, `变体生成失败：${message}`),
          ),
        })
      })
      throw error
    }
  },
  generateImageEdit: async (sourceNodeId, operation, prompt, options = {}) => {
    const targetSceneId = options.sceneId || get().sceneId
    const taskId = createNodeId(`task-${operation}`)
    const operationLabels: Record<string, string> = {
      'prompt-edit': 'Prompt edit',
      'area-edit': 'Area edit',
      'remove-background': 'Remove background',
      outpaint: 'Expand image',
      upscale: 'Boost resolution',
    }
    const operationLabel = operationLabels[operation] || 'Image edit'
    const state = get()
    const document = state.canvases[targetSceneId]
    if (!document) throw new Error('目标画布已删除，无法继续生成。')
    const source =
      (sourceNodeId
        ? document.nodes.find((node) => node.id === sourceNodeId && node.type === 'image' && !node.hidden)
        : undefined) ||
      (!sourceNodeId
        ? document.nodes.find((node) => node.id === document.selectedNodeId && node.type === 'image' && !node.hidden)
        : undefined)
    if (sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')
    if (!source) return []

    const resultPrompt = prompt.trim() || operationLabel
    const model = options.model || defaultMivoImageModel
    const runningTask: CanvasTask = {
      id: taskId,
      label: `${operationLabel}: ${source.title}`,
      status: 'running',
      progress: 0,
      nodeIds: [],
    }

    set((current) => {
      const targetDocument = current.canvases[targetSceneId]
      if (!targetDocument) return {}
      return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(targetDocument.tasks, runningTask) })
    })

    let serverTaskId: string | undefined
    try {
      if (options.signal?.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const image = await assetBlobForNode(source)
      serverTaskId = await submitEditTask({
        image,
        reference: options.referenceFiles,
        prompt: resultPrompt,
        imgRatio: options.imgRatio || '1:1',
        quality: options.quality || 'medium',
        model,
        idempotencyKey: newIdempotencyKey(),
        signal: options.signal,
      })
      const nodeIds = await runTaskPollLoop(set, {
        serverTaskId,
        signal: options.signal,
        localTask: runningTask,
        sceneId: targetSceneId,
        onResult: async ({ images }) => get().commitGenerationResult({
          sceneId: targetSceneId,
          sourceNodeId: source.id,
          resultImages: images,
          prompt: resultPrompt,
          model,
          kind: edgeTypeForOperation(operation),
          taskId,
          createDerivationEdge: options.createDerivationEdge,
        }),
      })
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(targetDocument.tasks, doneTask(runningTask, `${operationLabel}: ${source.title}`, nodeIds)),
        })
      })
      return nodeIds
    } catch (error) {
      const canceled = isCanceledGenerationError(error, options.signal)
      if (canceled && serverTaskId) {
        await cancelTask(serverTaskId)
      }
      const message = error instanceof Error ? error.message : 'Image edit failed'
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        const liveTask = targetDocument.tasks.find((t) => t.id === runningTask.id) ?? runningTask
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            targetDocument.tasks,
            canceled
              ? canceledTask(liveTask, `${operationLabel} canceled`)
              : failedTask(liveTask, `${operationLabel} failed: ${message}`),
          ),
        })
      })
      throw error
    }
  },
  generateBesideNode: async (sourceNodeId, prompt, options = {}) => {
    const targetSceneId = options.sceneId || get().sceneId
    const state = get()
    const document = state.canvases[targetSceneId]
    if (!document) throw new Error('目标画布已删除，无法继续生成。')
    const source =
      (sourceNodeId ? document.nodes.find((node) => node.id === sourceNodeId && !node.hidden) : undefined) ||
      (!sourceNodeId
        ? document.nodes.find((node) => node.id === document.selectedNodeId && !node.hidden) ||
          document.nodes.find((node) => !node.hidden)
        : undefined)
    if (sourceNodeId && !source) throw new Error('源节点已删除，无法继续生成。')
    if (!source) return []

    const resultPrompt = prompt?.trim() || nodePrompt(source)
    const model = options.model || defaultMivoImageModel
    const taskId = createNodeId('task-beside-generation')
    const runningTask: CanvasTask = {
      id: taskId,
      label: `旁边生成：${source.title}`,
      status: 'running',
      progress: 0,
      nodeIds: [],
    }

    set((current) => {
      const targetDocument = current.canvases[targetSceneId]
      if (!targetDocument) return {}
      return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(targetDocument.tasks, runningTask) })
    })

    let serverTaskId: string | undefined
    try {
      if (options.signal?.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const referenceFiles = options.referenceFiles || []
      const sourceImage = source.type === 'image' && source.assetUrl ? await assetBlobForNode(source) : undefined
      const editImage = sourceImage || referenceFiles[0]
      const idempotencyKey = newIdempotencyKey()
      if (editImage) {
        serverTaskId = await submitEditTask({
          image: editImage,
          reference: sourceImage ? referenceFiles : referenceFiles.slice(1),
          prompt: resultPrompt,
          imgRatio: options.imgRatio || '1:1',
          quality: options.quality || 'medium',
          model,
          idempotencyKey,
          signal: options.signal,
        })
      } else {
        serverTaskId = await submitGenerationTask({
          prompt: resultPrompt,
          imgRatio: options.imgRatio || '1:1',
          quality: options.quality || 'medium',
          n: 1,
          model,
          idempotencyKey,
          signal: options.signal,
        })
      }
      const nodeIds = await runTaskPollLoop(set, {
        serverTaskId,
        signal: options.signal,
        localTask: runningTask,
        sceneId: targetSceneId,
        onResult: async ({ images }) => get().commitGenerationResult({
          sceneId: targetSceneId,
          sourceNodeId: source.id,
          resultImages: images,
          prompt: resultPrompt,
          model,
          kind: 'generate',
          taskId,
          createDerivationEdge: options.createDerivationEdge,
        }),
      })
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(targetDocument.tasks, doneTask(runningTask, `旁边生成：${source.title}`, nodeIds)),
        })
      })
      return nodeIds
    } catch (error) {
      const canceled = isCanceledGenerationError(error, options.signal)
      if (canceled && serverTaskId) {
        await cancelTask(serverTaskId)
      }
      const message = error instanceof Error ? error.message : 'Generation failed'
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        const liveTask = targetDocument.tasks.find((t) => t.id === runningTask.id) ?? runningTask
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            targetDocument.tasks,
            canceled
              ? canceledTask(liveTask, `旁边生成已取消：${source.title}`)
              : failedTask(liveTask, `旁边生成失败：${message}`),
          ),
        })
      })
      throw error
    }
  },
  generateIntoAiSlot: async (slotId, prompt, options = {}) => {
    const targetSceneId = options.sceneId || get().sceneId
    const state = get()
    const document = state.canvases[targetSceneId]
    if (!document) throw new Error('目标画布已删除，无法继续生成。')
    const slot =
      (slotId ? document.nodes.find((node) => node.id === slotId && node.type === 'ai-slot' && !node.hidden) : undefined) ||
      (!slotId
        ? document.nodes.find((node) => node.id === document.selectedNodeId && node.type === 'ai-slot' && !node.hidden)
        : undefined)
    if (slotId && !slot) throw new Error('AI 生成槽位已删除，无法继续生成。')
    if (!slot) return []

    const resultPrompt = prompt?.trim() || nodePrompt(slot, '根据 AI 槽位生成图片')
    const model = options.model || defaultMivoImageModel
    const taskId = createNodeId('task-slot-generation')
    const runningTask: CanvasTask = {
      id: taskId,
      label: `生成到槽位：${slot.title}`,
      status: 'running',
      progress: 0,
      nodeIds: [],
    }
    const skipSlotHistoryBaseline = Boolean(
      (options as { skipSlotHistoryBaseline?: boolean }).skipSlotHistoryBaseline,
    )
    // S01: 捕获生成开始时的 history 基线引用。失败回滚时仅当栈顶仍是该引用才 pop
    // （snapshot 对象身份判据，不改 snapshot schema）。异步期间用户编辑/undo 过 →
    // 栈顶已不是该基线 → 回滚返回 undefined → caller 走 filter-removal，保留编辑。
    let baselineSnapshot: MivoCanvasSnapshot | undefined
    if (!skipSlotHistoryBaseline && targetSceneId === state.sceneId) {
      get().captureHistory()
      baselineSnapshot = get().historyPast.at(-1)
    }

    set((current) => {
      const targetDocument = current.canvases[targetSceneId]
      if (!targetDocument) return {}
      const nodes = targetDocument.nodes.map((node) =>
        node.id === slot.id
          ? {
              ...node,
              generation: {
                prompt: resultPrompt,
                model,
                size: node.generation?.size || `${Math.round(slot.width)}x${Math.round(slot.height)}`,
                seed: node.generation?.seed,
                strength: node.generation?.strength,
                taskId,
                createdAt: Date.now(),
              },
              aiWorkflow: {
                ...(node.aiWorkflow || { kind: 'slot' as const }),
                status: 'generating' as const,
                operation: 'slot-generation' as const,
                prompt: resultPrompt,
              },
            }
          : node,
      )
      return patchCanvasDocument(current, targetSceneId, { nodes, tasks: upsertTask(targetDocument.tasks, runningTask) })
    })

    let serverTaskId: string | undefined
    try {
      if (options.signal?.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const referenceFiles = options.referenceFiles || []
      const idempotencyKey = newIdempotencyKey()
      if (referenceFiles[0]) {
        serverTaskId = await submitEditTask({
          image: referenceFiles[0],
          reference: referenceFiles.slice(1),
          prompt: resultPrompt,
          imgRatio: options.imgRatio || '1:1',
          quality: options.quality || 'medium',
          model,
          idempotencyKey,
          signal: options.signal,
        })
      } else {
        serverTaskId = await submitGenerationTask({
          prompt: resultPrompt,
          imgRatio: options.imgRatio || '1:1',
          quality: options.quality || 'medium',
          n: 1,
          model,
          idempotencyKey,
          signal: options.signal,
        })
      }
      const nodeIds = await runTaskPollLoop(set, {
        serverTaskId,
        signal: options.signal,
        localTask: runningTask,
        sceneId: targetSceneId,
        onResult: async ({ images }) => {
          const commitPayload = {
            sceneId: targetSceneId,
            sourceNodeId: slot.id,
            replaceSlotId: slot.id,
            resultImages: images,
            prompt: resultPrompt,
            model,
            kind: 'generate' as const,
            taskId,
            createDerivationEdge: options.createDerivationEdge,
          }
          return get().commitGenerationResult(commitPayload)
        },
      })
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        const nodes = targetDocument.nodes.map((node) =>
          node.id === slot.id && node.aiWorkflow
            ? {
                ...node,
                aiWorkflow: {
                  ...node.aiWorkflow,
                  status: 'ready' as const,
                },
              }
            : node,
        )
        return patchCanvasDocument(current, targetSceneId, {
          nodes,
          tasks: upsertTask(targetDocument.tasks, doneTask(runningTask, `生成到槽位：${slot.title}`, nodeIds)),
        })
      })
      return nodeIds
    } catch (error) {
      const canceled = isCanceledGenerationError(error, options.signal)
      if (canceled && serverTaskId) {
        await cancelTask(serverTaskId)
      }
      const message = error instanceof Error ? error.message : 'Generation failed'
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        // S01: 仅当栈顶仍是生成开始时捕获的基线引用才回滚；baselineSnapshot 为
        // undefined（chat 新建槽位 skip 路径）或栈顶已变（用户异步期间编辑过）时
        // 走 filter-removal —— 删槽位与运行中 task，但 historyPast/historyFuture
        // 不动，保留用户编辑与 redo 栈。
        const rollback = baselineSnapshot
          ? rollbackLatestHistoryBaseline(current, targetSceneId, {
              removeNodeId: slot.id,
              expectedBaseline: baselineSnapshot,
            })
          : undefined
        if (rollback) return rollback

        return patchCanvasDocument(current, targetSceneId, {
          nodes: targetDocument.nodes.filter((node) => node.id !== slot.id),
          edges: (targetDocument.edges || []).filter((edge) => edge.from !== slot.id && edge.to !== slot.id),
          tasks: targetDocument.tasks.filter((task) => task.id !== runningTask.id),
        })
      })
      if (canceled) {
        warnCanvas(`生成到槽位已取消，已移除占位符：${slot.title}`)
      } else {
        errorCanvas(`生成到槽位失败，已移除占位符：${message}`)
      }
      throw error
    }
  },
  generateFromAnnotation: async (annotationNodeId, options = {}) => {
    const targetSceneId = options.sceneId || get().sceneId
    const state = get()
    const document = state.canvases[targetSceneId]
    if (!document) throw new Error('目标画布已删除，无法继续生成。')
    const annotation =
      (annotationNodeId
        ? document.nodes.find((node) => node.id === annotationNodeId && node.type === 'annotation' && !node.hidden)
        : undefined) ||
      document.nodes.find((node) => node.id === document.selectedNodeId && node.type === 'annotation' && !node.hidden)
    if (annotationNodeId && !annotation) throw new Error('批注节点已删除，无法继续生成。')
    if (!annotation) throw new Error('没有可用的批注，无法生成。')

    const sourceId = annotation.aiWorkflow?.sourceNodeIds?.[0] || annotation.parentIds?.[0]
    const source = sourceId
      ? document.nodes.find((node) => node.id === sourceId && node.type === 'image' && !node.hidden)
      : undefined
    if (sourceId && !source) throw new Error('源节点已删除，无法继续生成。')
    if (!source) throw new Error('批注未关联可用源图，无法生成。')

    const resultPrompt = annotation.text?.trim() || nodePrompt(annotation, '根据批注生成修订版图片')
    const model = source.generation?.model || defaultMivoImageModel
    const taskId = createNodeId('task-annotation-edit')
    const runningTask: CanvasTask = {
      id: taskId,
      label: `批注修图：${source.title}`,
      status: 'running',
      progress: 0,
      nodeIds: [],
    }

    set((current) => {
      const doc = current.canvases[targetSceneId]
      if (!doc) return {}
      return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(doc.tasks, runningTask) })
    })

    // Normalize the annotation's canvas-coordinate bounds to the source image's
    // relative 0-1 maskBounds; the BFF synthesizes the area mask PNG from this.
    // No bounds ⇒ whole-image prompt-edit (no mask).
    const maskBounds = normalizeAnnotationBounds(source, annotation)

    let serverTaskId: string | undefined
    try {
      if (options.signal?.aborted) throw new MivoImageRequestError('图片请求已取消。', 'canceled')
      const image = await assetBlobForNode(source)
      // sourceSize must be the image's natural pixel size, not the node's canvas
      // display size, so the BFF synthesizes the area mask at matching resolution
      // (maskBounds are 0-1 relative, so only resolution changes). Falls back to
      // the node display size if the blob cannot be decoded.
      let sourceNaturalSize = { width: source.width, height: source.height }
      try {
        const bitmap = await createImageBitmap(image)
        sourceNaturalSize = { width: bitmap.width, height: bitmap.height }
        bitmap.close?.()
      } catch {
        // keep node display size fallback
      }
      serverTaskId = await submitEditTask({
        image,
        prompt: resultPrompt,
        maskBounds,
        sourceSize: maskBounds ? sourceNaturalSize : undefined,
        imgRatio: options.imgRatio,
        quality: options.quality,
        model,
        idempotencyKey: newIdempotencyKey(),
        signal: options.signal,
      })
      const nodeIds = await runTaskPollLoop(set, {
        serverTaskId,
        signal: options.signal,
        localTask: runningTask,
        sceneId: targetSceneId,
        onResult: async ({ images }) =>
          get().commitGenerationResult({
            sceneId: targetSceneId,
            sourceNodeId: source.id,
            resultImages: images,
            prompt: resultPrompt,
            model,
            kind: 'edit',
            taskId,
            maskBounds: annotation.annotationBounds,
          }),
      })
      set((current) => {
        const doc = current.canvases[targetSceneId]
        if (!doc) return {}
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(doc.tasks, doneTask(runningTask, `批注修图：${source.title}`, nodeIds)),
        })
      })
      logCanvas(`Generated from annotation "${annotation.title}"`)
      return nodeIds
    } catch (error) {
      const canceled = isCanceledGenerationError(error, options.signal)
      if (canceled && serverTaskId) {
        await cancelTask(serverTaskId)
      }
      const message = error instanceof Error ? error.message : 'Annotation edit failed'
      set((current) => {
        const doc = current.canvases[targetSceneId]
        if (!doc) return {}
        const liveTask = doc.tasks.find((t) => t.id === runningTask.id) ?? runningTask
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            doc.tasks,
            canceled
              ? canceledTask(liveTask, `批注修图已取消：${source.title}`)
              : failedTask(liveTask, `批注修图失败：${message}`),
          ),
        })
      })
      throw error
    }
  },
})
