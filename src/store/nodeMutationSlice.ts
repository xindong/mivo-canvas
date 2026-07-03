import type { SliceCreator } from './canvasStore'
import { setNodeTransform } from '../model/documentModelV2'
import { warnCanvas } from './canvasStore'
import { createGroupId, createNodeCopy } from './nodeFactory'
import {
  childIdsForSections,
  isEffectivelyLocked,
  isSectionNode,
  normalizeCanvasNodes,
  patchActiveCanvas,
  patchWithHistory,
  selectedIdsFromState,
  selectedNodesFromState,
} from './canvasDocumentModel'
import {
  addAnchorToNode,
  createAnchor,
  recordAnchorResultOnNode,
  removeAnchorFromNode,
  updateAnchorInstruction,
} from '../model/anchorModel'

export const createNodeMutationSlice: SliceCreator = (set, get) => ({
  updateNodePosition: (nodeId, x, y) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId)
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId ? setNodeTransform(node, { x: Math.round(x), y: Math.round(y) }) : node,
        ),
      )

      return patchActiveCanvas(state, { nodes })
    }),
  updateSelectedNodesPosition: (anchorNodeId, x, y) =>
    set((state) => {
      const anchor = state.nodes.find((node) => node.id === anchorNodeId)
      if (!anchor || isEffectivelyLocked(state.nodes, anchor)) return {}

      const selectedNodeIds = state.selectedNodeIds.includes(anchorNodeId)
        ? state.selectedNodeIds
        : [anchorNodeId]
      const selectedSet = new Set(selectedNodeIds)
      const movingSectionIds = new Set(
        state.nodes
          .filter((node) => selectedSet.has(node.id) && isSectionNode(node) && !isEffectivelyLocked(state.nodes, node))
          .map((node) => node.id),
      )
      const moveSet = new Set([...selectedNodeIds, ...childIdsForSections(state.nodes, movingSectionIds)])
      const dx = Math.round(x - anchor.x)
      const dy = Math.round(y - anchor.y)
      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          moveSet.has(node.id) && !isEffectivelyLocked(state.nodes, node)
            ? setNodeTransform(node, { x: node.x + dx, y: node.y + dy })
            : node,
        ),
      )

      return patchActiveCanvas(state, { nodes, selectedNodeId: anchorNodeId, selectedNodeIds })
    }),
  updateNodeGeometry: (nodeId, x, y, width, height) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId)
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId
            ? setNodeTransform(node, {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
              })
            : node,
        ),
      )

      return patchActiveCanvas(state, { nodes, selectedNodeId: nodeId, selectedNodeIds: [nodeId] })
    }),
  updateNodesGeometry: (updates) =>
    set((state) => {
      if (!updates.length) return {}

      const updatesById = new Map(updates.map((update) => [update.id, update]))
      const nodes = normalizeCanvasNodes(state.nodes.map((node) => {
        const update = updatesById.get(node.id)
        if (!update || isEffectivelyLocked(state.nodes, node)) return node

        return setNodeTransform(node, {
          x: Math.round(update.x),
          y: Math.round(update.y),
          width: Math.round(update.width),
          height: Math.round(update.height),
        })
      }))

      return patchActiveCanvas(state, {
        nodes,
        selectedNodeId: state.selectedNodeId,
        selectedNodeIds: state.selectedNodeIds,
      })
    }),
  updateNodeMeasuredSize: (nodeId, width, height) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId)
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nextWidth = Math.max(120, Math.round(width))
      const nextHeight = Math.max(80, Math.round(height))
      if (Math.abs(target.width - nextWidth) < 1 && Math.abs(target.height - nextHeight) < 1) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId
            ? setNodeTransform(node, {
                width: nextWidth,
                height: nextHeight,
              })
            : node,
        ),
      )

      return patchActiveCanvas(state, { nodes })
    }),
  setMarkdownDisplayMode: (nodeId, mode) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId && node.type === 'markdown')
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const nextHeight = mode === 'preview' ? Math.min(target.height, 620) : target.height
      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          node.id === nodeId
            ? setNodeTransform({
                ...node,
                markdownDisplayMode: mode,
              }, { height: Math.max(320, Math.round(nextHeight)) })
            : node,
        ),
      )

      return patchWithHistory(state, { nodes })
    }),
  moveSelectedNodesBy: (dx, dy) =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (!selectedNodeIds.length) return {}

      const selectedSet = new Set(selectedNodeIds)
      const movingSectionIds = new Set(
        state.nodes
          .filter((node) => selectedSet.has(node.id) && isSectionNode(node) && !isEffectivelyLocked(state.nodes, node))
          .map((node) => node.id),
      )
      const moveSet = new Set([...selectedNodeIds, ...childIdsForSections(state.nodes, movingSectionIds)])
      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) =>
          moveSet.has(node.id) && !isEffectivelyLocked(state.nodes, node)
            ? setNodeTransform(node, { x: node.x + dx, y: node.y + dy })
            : node,
        ),
      )

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
    }),
  duplicateNode: (nodeId) =>
    set((state) => {
      const source = state.nodes.find((node) => node.id === nodeId)
      if (!source) return {}

      const clone = createNodeCopy(source, 0)

      return patchWithHistory(state, {
        selectedNodeId: clone.id,
        selectedNodeIds: [clone.id],
        nodes: [...state.nodes, clone],
      })
    }),
  duplicateSelectedNodes: () =>
    set((state) => {
      const selectedNodes = selectedNodesFromState(state)
      if (!selectedNodes.length) return {}

      const groupIdMap = new Map<string, string>()
      const clones = selectedNodes.map((node, index) => {
        const groupId = node.groupId
          ? groupIdMap.get(node.groupId) || (() => {
              const nextGroupId = createGroupId()
              groupIdMap.set(node.groupId || '', nextGroupId)
              return nextGroupId
            })()
          : undefined

        return createNodeCopy(node, index, 28, { groupId })
      })

      return patchWithHistory(state, {
        selectedNodeId: clones[0]?.id,
        selectedNodeIds: clones.map((node) => node.id),
        nodes: [...state.nodes, ...clones],
      })
    }),
  groupSelectedNodes: () =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (selectedNodeIds.length < 2) return {}

      const groupId = createGroupId()
      const selectedSet = new Set(selectedNodeIds)
      const nodes = state.nodes.map((node) => (selectedSet.has(node.id) ? { ...node, groupId } : node))

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
    }),
  ungroupSelectedNodes: () =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (!selectedNodeIds.length) return {}

      const selectedNodes = state.nodes.filter((node) => selectedNodeIds.includes(node.id))
      const groupIds = new Set(selectedNodes.map((node) => node.groupId).filter(Boolean))
      if (!groupIds.size) return {}

      const nodes = state.nodes.map((node) =>
        node.groupId && groupIds.has(node.groupId) ? { ...node, groupId: undefined } : node,
      )
      const nextSelectedNodeIds = nodes
        .filter((node) => !node.hidden && selectedNodeIds.includes(node.id))
        .map((node) => node.id)

      return patchWithHistory(state, {
        nodes,
        selectedNodeId: nextSelectedNodeIds[0],
        selectedNodeIds: nextSelectedNodeIds,
      })
    }),
  moveNodeLayer: (nodeId, move) =>
    set((state) => {
      const index = state.nodes.findIndex((node) => node.id === nodeId)
      if (index < 0) return {}
      if (isEffectivelyLocked(state.nodes, state.nodes[index])) return {}

      const nodes = [...state.nodes]
      const [node] = nodes.splice(index, 1)
      const nextIndex =
        move === 'front'
          ? nodes.length
          : move === 'back'
            ? 0
            : move === 'forward'
              ? Math.min(index + 1, nodes.length)
              : Math.max(index - 1, 0)

      nodes.splice(nextIndex, 0, node)

      return patchWithHistory(state, {
        selectedNodeId: nodeId,
        selectedNodeIds: state.selectedNodeIds.includes(nodeId) ? state.selectedNodeIds : [nodeId],
        nodes,
      })
    }),
  moveSelectedLayer: (move) =>
    set((state) => {
      const lockedNodeIds = new Set(
        state.nodes.filter((node) => isEffectivelyLocked(state.nodes, node)).map((node) => node.id),
      )
      const selectedNodeIds = selectedIdsFromState(state).filter((nodeId) => !lockedNodeIds.has(nodeId))
      if (!selectedNodeIds.length) return {}

      const selectedSet = new Set(selectedNodeIds)
      let nodes = [...state.nodes]

      if (move === 'front') {
        nodes = [...nodes.filter((node) => !selectedSet.has(node.id)), ...nodes.filter((node) => selectedSet.has(node.id))]
      } else if (move === 'back') {
        nodes = [...nodes.filter((node) => selectedSet.has(node.id)), ...nodes.filter((node) => !selectedSet.has(node.id))]
      } else if (move === 'forward') {
        for (let index = nodes.length - 2; index >= 0; index -= 1) {
          if (selectedSet.has(nodes[index].id) && !selectedSet.has(nodes[index + 1].id)) {
            const current = nodes[index]
            nodes[index] = nodes[index + 1]
            nodes[index + 1] = current
          }
        }
      } else {
        for (let index = 1; index < nodes.length; index += 1) {
          if (selectedSet.has(nodes[index].id) && !selectedSet.has(nodes[index - 1].id)) {
            const current = nodes[index]
            nodes[index] = nodes[index - 1]
            nodes[index - 1] = current
          }
        }
      }

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
    }),
  deleteNode: (nodeId) =>
    set((state) => {
      const target = state.nodes.find((node) => node.id === nodeId)
      if (!target || isEffectivelyLocked(state.nodes, target)) return {}

      const deletedIds = new Set([
        nodeId,
        ...(isSectionNode(target) ? state.nodes.filter((node) => node.sectionId === nodeId).map((node) => node.id) : []),
      ])
      const selectedNodeIds = state.selectedNodeIds.filter((id) => !deletedIds.has(id))

      return patchWithHistory(state, {
        selectedNodeId: deletedIds.has(state.selectedNodeId || '') ? selectedNodeIds[0] : state.selectedNodeId,
        selectedNodeIds,
        nodes: normalizeCanvasNodes(state.nodes.filter((node) => !deletedIds.has(node.id))),
        edges: state.edges.filter((edge) => !deletedIds.has(edge.from) && !deletedIds.has(edge.to)),
      })
    }),
  deleteSelectedNodes: () =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (!selectedNodeIds.length) return {}

      const selectedSet = new Set(
        selectedNodeIds.filter((nodeId) => {
          const node = state.nodes.find((item) => item.id === nodeId)
          return node && !isEffectivelyLocked(state.nodes, node)
        }),
      )
      state.nodes.forEach((node) => {
        if (selectedSet.has(node.id) && isSectionNode(node)) {
          state.nodes
            .filter((child) => child.sectionId === node.id && !isEffectivelyLocked(state.nodes, child))
            .forEach((child) => selectedSet.add(child.id))
        }
      })
      if (!selectedSet.size) return {}

      return patchWithHistory(state, {
        selectedNodeId: undefined,
        selectedNodeIds: [],
        nodes: normalizeCanvasNodes(state.nodes.filter((node) => !selectedSet.has(node.id))),
        edges: state.edges.filter((edge) => !selectedSet.has(edge.from) && !selectedSet.has(edge.to)),
      })
    }),
  toggleSelectedNodesLocked: () =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (!selectedNodeIds.length) return {}

      const selectedSet = new Set(selectedNodeIds)
      const selectedNodes = state.nodes.filter((node) => selectedSet.has(node.id))
      const shouldLock = selectedNodes.some((node) => !node.locked)
      const nodes = state.nodes.map((node) =>
        selectedSet.has(node.id) ? { ...node, locked: shouldLock } : node,
      )

      return patchWithHistory(state, { nodes, selectedNodeId: state.selectedNodeId, selectedNodeIds })
    }),
  hideSelectedNodes: () =>
    set((state) => {
      const selectedNodeIds = selectedIdsFromState(state)
      if (!selectedNodeIds.length) return {}

      const selectedSet = new Set(selectedNodeIds)
      state.nodes.forEach((node) => {
        if (selectedSet.has(node.id) && isSectionNode(node)) {
          state.nodes.filter((child) => child.sectionId === node.id).forEach((child) => selectedSet.add(child.id))
        }
      })
      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) => (selectedSet.has(node.id) ? { ...node, hidden: true } : node)),
      )

      return patchWithHistory(state, {
        nodes,
        selectedNodeId: undefined,
        selectedNodeIds: [],
      })
    }),
  showAllHiddenNodes: () =>
    set((state) => {
      if (!state.nodes.some((node) => node.hidden)) return {}

      const nodes = normalizeCanvasNodes(
        state.nodes.map((node) => (node.hidden ? { ...node, hidden: undefined } : node)),
      )

      return patchWithHistory(state, { nodes })
    }),
  toggleFavorite: (nodeId) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId ? { ...node, favorited: !node.favorited } : node,
      )

      return patchWithHistory(state, { nodes })
    }),
  updatePrompt: (nodeId, prompt) =>
    set((state) => {
      const nodes = state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              generation: {
                prompt,
                model: node.generation?.model || 'Mivo Character v3',
                size: node.generation?.size || '1024x1365',
                seed: node.generation?.seed || 0,
                strength: node.generation?.strength,
                taskId: node.generation?.taskId,
              },
            }
          : node,
      )

      return patchActiveCanvas(state, { nodes })
    }),
  // P2-D1 EXPERIMENTAL — Anchor MVP actions. Pure logic lives in anchorModel;
  // these wire it to the store + history (patchWithHistory so undo/redo covers
  // anchor edits). Migration rule (§9 P4-a):收编为 formal CanvasAnchor or remove.
  addAnchor: (nodeId, input) => {
    const target = get().nodes.find((n) => n.id === nodeId)
    if (!target) {
      warnCanvas('addAnchor: node not found')
      return undefined
    }
    const anchor = createAnchor(input)
    if (!anchor) {
      warnCanvas('addAnchor: invalid input (box requires width/height > 0)')
      return undefined
    }
    set((state) => {
      const t = state.nodes.find((n) => n.id === nodeId)
      if (!t) return {}
      const updated = addAnchorToNode(t, anchor)
      const nodes = normalizeCanvasNodes(state.nodes.map((n) => (n.id === nodeId ? updated : n)))
      return patchWithHistory(state, { nodes })
    })
    return anchor.id
  },
  updateAnchorInstruction: (nodeId, anchorId, instruction) =>
    set((state) => {
      const target = state.nodes.find((n) => n.id === nodeId)
      if (!target) return {}
      const updated = updateAnchorInstruction(target, anchorId, instruction)
      if (updated === target) return {}
      const nodes = normalizeCanvasNodes(state.nodes.map((n) => (n.id === nodeId ? updated : n)))
      return patchWithHistory(state, { nodes })
    }),
  removeAnchor: (nodeId, anchorId) =>
    set((state) => {
      const target = state.nodes.find((n) => n.id === nodeId)
      if (!target) return {}
      const updated = removeAnchorFromNode(target, anchorId)
      if (updated === target) return {}
      const nodes = normalizeCanvasNodes(state.nodes.map((n) => (n.id === nodeId ? updated : n)))
      return patchWithHistory(state, { nodes })
    }),
  recordAnchorResult: (nodeId, anchorId, resultNodeIds) =>
    set((state) => {
      const target = state.nodes.find((n) => n.id === nodeId)
      if (!target) return {}
      const updated = recordAnchorResultOnNode(target, anchorId, resultNodeIds)
      if (updated === target) return {}
      const nodes = normalizeCanvasNodes(state.nodes.map((n) => (n.id === nodeId ? updated : n)))
      return patchWithHistory(state, { nodes })
    }),
})
