import type { SliceCreator } from './canvasStore'
import { defaultStampKind } from '../canvas/stampDefs'
import { setNodeTransform } from '../model/documentModelV2'
import { logCanvas, warnCanvas } from './canvasStore'
import { makeNode } from './demoScenes'
import {
  cloneNode,
  cloneNodes,
  createGroupId,
  createNodeCopy,
  createNodeId,
} from './nodeFactory'
import {
  arrangedPositionsFor,
  arrangedSubjectNodesFrom,
  clipboardAssetDisplaySize,
  clipboardAssetTitle,
  defaultBrushStyle,
  defaultDocument,
  isEffectivelyLocked,
  isSectionNode,
  normalizeCanvasNodes,
  normalizeSelection,
  patchActiveCanvas,
  patchWithHistory,
  selectedIdsFromState,
  selectedNodesFromState,
} from './canvasDocumentModel'

export const createSelectionSlice: SliceCreator = (set) => ({
  selectedNodeId: defaultDocument.selectedNodeId,
  selectedNodeIds: defaultDocument.selectedNodeIds || [],
  activeTool: 'select',
  clipboardNodes: [],
  clipboardAssets: [],
  brushStyle: defaultBrushStyle,
  activeStampKind: defaultStampKind,
  // Transient: id of the most recently placed stamp; drives the drop animation. Not persisted.
  lastPlacedStampId: undefined,
  selectNode: (nodeId, options) =>
    set((state) => {
      if (!nodeId) {
        logCanvas('Selection cleared')
        return patchActiveCanvas(state, { selectedNodeId: undefined, selectedNodeIds: [] })
      }

      const target = state.nodes.find((node) => node.id === nodeId && !node.hidden)
      if (!target) {
        warnCanvas(`Selection skipped: node ${nodeId} is missing or hidden`)
        return {}
      }

      const targetNodeIds = target.groupId
        ? state.nodes
            .filter((node) => !node.hidden && node.groupId === target.groupId)
            .map((node) => node.id)
        : [nodeId]

      if (options?.additive) {
        const targetSet = new Set(targetNodeIds)
        const targetAlreadySelected = targetNodeIds.every((id) => state.selectedNodeIds.includes(id))
        const selectedNodeIds = targetAlreadySelected
          ? state.selectedNodeIds.filter((id) => !targetSet.has(id))
          : [...state.selectedNodeIds, ...targetNodeIds]
        const normalizedSelection = normalizeSelection(selectedNodeIds, state.nodes)
        const selectedNodeId = normalizedSelection.includes(state.selectedNodeId || '')
          ? state.selectedNodeId
          : normalizedSelection.at(-1)

        logCanvas(`Selection toggled: ${normalizedSelection.length} selected`)
        return patchActiveCanvas(state, { selectedNodeId, selectedNodeIds: normalizedSelection })
      }

      logCanvas(`Selected ${targetNodeIds.length === 1 ? target.title : `${targetNodeIds.length} grouped nodes`}`)
      return patchActiveCanvas(state, { selectedNodeId: nodeId, selectedNodeIds: targetNodeIds })
    }),
  selectNodes: (nodeIds, primaryNodeId) =>
    set((state) => {
      const selectedNodeIds = normalizeSelection(nodeIds, state.nodes)
      const selectedNodeId =
        primaryNodeId && selectedNodeIds.includes(primaryNodeId) ? primaryNodeId : selectedNodeIds[0]
      logCanvas(`Selected ${selectedNodeIds.length} node${selectedNodeIds.length === 1 ? '' : 's'}`)

      return patchActiveCanvas(state, { selectedNodeId, selectedNodeIds })
    }),
  setActiveTool: (toolId) => {
    logCanvas(`Tool changed to ${toolId}`)
    set({ activeTool: toolId })
  },
  setBrushStyle: (style) =>
    set((state) => {
      const brushStyle = { ...state.brushStyle, ...style }
      logCanvas(`Brush style set: ${brushStyle.kind}, ${brushStyle.color}, ${brushStyle.width}px`)
      return { brushStyle }
    }),
  setActiveStampKind: (kind) => {
    logCanvas(`Stamp kind set to ${kind}`)
    set({ activeStampKind: kind })
  },
  noteStampPlaced: (id) => {
    set({ lastPlacedStampId: id })
    // Clear after the drop animation so the impact lines disappear.
    window.setTimeout(() => {
      set((state) => (state.lastPlacedStampId === id ? { lastPlacedStampId: undefined } : {}))
    }, 520)
  },
  eraseMarkupStrokes: (nodeIds) =>
    set((state) => {
      // History is captured once per eraser drag by the interaction controller,
      // so repeated calls during one drag stay a single undo step.
      const erasableSet = new Set(
        nodeIds.filter((nodeId) => {
          const node = state.nodes.find((item) => item.id === nodeId)
          return (
            node &&
            node.type === 'markup' &&
            node.markupKind === 'brush' &&
            !isEffectivelyLocked(state.nodes, node)
          )
        }),
      )
      if (!erasableSet.size) return {}

      logCanvas(`Erased ${erasableSet.size} brush stroke${erasableSet.size === 1 ? '' : 's'}`)

      return patchActiveCanvas(state, {
        selectedNodeId: erasableSet.has(state.selectedNodeId || '') ? undefined : state.selectedNodeId,
        selectedNodeIds: state.selectedNodeIds.filter((nodeId) => !erasableSet.has(nodeId)),
        nodes: normalizeCanvasNodes(state.nodes.filter((node) => !erasableSet.has(node.id))),
      })
    }),
  alignSelectedNodes: (alignment) =>
    set((state) => {
      const selectedNodes = selectedNodesFromState(state)
      if (selectedNodes.length < 2) return {}

      const minX = Math.min(...selectedNodes.map((node) => node.x))
      const maxX = Math.max(...selectedNodes.map((node) => node.x + node.width))
      const minY = Math.min(...selectedNodes.map((node) => node.y))
      const maxY = Math.max(...selectedNodes.map((node) => node.y + node.height))
      const centerX = minX + (maxX - minX) / 2
      const centerY = minY + (maxY - minY) / 2
      const selectedSet = new Set(selectedNodes.map((node) => node.id))
      const nodes = state.nodes.map((node) => {
        if (!selectedSet.has(node.id) || node.locked) return node

        if (alignment === 'left') return setNodeTransform(node, { x: Math.round(minX) })
        if (alignment === 'center') return setNodeTransform(node, { x: Math.round(centerX - node.width / 2) })
        if (alignment === 'right') return setNodeTransform(node, { x: Math.round(maxX - node.width) })
        if (alignment === 'top') return setNodeTransform(node, { y: Math.round(minY) })
        if (alignment === 'middle') return setNodeTransform(node, { y: Math.round(centerY - node.height / 2) })
        return setNodeTransform(node, { y: Math.round(maxY - node.height) })
      })

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
    }),
  distributeSelectedNodes: (axis) =>
    set((state) => {
      const selectedNodes = selectedNodesFromState(state)
      if (selectedNodes.length < 3) return {}

      const sorted = [...selectedNodes].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y))
      const start = axis === 'horizontal' ? sorted[0].x : sorted[0].y
      const end =
        axis === 'horizontal'
          ? sorted[sorted.length - 1].x + sorted[sorted.length - 1].width
          : sorted[sorted.length - 1].y + sorted[sorted.length - 1].height
      const totalSize = sorted.reduce((sum, node) => sum + (axis === 'horizontal' ? node.width : node.height), 0)
      const gap = (end - start - totalSize) / (sorted.length - 1)
      let cursor = start
      const positions = new Map<string, number>()

      sorted.forEach((node) => {
        positions.set(node.id, Math.round(cursor))
        cursor += (axis === 'horizontal' ? node.width : node.height) + gap
      })

      const nodes = state.nodes.map((node) => {
        const position = positions.get(node.id)
        if (position === undefined || node.locked) return node
        return axis === 'horizontal' ? setNodeTransform(node, { x: position }) : setNodeTransform(node, { y: position })
      })

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
    }),
  arrangeSelectedNodes: (mode) =>
    set((state) => {
      const selectedNodes = selectedNodesFromState(state)
      const subjectNodes = arrangedSubjectNodesFrom(state.nodes, selectedNodes)
      if (subjectNodes.length < 2) return {}

      const positions = arrangedPositionsFor(subjectNodes, mode)
      if (!positions.size) return {}

      const sectionDeltas = new Map<string, { dx: number; dy: number }>()

      subjectNodes.forEach((node) => {
        const position = positions.get(node.id)
        if (!position || !isSectionNode(node)) return

        sectionDeltas.set(node.id, {
          dx: Math.round(position.x - node.x),
          dy: Math.round(position.y - node.y),
        })
      })

      let changed = false
      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) => {
          const position = positions.get(node.id)
          if (position) {
            if (node.x !== position.x || node.y !== position.y) changed = true
            return setNodeTransform(node, {
              x: position.x,
              y: position.y,
            })
          }

          const sectionDelta = node.sectionId ? sectionDeltas.get(node.sectionId) : undefined
          if (!sectionDelta || isEffectivelyLocked(state.nodes, node)) return node
          if (!sectionDelta.dx && !sectionDelta.dy) return node

          changed = true
          return setNodeTransform(node, {
            x: Math.round(node.x + sectionDelta.dx),
            y: Math.round(node.y + sectionDelta.dy),
          })
        }),
      )

      if (!changed) return {}

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds: state.selectedNodeIds })
    }),
  copySelectedNodes: () =>
    set((state) => {
      const selectedNodes = selectedNodesFromState(state)
      if (!selectedNodes.length) return {}

      return { clipboardNodes: cloneNodes(selectedNodes), clipboardAssets: [] }
    }),
  cutSelectedNodes: () =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (!selectedNodeIds.length) return {}

      const removedSet = new Set(
        selectedNodeIds.filter((nodeId) => {
          const node = state.nodes.find((item) => item.id === nodeId)
          return node && !isEffectivelyLocked(state.nodes, node)
        }),
      )
      state.nodes.forEach((node) => {
        if (removedSet.has(node.id) && isSectionNode(node)) {
          state.nodes
            .filter((child) => child.sectionId === node.id && !isEffectivelyLocked(state.nodes, child))
            .forEach((child) => removedSet.add(child.id))
        }
      })
      if (!removedSet.size) return {}

      logCanvas(`Cut ${removedSet.size} node${removedSet.size === 1 ? '' : 's'} to clipboard`)

      return {
        clipboardNodes: cloneNodes(state.nodes.filter((node) => removedSet.has(node.id))),
        ...patchWithHistory(state, {
          selectedNodeId: undefined,
          selectedNodeIds: [],
          nodes: normalizeCanvasNodes(state.nodes.filter((node) => !removedSet.has(node.id))),
        }),
      }
    }),
  pasteClipboardNodes: (position) =>
    set((state) => {
      if (!state.clipboardNodes.length) return {}

      const groupIdMap = new Map<string, string>()
      const clipboardIds = new Set(state.clipboardNodes.map((node) => node.id))
      const cloneIdMap = new Map<string, string>()
      const clones = state.clipboardNodes.map((node, index) => {
        const groupId = node.groupId
          ? groupIdMap.get(node.groupId) || (() => {
              const nextGroupId = createGroupId()
              groupIdMap.set(node.groupId || '', nextGroupId)
              return nextGroupId
            })()
          : undefined

        const clone = createNodeCopy(node, index, 36, { groupId })
        cloneIdMap.set(node.id, clone.id)
        return clone
      })
      // Children cut together with their Section keep membership in the pasted Section,
      // mirroring how groupId is remapped above.
      const clonesWithSections = clones.map((clone, index) => {
        const sourceSectionId = state.clipboardNodes[index].sectionId
        return sourceSectionId && clipboardIds.has(sourceSectionId)
          ? { ...clone, sectionId: cloneIdMap.get(sourceSectionId) }
          : clone
      })
      const nextClones = position
        ? (() => {
            const minX = Math.min(...clonesWithSections.map((node) => node.x))
            const maxX = Math.max(...clonesWithSections.map((node) => node.x + node.width))
            const minY = Math.min(...clonesWithSections.map((node) => node.y))
            const maxY = Math.max(...clonesWithSections.map((node) => node.y + node.height))
            const dx = Math.round(position.x - (minX + (maxX - minX) / 2))
            const dy = Math.round(position.y - (minY + (maxY - minY) / 2))

            return clonesWithSections.map((node) => setNodeTransform(node, { x: node.x + dx, y: node.y + dy }))
          })()
        : clonesWithSections

      return {
        clipboardNodes: nextClones.map(cloneNode),
        ...patchWithHistory(state, {
          selectedNodeId: nextClones[0]?.id,
          selectedNodeIds: nextClones.map((node) => node.id),
          nodes: [...state.nodes, ...nextClones],
        }),
      }
    }),
  copyAssetsToClipboard: (assets) =>
    set(() => ({
      clipboardAssets: assets.map((asset) => ({ ...asset, tags: asset.tags ? [...asset.tags] : undefined })),
      clipboardNodes: [],
    })),
  pasteClipboardAssets: (position) =>
    set((state) => {
      if (!state.clipboardAssets.length) return {}

      const start = position || { x: -64 + state.nodes.length * 16, y: -64 + state.nodes.length * 16 }
      const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(state.clipboardAssets.length))))
      const gap = 32
      const displaySizes = state.clipboardAssets.map((asset) => clipboardAssetDisplaySize(asset))
      const cellWidth = Math.max(...displaySizes.map((size) => size.width)) + gap
      const cellHeight = Math.max(...displaySizes.map((size) => size.height)) + gap
      const createdAt = Date.now()
      const nodes = state.clipboardAssets.map((asset, index) => {
        const displaySize = displaySizes[index]
        const column = index % columns
        const row = Math.floor(index / columns)
        const id = createNodeId('asset')

        return makeNode({
          id,
          type: 'image',
          title: clipboardAssetTitle(asset),
          x: Math.round(start.x + column * cellWidth),
          y: Math.round(start.y + row * cellHeight),
          width: displaySize.width,
          height: displaySize.height,
          assetUrl: asset.url,
          assetOriginalName: asset.name,
          status: 'ready',
          generation: {
            prompt: 'Eagle 素材库复制粘贴导入，可作为后续 AI 上下文',
            model: 'Imported Eagle Asset',
            size:
              asset.width && asset.height
                ? `${Math.round(asset.width)}x${Math.round(asset.height)}`
                : `${displaySize.width}x${displaySize.height}`,
            seed: createdAt % 99999,
            createdAt,
          },
        })
      })

      return patchWithHistory(state, {
        selectedNodeId: nodes[0]?.id,
        selectedNodeIds: nodes.map((node) => node.id),
        nodes: [...state.nodes, ...nodes],
      })
    }),
})
