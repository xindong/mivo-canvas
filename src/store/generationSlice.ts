import type {
  CanvasEdge,
  CanvasTask,
  MivoCanvasNode,
} from '../types/mivoCanvas'
import type { SliceCreator } from './canvasStore'
import { MivoImageRequestError, assetBlobForNode, editMivoImage, generateMivoImage } from '../lib/mivoImageClient'
import { createAiResultNode } from '../model/aiCanvasCommands'
import { chooseAdjacentPlacement } from './aiCanvasWorkflow'
import { logCanvas, warnCanvas } from './canvasStore'
import { realCaseImages } from './demoScenes'
import { createEdgeId, createNodeId, edgeTypeForOperation } from './nodeFactory'
import { mockGenerationAdapter } from './mockGeneration'
import {
  defaultDocument,
  nodePrompt,
  normalizeCanvasNodes,
  patchCanvasDocument,
  patchWithHistory,
} from './canvasDocumentModel'

const mockResultAssetUrl = (nodes: MivoCanvasNode[]) => realCaseImages[nodes.length % realCaseImages.length]
const defaultMivoImageModel = 'gpt-image-2'
const upsertTask = (tasks: CanvasTask[], task: CanvasTask) => [
  task,
  ...tasks.filter((item) => item.id !== task.id),
].slice(0, 5)

const failedTask = (task: CanvasTask, label: string): CanvasTask => ({
  ...task,
  label,
  status: 'failed',
  progress: 100,
})

const canceledTask = (task: CanvasTask, label: string): CanvasTask => ({
  ...task,
  label,
  status: 'canceled',
  progress: 100,
})

const doneTask = (task: CanvasTask, label: string, nodeIds: string[]): CanvasTask => ({
  ...task,
  label,
  status: 'done',
  progress: 100,
  nodeIds,
})

const isCanceledGenerationError = (error: unknown, signal?: AbortSignal) =>
  Boolean(signal?.aborted) ||
  (error instanceof MivoImageRequestError && error.kind === 'canceled') ||
  (error instanceof Error && error.message.includes('已取消'))

export const createGenerationSlice: SliceCreator = (set, get) => ({
  tasks: defaultDocument.tasks,
  generateVariations: (sourceNodeId) => {
    const state = get()
    const source =
      state.nodes.find((node) => node.id === sourceNodeId) ||
      state.nodes.find((node) => node.id === state.selectedNodeId) ||
      state.nodes[0]

    if (!source) {
      warnCanvas('Variation generation skipped: no source node available')
      return
    }

    const batchId = Date.now() % 100000
    const result = mockGenerationAdapter.generateVariations({
      sourceNode: source,
      count: 4,
      batchId,
    })
    const createdAt = Date.now()
    const resultNodes = result.nodes.map((node) => ({
      ...node,
      sourceNodeId: source.id,
      generation: node.generation
        ? {
            ...node.generation,
            createdAt,
          }
        : node.generation,
    }))
    const edges = resultNodes.map((node) => ({
      id: createEdgeId(),
      from: source.id,
      to: node.id,
      type: 'generate' as const,
      prompt: node.generation?.prompt || nodePrompt(source),
      createdAt,
    }))

    set((current) => ({
      activeTool: 'variations',
      ...patchWithHistory(current, {
        selectedNodeId: resultNodes[0]?.id,
        selectedNodeIds: resultNodes[0] ? [resultNodes[0].id] : [],
        nodes: [...current.nodes, ...resultNodes],
        edges: [...current.edges, ...edges],
        tasks: [result.task, ...current.tasks].slice(0, 5),
      }),
    }))
    logCanvas(`Generated ${result.nodes.length} variations from "${source.title}"`)
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
      progress: 20,
      nodeIds: [],
    }

    set((current) => {
      const targetDocument = current.canvases[targetSceneId]
      if (!targetDocument) return {}
      return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(targetDocument.tasks, runningTask) })
    })

    try {
      const image = await assetBlobForNode(source)
      const response = await editMivoImage({
        image,
        reference: options.referenceFiles,
        prompt: resultPrompt,
        imgRatio: options.imgRatio || '1:1',
        quality: options.quality || 'medium',
        model,
        signal: options.signal,
      })
      const nodeIds = await get().commitGenerationResult({
        sceneId: targetSceneId,
        sourceNodeId: source.id,
        resultImages: response.images,
        prompt: resultPrompt,
        model,
        kind: edgeTypeForOperation(operation),
        taskId,
        createDerivationEdge: options.createDerivationEdge,
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
      const message = error instanceof Error ? error.message : 'Image edit failed'
      const canceled = isCanceledGenerationError(error, options.signal)
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            targetDocument.tasks,
            canceled
              ? canceledTask(runningTask, `${operationLabel} canceled`)
              : failedTask(runningTask, `${operationLabel} failed: ${message}`),
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
      progress: 20,
      nodeIds: [],
    }

    set((current) => {
      const targetDocument = current.canvases[targetSceneId]
      if (!targetDocument) return {}
      return patchCanvasDocument(current, targetSceneId, { tasks: upsertTask(targetDocument.tasks, runningTask) })
    })

    try {
      const referenceFiles = options.referenceFiles || []
      const sourceImage = source.type === 'image' && source.assetUrl ? await assetBlobForNode(source) : undefined
      const editImage = sourceImage || referenceFiles[0]
      const response = editImage
        ? await editMivoImage({
            image: editImage,
            reference: sourceImage ? referenceFiles : referenceFiles.slice(1),
            prompt: resultPrompt,
            imgRatio: options.imgRatio || '1:1',
            quality: options.quality || 'medium',
            model,
            signal: options.signal,
          })
        : await generateMivoImage({
            prompt: resultPrompt,
            imgRatio: options.imgRatio || '1:1',
            quality: options.quality || 'medium',
            n: 1,
            model,
            signal: options.signal,
          })
      const nodeIds = await get().commitGenerationResult({
        sceneId: targetSceneId,
        sourceNodeId: source.id,
        resultImages: response.images,
        prompt: resultPrompt,
        model,
        kind: 'generate',
        taskId,
        createDerivationEdge: options.createDerivationEdge,
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
      const message = error instanceof Error ? error.message : 'Generation failed'
      const canceled = isCanceledGenerationError(error, options.signal)
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        return patchCanvasDocument(current, targetSceneId, {
          tasks: upsertTask(
            targetDocument.tasks,
            canceled
              ? canceledTask(runningTask, `旁边生成已取消：${source.title}`)
              : failedTask(runningTask, `旁边生成失败：${message}`),
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
      progress: 20,
      nodeIds: [],
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

    try {
      const referenceFiles = options.referenceFiles || []
      const response = referenceFiles[0]
        ? await editMivoImage({
            image: referenceFiles[0],
            reference: referenceFiles.slice(1),
            prompt: resultPrompt,
            imgRatio: options.imgRatio || '1:1',
            quality: options.quality || 'medium',
            model,
            signal: options.signal,
          })
        : await generateMivoImage({
            prompt: resultPrompt,
            imgRatio: options.imgRatio || '1:1',
            quality: options.quality || 'medium',
            n: 1,
            model,
            signal: options.signal,
          })
      const nodeIds = await get().commitGenerationResult({
        sceneId: targetSceneId,
        sourceNodeId: slot.id,
        resultImages: response.images,
        prompt: resultPrompt,
        model,
        kind: 'generate',
        taskId,
        placement: 'right',
        createDerivationEdge: options.createDerivationEdge,
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
      const message = error instanceof Error ? error.message : 'Generation failed'
      const canceled = isCanceledGenerationError(error, options.signal)
      set((current) => {
        const targetDocument = current.canvases[targetSceneId]
        if (!targetDocument) return {}
        const nodes = targetDocument.nodes.map((node) =>
          node.id === slot.id && node.aiWorkflow
            ? {
                ...node,
                aiWorkflow: {
                  ...node.aiWorkflow,
                  status: canceled ? 'canceled' as const : 'failed' as const,
                },
              }
            : node,
        )
        return patchCanvasDocument(current, targetSceneId, {
          nodes,
          tasks: upsertTask(
            targetDocument.tasks,
            canceled
              ? canceledTask(runningTask, `生成到槽位已取消：${slot.title}`)
              : failedTask(runningTask, `生成到槽位失败：${message}`),
          ),
        })
      })
      throw error
    }
  },
  generateFromAnnotation: (annotationNodeId) => {
    const id = createNodeId('annotation-result')
    const createdAt = Date.now()

    set((state) => {
      const annotation =
        state.nodes.find((node) => node.id === annotationNodeId && node.type === 'annotation' && !node.hidden) ||
        state.nodes.find((node) => node.id === state.selectedNodeId && node.type === 'annotation' && !node.hidden)
      if (!annotation) {
        warnCanvas('Annotation generation skipped: no annotation selected')
        return {}
      }

      const sourceId = annotation.aiWorkflow?.sourceNodeIds?.[0] || annotation.parentIds?.[0]
      const source = sourceId ? state.nodes.find((node) => node.id === sourceId && !node.hidden) : undefined
      const anchor = source || annotation
      const width = source && source.type !== 'text' && source.type !== 'annotation' ? source.width : 320
      const height = source && source.type !== 'text' && source.type !== 'annotation' ? source.height : 240
      const placement = chooseAdjacentPlacement({
        nodes: state.nodes,
        anchor,
        width,
        height,
        placement: 'right',
      })
      const resultPrompt = nodePrompt(annotation, '根据批注生成修订版图片')
      const result = createAiResultNode({
        id,
        title: `Edited from ${source?.title || annotation.title}`,
        sourceNodes: source ? [source] : [annotation],
        anchorNode: anchor,
        annotationNode: annotation,
        operation: 'annotation-edit',
        prompt: resultPrompt,
        placement: 'right',
        position: { x: placement.x, y: placement.y },
        size: { width, height },
        assetUrl: mockResultAssetUrl(state.nodes),
        createdAt,
        taskId: `task-${id}`,
        strength: 0.66,
      })
      const task: CanvasTask = {
        id: `task-${id}`,
        label: `批注修图：${source?.title || annotation.title}`,
        status: 'done',
        progress: 100,
        nodeIds: [id],
      }
      const edge: CanvasEdge = {
        id: createEdgeId(),
        from: anchor.id,
        to: id,
        type: 'edit',
        prompt: resultPrompt,
        createdAt,
      }

      logCanvas(`Generated from annotation "${annotation.title}"`)
      return patchWithHistory(state, {
        selectedNodeId: id,
        selectedNodeIds: [id],
        nodes: normalizeCanvasNodes([...state.nodes, result]),
        edges: [...state.edges, edge],
        tasks: [task, ...state.tasks].slice(0, 5),
      })
    })
  },
})
