import { useEffect, useMemo, useRef, useState } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { debugLogger } from '../store/debugLogStore'
import type { CullingMode } from '../render/cullingMode'
import { virtualizationMode } from '../render/virtualizationMode'
import type { Viewport } from './canvasInteraction'

const legacyOverscanPx = 520
const virtualizedOverscanPx = 0
const virtualizedBatchSize = 420

type VirtualizationStats = {
  mode: 'on' | 'off'
  active: boolean
  pending: boolean
  targetNodeCount: number
  materializedNodeCount: number
  overscanPx: number
  batchRuns: number
  reconcileVersion: number
}

type Options = {
  cullingMode: CullingMode
  visibleNodes: MivoCanvasNode[]
  shellSize: { width: number; height: number }
  viewport: Viewport
  selectedNodeId?: string
  selectedNodeIds: string[]
  cropNodeId?: string
  maskEditNodeId?: string
  contextMenuNodeId?: string
}

const rectsIntersectInclusive = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x + a.width >= b.x && b.x + b.width >= a.x && a.y + a.height >= b.y && b.y + b.height >= a.y

const emptyStats = (mode: VirtualizationStats['mode'], active: boolean): VirtualizationStats => ({
  mode,
  active,
  pending: false,
  targetNodeCount: 0,
  materializedNodeCount: 0,
  overscanPx: active ? virtualizedOverscanPx : legacyOverscanPx,
  batchRuns: 0,
  reconcileVersion: 0,
})

const fallbackReasonFor = ({ cullingMode, shellSize }: Pick<Options, 'cullingMode' | 'shellSize'>) => {
  if (cullingMode === 'off') return 'culling=off'
  if (!shellSize.width || !shellSize.height) return 'shell-size-missing'
  return undefined
}

export const useCanvasVirtualization = ({
  cullingMode,
  visibleNodes,
  shellSize,
  viewport,
  selectedNodeId,
  selectedNodeIds,
  cropNodeId,
  maskEditNodeId,
  contextMenuNodeId,
}: Options) => {
  const requested = virtualizationMode === 'on'
  const fallbackReason = requested ? fallbackReasonFor({ cullingMode, shellSize }) : undefined
  const active = requested && !fallbackReason
  const fallbackLoggedRef = useRef<string | undefined>(undefined)
  const materializedIdsRef = useRef<string[]>([])
  const [materializedIds, setMaterializedIds] = useState<string[]>([])
  const [batchStats, setBatchStats] = useState({ pending: false, batchRuns: 0, reconcileVersion: 0 })

  useEffect(() => {
    if (!fallbackReason || fallbackLoggedRef.current === fallbackReason) return
    fallbackLoggedRef.current = fallbackReason
    debugLogger.warn('Renderer', `DOM virtualization requested but inactive: ${fallbackReason}`)
  }, [fallbackReason])

  useEffect(() => {
    materializedIdsRef.current = materializedIds
  }, [materializedIds])

  const target = useMemo(() => {
    const overscanPx = active ? virtualizedOverscanPx : legacyOverscanPx
    let nodes: MivoCanvasNode[]

    if (cullingMode === 'off' || !shellSize.width || !shellSize.height) {
      nodes = visibleNodes
    } else {
      const viewportRect = {
        x: (-viewport.x - overscanPx) / viewport.scale,
        y: (-viewport.y - overscanPx) / viewport.scale,
        width: (shellSize.width + overscanPx * 2) / viewport.scale,
        height: (shellSize.height + overscanPx * 2) / viewport.scale,
      }
      const pinnedNodeIds = new Set<string>()
      if (!active) {
        for (const id of selectedNodeIds) pinnedNodeIds.add(id)
      }
      if (selectedNodeId) pinnedNodeIds.add(selectedNodeId)
      if (cropNodeId) pinnedNodeIds.add(cropNodeId)
      if (maskEditNodeId) pinnedNodeIds.add(maskEditNodeId)
      if (contextMenuNodeId) pinnedNodeIds.add(contextMenuNodeId)

      nodes = visibleNodes.filter((node) => pinnedNodeIds.has(node.id) || rectsIntersectInclusive(node, viewportRect))
    }

    return nodes
  }, [
    active,
    contextMenuNodeId,
    cropNodeId,
    cullingMode,
    maskEditNodeId,
    selectedNodeId,
    selectedNodeIds,
    shellSize.height,
    shellSize.width,
    viewport.scale,
    viewport.x,
    viewport.y,
    visibleNodes,
  ])

  const targetIds = useMemo(() => target.map((node) => node.id), [target])

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    let frame = 0
    const targetSet = new Set(targetIds)
    let nextIds = materializedIdsRef.current.filter((id) => targetSet.has(id))
    let cursor = 0

    frame = window.requestAnimationFrame(() => {
      if (cancelled) return
      setBatchStats((current) => ({ ...current, pending: true, batchRuns: current.batchRuns + 1 }))

      const pump = () => {
        if (cancelled) return
        try {
          const nextSet = new Set(nextIds)
          let added = 0
          while (cursor < targetIds.length && added < virtualizedBatchSize) {
            const id = targetIds[cursor]
            cursor += 1
            if (nextSet.has(id)) continue
            nextIds = [...nextIds, id]
            nextSet.add(id)
            added += 1
          }
          materializedIdsRef.current = nextIds
          setMaterializedIds(nextIds)

          const done = nextIds.length === targetIds.length
          setBatchStats((current) => ({
            pending: !done,
            batchRuns: current.batchRuns,
            reconcileVersion: done ? current.reconcileVersion + 1 : current.reconcileVersion,
          }))
          if (!done) frame = window.requestAnimationFrame(pump)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          debugLogger.error('Renderer', `DOM virtualization batch failed: ${message}`)
          setBatchStats((current) => ({ ...current, pending: false }))
        }
      }

      pump()
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [active, targetIds])

  const nodeById = useMemo(() => new Map(visibleNodes.map((node) => [node.id, node])), [visibleNodes])
  const nodes = useMemo(
    () => (active ? materializedIds.map((id) => nodeById.get(id)).filter((node): node is MivoCanvasNode => Boolean(node)) : target),
    [active, materializedIds, nodeById, target],
  )
  const stats: VirtualizationStats = {
    ...emptyStats(virtualizationMode, active),
    pending: active ? batchStats.pending || nodes.length !== target.length : false,
    targetNodeCount: target.length,
    materializedNodeCount: active ? nodes.length : target.length,
    batchRuns: batchStats.batchRuns,
    reconcileVersion: batchStats.reconcileVersion,
  }

  return { nodes, stats }
}
