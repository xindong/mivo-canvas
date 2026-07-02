import { createDemoImage } from '../lib/demoImages'
import { normalizeCanvasSnapshotV2 } from '../model/canvasSnapshotModel'
import { normalizeCanvasNodeV2 } from '../model/documentModelV2'
import type { DemoSceneId, MivoCanvasNode, MivoCanvasSnapshot, SceneDefinition } from '../types/mivoCanvas'

export const modelNames = ['Mivo Art SDXL', 'Mivo Character v3', 'Mivo Concept Fast']

export const realCaseImages = [
  '/demo-assets/courage-1.jpg',
  '/demo-assets/courage-2.jpg',
  '/demo-assets/courage-3.jpg',
]

const image = (
  label: string,
  mood: 'character' | 'environment' | 'variant' | 'asset',
  seed: number,
  accent: string,
  secondary: string,
) =>
  createDemoImage({
    label,
    mood,
    seed,
    accent,
    secondary,
  })

export const makeNode = (
  node: Omit<MivoCanvasNode, 'status' | 'type'> & Partial<Pick<MivoCanvasNode, 'status' | 'type'>>,
): MivoCanvasNode =>
  normalizeCanvasNodeV2({
    type: 'image',
    status: 'ready',
    ...node,
  })

const buildVariants = (sourceId: string, startX: number, startY: number) =>
  Array.from({ length: 4 }, (_, index) =>
    makeNode({
      id: `variant-${index + 1}`,
      title: `Variant ${index + 1}`,
      x: startX + (index % 2) * 246,
      y: startY + Math.floor(index / 2) * 404,
      width: 204,
      height: 362,
      assetUrl: realCaseImages[index % realCaseImages.length],
      parentIds: [sourceId],
      groupId: 'group-variants',
      generation: {
        prompt: '保留白发武士角色气质，探索不同姿态、色彩和服装图案',
        model: modelNames[index % modelNames.length],
        size: '1080x1920',
        seed: 4200 + index,
        strength: 0.62,
      },
    }),
  )

const sceneDefinitions = (): Record<DemoSceneId, SceneDefinition> => {
  const reference = makeNode({
    id: 'ref-hero',
    title: 'Courage Study 01',
    x: -280,
    y: -190,
    width: 216,
    height: 384,
    assetUrl: realCaseImages[0],
    generation: {
      prompt: '白发武士角色，蓝色背景，骷髅面具，彩色图案外套，双刀，日系插画风',
      model: 'Mivo Character v3',
      size: '1080x1920',
      seed: 1248,
      strength: 0.54,
    },
  })

  const mood = makeNode({
    id: 'mood-env',
    title: 'Courage Study 02',
    x: -28,
    y: -190,
    width: 216,
    height: 384,
    assetUrl: realCaseImages[1],
    generation: {
      prompt: '正面白发角色，蓝色背景，荧光眼，粉色烟雾，花纹和服，武士刀',
      model: 'Mivo Concept Fast',
      size: '1080x1920',
      seed: 9811,
    },
  })

  const variants = buildVariants(reference.id, 108, -210)

  return {
    'character-flow': {
      id: 'character-flow',
      label: '角色参考图流程',
      selectedNodeId: reference.id,
      nodes: [
        reference,
        mood,
        makeNode({
          id: 'material-ref',
          title: 'Courage Study 03',
          x: 224,
          y: -190,
          width: 216,
          height: 384,
          assetUrl: realCaseImages[2],
          generation: {
            prompt: '侧身白发角色，浅色背景，蓝色烟云，霓虹色图案外套，双刀构图',
            model: 'Mivo Art SDXL',
            size: '1080x1920',
            seed: 6077,
          },
        }),
      ],
      tasks: [
        {
          id: 'task-brief',
          label: '参考图已绑定到图生图上下文',
          status: 'done',
          progress: 100,
          nodeIds: [reference.id],
        },
      ],
    },
    variants: {
      id: 'variants',
      label: '4 张变体结果',
      selectedNodeId: variants[0].id,
      nodes: [reference, ...variants],
      tasks: [
        {
          id: 'task-variants',
          label: '做 4 个角色方向变体',
          status: 'done',
          progress: 100,
          nodeIds: variants.map((node) => node.id),
        },
      ],
    },
    'task-states': {
      id: 'task-states',
      label: '生成中 / 失败 / 重试',
      selectedNodeId: 'loading-task',
      nodes: [
        reference,
        makeNode({
          id: 'loading-task',
          type: 'task-placeholder',
          title: 'Generating 4 variations',
          x: 40,
          y: -102,
          width: 270,
          height: 178,
          status: 'generating',
          parentIds: [reference.id],
          generation: {
            prompt: '保持剪影，生成四个阵营版本',
            model: 'Mivo Character v3',
            size: '1024x1365',
            seed: 9910,
            taskId: 'task-running',
          },
        }),
        makeNode({
          id: 'failed-task',
          type: 'task-placeholder',
          title: 'Retry image-to-image',
          x: 360,
          y: 112,
          width: 270,
          height: 178,
          status: 'failed',
          parentIds: [reference.id],
          generation: {
            prompt: '失败任务保留参数，可直接重试',
            model: 'Mivo Character v3',
            size: '1024x1365',
            seed: 9911,
            taskId: 'task-failed',
          },
        }),
      ],
      tasks: [
        {
          id: 'task-running',
          label: '图生图变体生成中',
          status: 'running',
          progress: 62,
          nodeIds: ['loading-task'],
        },
        {
          id: 'task-failed',
          label: '抠图后重绘失败，等待重试',
          status: 'failed',
          progress: 18,
          nodeIds: ['failed-task'],
        },
      ],
    },
    'stress-test': {
      id: 'stress-test',
      label: '100 张图片压力测试',
      selectedNodeId: 'stress-0',
      nodes: Array.from({ length: 100 }, (_, index) =>
        makeNode({
          id: `stress-${index}`,
          title: `Result ${String(index + 1).padStart(3, '0')}`,
          x: (index % 10) * 162 - 740,
          y: Math.floor(index / 10) * 214 - 520,
          width: 132,
          height: 174,
          assetUrl: image(
            `R${index + 1}`,
            index % 3 === 0 ? 'character' : index % 3 === 1 ? 'variant' : 'environment',
            3000 + (index % 12),
            ['#a85232', '#557463', '#566d89', '#7b5b4e'][index % 4],
            ['#d9c098', '#a9beb0', '#b5c0d0', '#d4b89d'][index % 4],
          ),
          generation: {
            prompt: '批量结果压力测试节点',
            model: modelNames[index % modelNames.length],
            size: '768x1024',
            seed: 7000 + index,
          },
        }),
      ),
      tasks: [
        {
          id: 'task-stress',
          label: '100 张缩略图节点加载',
          status: 'done',
          progress: 100,
          nodeIds: [],
        },
      ],
    },
    'asset-handoff': {
      id: 'asset-handoff',
      label: '资产入库流程',
      selectedNodeId: 'asset-final-a',
      nodes: [
        reference,
        ...variants.slice(0, 2).map((node, index) => ({
          ...node,
          x: 48 + index * 246,
          y: -210,
          favorited: index === 0,
        })),
        makeNode({
          id: 'asset-final-a',
          title: 'Approved Asset',
          x: 202,
          y: 160,
          width: 216,
          height: 384,
          assetUrl: realCaseImages[2],
          favorited: true,
          parentIds: ['variant-1'],
          generation: {
            prompt: '已选主图，准备入库为白发武士角色概念资产',
            model: 'Mivo Character v3',
            size: '1080x1920',
            seed: 8102,
          },
        }),
      ],
      tasks: [
        {
          id: 'task-asset',
          label: '3 张候选已收束，1 张待入库',
          status: 'queued',
          progress: 38,
          nodeIds: ['asset-final-a'],
        },
      ],
    },
    empty: {
      id: 'empty',
      label: '空画布',
      nodes: [],
      tasks: [],
    },
  }
}

export const scenes = () => Object.values(sceneDefinitions())

export const snapshotFromScene = (sceneId: DemoSceneId): MivoCanvasSnapshot => {
  const scene = sceneDefinitions()[sceneId]
  return normalizeCanvasSnapshotV2({
    version: 2,
    sceneId,
    nodes: scene.nodes,
    edges: scene.edges || [],
    tasks: scene.tasks,
    selectedNodeId: scene.selectedNodeId,
    selectedNodeIds: scene.selectedNodeIds || (scene.selectedNodeId ? [scene.selectedNodeId] : []),
  })
}
