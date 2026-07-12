import type { CanvasNodeType, MivoCanvasNode } from '../types/mivoCanvas'
import {
  baseObjectCapabilities,
  organizationCapabilities,
  type CanvasObjectCapability,
} from './nodeCapabilities'

export type CanvasNodeRenderKind =
  | 'image'
  | 'task'
  | 'text'
  | 'section'
  | 'ai-slot'
  | 'annotation'
  | 'markup'
  | 'markdown'
  | 'pdf'
  | 'video'

export type CanvasNodeImportBehavior =
  | 'asset-image'
  | 'asset-markdown'
  | 'asset-pdf'
  | 'asset-video'
  | 'generated-image'
  | 'text'
  | 'section'
  | 'markup'
  | 'none'

export type CanvasNodeDefinition = {
  type: CanvasNodeType
  label: string
  renderKind: CanvasNodeRenderKind
  defaultSize: { width: number; height: number }
  importBehavior: CanvasNodeImportBehavior
  capabilities: (node: MivoCanvasNode) => Set<CanvasObjectCapability>
}

const capabilities = (items: CanvasObjectCapability[]) => new Set(items)

const objectCapabilitiesFor = (
  node: MivoCanvasNode,
  unlockedCapabilities: CanvasObjectCapability[],
  lockedCapabilities: CanvasObjectCapability[] = unlockedCapabilities,
) =>
  capabilities([
    ...(node.locked ? organizationCapabilities : baseObjectCapabilities),
    ...(node.locked ? lockedCapabilities : unlockedCapabilities),
  ])

const imageCapabilitiesFor = (node: MivoCanvasNode) =>
  objectCapabilitiesFor(
    node,
    [
      'asset',
      'imageAsset',
      'downloadOriginal',
      'aiReference',
      'aiEditable',
      ...(node.aiWorkflow?.kind === 'result' ? (['aiResult'] as CanvasObjectCapability[]) : []),
    ],
    [
      'asset',
      'imageAsset',
      'downloadOriginal',
      'aiReference',
      'aiEditable',
      'exportable',
      ...(node.aiWorkflow?.kind === 'result' ? (['aiResult'] as CanvasObjectCapability[]) : []),
    ],
  )

const fileCapabilitiesFor = (node: MivoCanvasNode, fileCapability: CanvasObjectCapability) =>
  objectCapabilitiesFor(
    node,
    ['asset', fileCapability, 'downloadOriginal', 'promptSource'],
    ['asset', fileCapability, 'downloadOriginal', 'promptSource', 'exportable'],
  )

export const canvasNodeRegistry = {
  image: {
    type: 'image',
    label: 'Image',
    renderKind: 'image',
    defaultSize: { width: 320, height: 240 },
    importBehavior: 'asset-image',
    capabilities: imageCapabilitiesFor,
  },
  'task-placeholder': {
    type: 'task-placeholder',
    label: 'Task',
    renderKind: 'task',
    defaultSize: { width: 320, height: 240 },
    importBehavior: 'generated-image',
    capabilities: (node) =>
      objectCapabilitiesFor(
        node,
        ['asset', 'imageAsset', 'aiReference', 'task'],
        ['asset', 'imageAsset', 'aiReference', 'task', 'exportable'],
      ),
  },
  text: {
    type: 'text',
    label: 'Text',
    renderKind: 'text',
    defaultSize: { width: 96, height: 42 },
    importBehavior: 'text',
    capabilities: (node) =>
      objectCapabilitiesFor(node, ['text', 'promptSource'], ['text', 'promptSource', 'exportable']),
  },
  frame: {
    type: 'frame',
    label: 'Section',
    renderKind: 'section',
    defaultSize: { width: 560, height: 320 },
    importBehavior: 'section',
    capabilities: (node) => objectCapabilitiesFor(node, ['frame'], ['frame']),
  },
  'ai-slot': {
    type: 'ai-slot',
    label: 'AI Slot',
    renderKind: 'ai-slot',
    defaultSize: { width: 320, height: 320 },
    importBehavior: 'none',
    capabilities: (node) =>
      objectCapabilitiesFor(node, ['aiSlot', 'promptSource'], ['aiSlot', 'promptSource', 'exportable']),
  },
  annotation: {
    type: 'annotation',
    label: 'Annotation',
    renderKind: 'annotation',
    defaultSize: { width: 276, height: 118 },
    importBehavior: 'none',
    capabilities: (node) =>
      objectCapabilitiesFor(
        node,
        ['text', 'annotation', 'promptSource', 'annotatable'],
        ['text', 'annotation', 'promptSource', 'annotatable', 'exportable'],
      ),
  },
  markup: {
    type: 'markup',
    label: 'Markup',
    renderKind: 'markup',
    defaultSize: { width: 220, height: 120 },
    importBehavior: 'markup',
    capabilities: (node) =>
      objectCapabilitiesFor(node, ['markup', 'annotation', 'annotatable', 'promptSource']),
  },
  markdown: {
    type: 'markdown',
    label: 'Markdown',
    renderKind: 'markdown',
    defaultSize: { width: 560, height: 320 },
    importBehavior: 'asset-markdown',
    capabilities: (node) => fileCapabilitiesFor(node, 'markdownDoc'),
  },
  pdf: {
    type: 'pdf',
    label: 'PDF',
    renderKind: 'pdf',
    defaultSize: { width: 340, height: 440 },
    importBehavior: 'asset-pdf',
    capabilities: (node) => fileCapabilitiesFor(node, 'pdfAsset'),
  },
  video: {
    type: 'video',
    label: 'Video',
    renderKind: 'video',
    defaultSize: { width: 420, height: 236 },
    importBehavior: 'asset-video',
    capabilities: (node) => fileCapabilitiesFor(node, 'videoAsset'),
  },
} satisfies Record<CanvasNodeType, CanvasNodeDefinition>

export const nodeTypeDefinitionFor = (type: CanvasNodeType): CanvasNodeDefinition =>
  canvasNodeRegistry[type]

export const nodeDefinitionFor = (node: MivoCanvasNode): CanvasNodeDefinition =>
  nodeTypeDefinitionFor(node.type)

export const capabilitiesForNode = (node: MivoCanvasNode): Set<CanvasObjectCapability> =>
  nodeDefinitionFor(node).capabilities(node)

export const renderKindForNode = (node: MivoCanvasNode): CanvasNodeRenderKind =>
  nodeDefinitionFor(node).renderKind

export const defaultSizeForNodeType = (type: CanvasNodeType) =>
  nodeTypeDefinitionFor(type).defaultSize

export const importBehaviorForNodeType = (type: CanvasNodeType) =>
  nodeTypeDefinitionFor(type).importBehavior

export const isCanvasTextNode = (node: MivoCanvasNode) => {
  const renderKind = renderKindForNode(node)
  return renderKind === 'text' || renderKind === 'annotation'
}

export const isCanvasSectionNode = (node: MivoCanvasNode) =>
  renderKindForNode(node) === 'section'
