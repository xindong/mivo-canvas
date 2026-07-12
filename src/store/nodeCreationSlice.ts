import type { SliceCreator } from './canvasStateTypes'
import { highlighterOpacity } from '../model/brushGeometry'
import { defaultStampKind, stampLabelFor } from '../canvas/stampDefs'
import { defaultSizeForNodeType } from '../model/canvasNodeRegistry'
import { defaultTextAlign, defaultTextColor, defaultTextFontSize, defaultTextWeight } from '../canvas/textGeometry'
import { markdownShouldUsePreviewMode } from '../lib/canvasAssetImport'
import { normalizeCanvasNodeV2, setNodeTransform } from '../model/documentModelV2'
import { logCanvas, warnCanvas } from './canvasStoreLog'
import { makeNode } from './demoScenes'
import { createNodeId } from './nodeFactory'
import {
  clamp,
  cropEqualsFullImage,
  defaultMarkupFillColor,
  defaultMarkupStrokeColor,
  defaultMarkupStrokeWidth,
  defaultSectionBorderColor,
  defaultSectionBorderStyle,
  defaultSectionBorderWidth,
  defaultSectionFillColor,
  importedAssetDisplaySize,
  importedAssetModelFor,
  importedAssetPromptFor,
  isEditableTextNode,
  isEffectivelyLocked,
  isSectionNode,
  normalizeCanvasNodes,
  patchActiveCanvas,
  patchCanvasDocument,
  patchWithHistory,
  targetNodeIdForMarkup,
  withFrameBehindArtwork,
} from './canvasDocumentModel'

export const createNodeCreationSlice: SliceCreator = (set, get) => ({
  addImportedImage: (assetUrl, title = 'Imported Image', size = 'source', position, metadata) => {
    logCanvas(`Import image requested: ${title}`)
    get().addImportedFileNode('image', assetUrl, title, size, position, metadata)
  },
  addImportedFileNode: (type, assetUrl, title, size = 'source', position, metadata) => {
    const id = createNodeId('imported')
    const displaySize = importedAssetDisplaySize(type, metadata)
    const markdownDisplayMode =
      type === 'markdown' && markdownShouldUsePreviewMode(metadata?.text) ? 'preview' : 'full'
    const nodeTitle =
      title?.trim() ||
      metadata?.originalName?.replace(/\.[^.]+$/, '') ||
      (type === 'markdown' ? 'Markdown document' : type === 'pdf' ? 'PDF document' : type === 'video' ? 'Video file' : 'Imported Image')
    set((state) =>
      patchWithHistory(state, {
        selectedNodeId: id,
        selectedNodeIds: [id],
        nodes: [
          ...state.nodes,
          makeNode({
            id,
            type,
            title: nodeTitle,
            text: type === 'markdown' ? metadata?.text || '' : undefined,
            x: Math.round(position?.x ?? -64 + state.nodes.length * 16),
            y: Math.round(position?.y ?? -64 + state.nodes.length * 16),
            width: displaySize.width,
            height: displaySize.height,
            assetUrl,
            assetMimeType: metadata?.mimeType,
            assetOriginalName: metadata?.originalName,
            assetSizeBytes: metadata?.sizeBytes,
            markdownDisplayMode: type === 'markdown' ? markdownDisplayMode : undefined,
            imageHasTransparency: type === 'image' ? metadata?.hasTransparency : undefined,
            assetSourceDimensions: type === 'image' ? metadata?.sourceDimensions : undefined,
            generation:
              type === 'markdown'
                ? undefined
                : {
                    prompt: importedAssetPromptFor(type),
                    model: importedAssetModelFor(type),
                    size,
                    seed: Date.now() % 99999,
                  },
          }),
        ],
      }),
    )
    logCanvas(`Imported ${type} node "${nodeTitle}" from ${metadata?.originalName || assetUrl}`)
  },
  cropImageNode: (nodeId, box) =>
    set((state) => {
      const source = state.nodes.find((node) => node.id === nodeId && node.type === 'image')
      if (!source) {
        warnCanvas(`Crop skipped: image node ${nodeId} not found`)
        return {}
      }

      const sourceWidth = Math.max(1, source.width)
      const sourceHeight = Math.max(1, source.height)
      const cropBox = {
        x: clamp(box.x, 0, sourceWidth - 1),
        y: clamp(box.y, 0, sourceHeight - 1),
        width: clamp(box.width, 1, sourceWidth),
        height: clamp(box.height, 1, sourceHeight),
      }
      cropBox.width = Math.min(cropBox.width, sourceWidth - cropBox.x)
      cropBox.height = Math.min(cropBox.height, sourceHeight - cropBox.y)

      const currentCrop = source.imageCrop || { x: 0, y: 0, width: 1, height: 1 }
      const nextCrop = {
        x: clamp(currentCrop.x + (cropBox.x / sourceWidth) * currentCrop.width, 0, 1),
        y: clamp(currentCrop.y + (cropBox.y / sourceHeight) * currentCrop.height, 0, 1),
        width: clamp((cropBox.width / sourceWidth) * currentCrop.width, 0.001, 1),
        height: clamp((cropBox.height / sourceHeight) * currentCrop.height, 0.001, 1),
      }
      nextCrop.width = Math.min(nextCrop.width, 1 - nextCrop.x)
      nextCrop.height = Math.min(nextCrop.height, 1 - nextCrop.y)

      const nodes = state.nodes.map((node) =>
        node.id === nodeId
          ? setNodeTransform({
              ...node,
              imageCrop: cropEqualsFullImage(nextCrop) ? undefined : nextCrop,
            }, {
              x: Math.round(node.x + cropBox.x),
              y: Math.round(node.y + cropBox.y),
              width: Math.round(cropBox.width),
              height: Math.round(cropBox.height),
            })
          : node,
      )

      logCanvas(`Cropped image "${source.title}"`)
      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  addFrameNode: (position, size, title) => {
    const id = createNodeId('frame')
    const defaultSize = defaultSizeForNodeType('frame')

    set((state) => {
      const frameCount = state.nodes.filter((node) => node.type === 'frame').length
      const frame = makeNode({
        id,
        type: 'frame',
        title: title || `Section ${frameCount + 1}`,
        x: Math.round(position.x),
        y: Math.round(position.y),
        width: Math.round(size?.width ?? defaultSize.width),
        height: Math.round(size?.height ?? defaultSize.height),
        frameColor: '#6957e8',
        sectionFillColor: defaultSectionFillColor,
        sectionBorderColor: defaultSectionBorderColor,
        sectionBorderWidth: defaultSectionBorderWidth,
        sectionBorderStyle: defaultSectionBorderStyle,
        sectionTitleVisible: true,
      })

      return patchWithHistory(state, {
        selectedNodeId: id,
        selectedNodeIds: [id],
        nodes: normalizeCanvasNodes(withFrameBehindArtwork(state.nodes, frame)),
      })
    })

    logCanvas(`Created section ${id}`)
    return id
  },
  addAiSlotNode: (position, size, prompt, options) => {
    const targetSceneId = options?.sceneId || get().sceneId
    const targetDocument = get().canvases[targetSceneId]
    if (!targetDocument) throw new Error('目标画布已删除，无法继续生成。')

    const id = createNodeId('ai-slot')
    const defaultSize = defaultSizeForNodeType('ai-slot')
    const width = Math.round(size?.width ?? defaultSize.width)
    const height = Math.round(size?.height ?? defaultSize.height)
    const createdAt = Date.now()
    const slotPrompt = prompt?.trim() || '等待 AI 生成的画布槽位'

    set((state) => {
      const document = state.canvases[targetSceneId]
      if (!document) return {}

      const slotCount = document.nodes.filter((node) => node.type === 'ai-slot').length
      const slot = makeNode({
        id,
        type: 'ai-slot',
        title: `AI Slot ${slotCount + 1}`,
        x: Math.round(position.x),
        y: Math.round(position.y),
        width,
        height,
        status: 'ready',
        generation: {
          prompt: slotPrompt,
          model: 'Mivo Mock Image Workflow',
          size: `${width}x${height}`,
          seed: createdAt % 99999,
        },
        aiWorkflow: {
          kind: 'slot',
          status: 'empty',
          operation: 'slot-generation',
          prompt: slotPrompt,
          placement: 'slot',
          createdAt,
        },
      })

      return patchCanvasDocument(state, targetSceneId, {
        selectedNodeId: id,
        selectedNodeIds: [id],
        nodes: normalizeCanvasNodes([...document.nodes, slot]),
      }, { history: true })
    })

    logCanvas(`Created AI slot ${id}`)
    return id
  },
  addAnnotationNode: (sourceNodeId, position, instruction, options) => {
    const id = createNodeId('annotation')
    const defaultSize = defaultSizeForNodeType('annotation')
    const createdAt = Date.now()
    let created = false

    set((state) => {
      const source =
        state.nodes.find((node) => node.id === sourceNodeId && !node.hidden) ||
        state.nodes.find((node) => node.id === state.selectedNodeId && !node.hidden)
      if (!source) {
        warnCanvas('Annotation creation skipped: no source node selected')
        return {}
      }

      const note = instruction?.trim() || 'Describe the image edit here'
      const x = Math.round(position?.x ?? source.x + 28)
      const y = Math.round(position?.y ?? source.y - 132)
      const annotation = makeNode({
        id,
        type: 'annotation',
        title: options?.title || `Edit note for ${source.title}`,
        text: note,
        fontSize: 18,
        textColor: '#4f4548',
        fontWeight: 720,
        textAlign: 'left',
        textAutoWidth: false,
        x,
        y,
        width: defaultSize.width,
        height: defaultSize.height,
        status: 'ready',
        parentIds: [source.id],
        generation: {
          prompt: note,
          model: 'Annotation brief',
          size: 'canvas-note',
          seed: createdAt % 99999,
        },
        aiWorkflow: {
          kind: 'annotation',
          status: 'ready',
          operation: options?.operation || 'annotation-edit',
          prompt: note,
          sourceNodeIds: [source.id],
          anchorNodeId: source.id,
          createdAt,
        },
      })
      created = true

      return patchWithHistory(state, {
        selectedNodeId: id,
        selectedNodeIds: [id],
        nodes: normalizeCanvasNodes([...state.nodes, annotation]),
      })
    })

    if (created) logCanvas(`Created annotation ${id}`)
    return created ? id : undefined
  },
  addMarkupNode: (kind, position, geometry, options) => {
    const id = createNodeId('markup')
    const defaultSize = defaultSizeForNodeType('markup')
    const width = Math.max(18, Math.round(geometry?.width ?? defaultSize.width))
    const height = Math.max(18, Math.round(geometry?.height ?? defaultSize.height))
    const title =
      kind === 'arrow'
        ? 'Arrow annotation'
        : kind === 'line'
          ? 'Line annotation'
          : kind === 'rect'
            ? 'Rectangle annotation'
            : kind === 'ellipse'
              ? 'Ellipse annotation'
              : kind === 'brush'
                ? 'Brush annotation'
                : kind === 'stamp'
                  ? `Stamp ${stampLabelFor(options?.stampKind)}`
                  : 'Markup note'

    set((state) => {
      const draft = makeNode({
        id,
        type: 'markup',
        title,
        text: options?.text || (kind === 'note' ? 'Note' : undefined),
        fontSize: kind === 'note' ? 18 : defaultTextFontSize,
        textColor: defaultTextColor,
        fontWeight: kind === 'note' ? 760 : defaultTextWeight,
        textAlign: kind === 'note' ? defaultTextAlign : 'center',
        textAutoWidth: false,
        x: Math.round(position.x),
        y: Math.round(position.y),
        width,
        height,
        status: 'ready',
        markupKind: kind,
        markupBrushKind: kind === 'brush' ? options?.brushKind || 'marker' : undefined,
        markupStampKind: kind === 'stamp' ? options?.stampKind || defaultStampKind : undefined,
        markupPoints: options?.points?.map((point) => ({
          x: Math.round(point.x),
          y: Math.round(point.y),
          ...(point.pressure !== undefined ? { pressure: point.pressure } : {}),
        })),
        markupStrokeColor: options?.strokeColor || defaultMarkupStrokeColor,
        markupFillColor: options?.fillColor || (kind === 'note' ? '#fff1a8' : defaultMarkupFillColor),
        markupStrokeWidth: options?.strokeWidth || defaultMarkupStrokeWidth,
        markupStrokeStyle: options?.strokeStyle || 'solid',
        markupOpacity: kind === 'brush' && options?.brushKind === 'highlighter' ? highlighterOpacity : 1,
        markupStartArrow: options?.startArrow ?? false,
        markupEndArrow: options?.endArrow ?? kind === 'arrow',
        markupCornerRadius: 4,
        connectorStart: options?.connectorStart,
        connectorEnd: options?.connectorEnd,
        generation: {
          prompt: options?.text || title,
          model: 'Canvas markup',
          size: `${width}x${height}`,
          seed: Date.now() % 99999,
        },
      })
      const targetNodeId = targetNodeIdForMarkup(state.nodes, draft)
      const markup = targetNodeId ? { ...draft, targetNodeId, parentIds: [targetNodeId] } : draft

      return patchWithHistory(state, {
        selectedNodeId: options?.select === false ? state.selectedNodeId : id,
        selectedNodeIds: options?.select === false ? state.selectedNodeIds : [id],
        nodes: normalizeCanvasNodes([...state.nodes, markup]),
      })
    })

    logCanvas(`Created ${kind} markup ${id}`)
    return id
  },
  updateMarkupGeometry: (nodeId, geometry, points, bindings) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markup')
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId
            ? setNodeTransform({
                ...node,
                markupPoints: points?.map((point) => ({
                  x: Math.round(point.x),
                  y: Math.round(point.y),
                })),
                ...(bindings && 'connectorStart' in bindings
                  ? { connectorStart: bindings.connectorStart || undefined }
                  : {}),
                ...(bindings && 'connectorEnd' in bindings
                  ? { connectorEnd: bindings.connectorEnd || undefined }
                  : {}),
              }, {
                x: Math.round(geometry.x),
                y: Math.round(geometry.y),
                width: Math.round(geometry.width),
                height: Math.round(geometry.height),
              })
            : node,
        ),
      )

      return patchActiveCanvas(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  updateMarkupStyle: (nodeId, style) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markup')
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = state.nodes.map((node) =>
        node.id === nodeId
          ? normalizeCanvasNodeV2({ ...node, ...style, fills: undefined, strokes: undefined })
          : node,
      )
      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  updateSectionStyle: (nodeId, style) =>
    set((state) => {
      const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
      if (!section || section.locked) return {}

      const nodes = state.nodes.map((node) =>
        node.id === nodeId
          ? normalizeCanvasNodeV2({ ...node, ...style, fills: undefined, strokes: undefined })
          : node,
      )
      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  setSectionLockMode: (nodeId, mode) =>
    set((state) => {
      const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
      if (!section) return {}

      const nodes = state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              locked: Boolean(mode),
              sectionLockMode: mode,
            }
          : node,
      )
      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  removeSectionOnly: (nodeId) =>
    set((state) => {
      const section = state.nodes.find((node) => node.id === nodeId && isSectionNode(node))
      if (!section || isEffectivelyLocked(state.nodes, section)) return {}

      const nodes = state.nodes
        .filter((node) => node.id !== nodeId)
        .map((node) => (node.sectionId === nodeId ? { ...node, sectionId: undefined } : node))

      return patchWithHistory(state, {
        nodes,
        selectedNodeId: undefined,
        selectedNodeIds: [],
      })
    }),
  renameNode: (nodeId, title) =>
    set((state) => {
      const nextTitle = title.trim()
      if (!nextTitle) return {}
      const target = state.nodes.find((node) => node.id === nodeId)
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = state.nodes.map((node) => (node.id === nodeId ? { ...node, title: nextTitle } : node))
      return patchWithHistory(state, { nodes })
    }),
  addTextNode: (position, text = '') => {
    const id = `text-${Date.now()}`
    const defaultSize = defaultSizeForNodeType('text')

    set((state) =>
      patchWithHistory(state, {
        selectedNodeId: id,
        selectedNodeIds: [id],
        nodes: [
          ...state.nodes,
          makeNode({
            id,
            type: 'text',
            title: text.trim() || 'Text',
            text,
            fontSize: defaultTextFontSize,
            textColor: defaultTextColor,
            fontWeight: defaultTextWeight,
            textAlign: defaultTextAlign,
            textAutoWidth: true,
            x: Math.round(position.x),
            y: Math.round(position.y),
            width: defaultSize.width,
            height: defaultSize.height,
          }),
        ],
      }),
    )

    logCanvas(`Created text node ${id}`)
    return id
  },
  updateTextNode: (nodeId, text, geometry) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId && isEditableTextNode(node)
          ? (() => {
              const nextNode = {
                ...node,
                title: node.type === 'markup' ? node.title : text.trim() || 'Text',
                text,
                generation:
                  node.type === 'markup' && node.generation
                    ? {
                        ...node.generation,
                        prompt: text.trim() || node.title,
                      }
                    : node.generation,
              }

              return geometry && node.type !== 'markup'
                ? setNodeTransform(nextNode, {
                    width: Math.round(geometry.width),
                    height: Math.round(geometry.height),
                  })
                : nextNode
            })()
          : node,
      )

      return patchActiveCanvas(state, { nodes })
    }),
  updateTextStyle: (nodeId, style, geometry) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId && isEditableTextNode(node)
          ? geometry && node.type !== 'markup'
            ? setNodeTransform({ ...node, ...style }, {
                width: Math.round(geometry.width),
                height: Math.round(geometry.height),
              })
            : { ...node, ...style }
          : node,
      )

      return patchWithHistory(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  resizeTextNode: (nodeId, x, width, height) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId && isEditableTextNode(node)
          ? setNodeTransform({
              ...node,
              textAutoWidth: false,
            }, {
              x: Math.round(x),
              width: Math.round(width),
              height: Math.round(height),
            })
          : node,
      )

      return patchActiveCanvas(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
})
