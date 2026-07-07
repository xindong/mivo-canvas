import type { MivoCanvasNode } from '../types/mivoCanvas'

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

export type SnapGuide = {
  id: string
  orientation: 'vertical' | 'horizontal'
  position: number
  start: number
  end: number
}

export type CanvasRect = {
  x: number
  y: number
  width: number
  height: number
}

type SnapMatch = {
  delta: number
  target: number
  offset: number
  ratio: number
  peer: MivoCanvasNode
}

const snapThreshold = 8

function getSnapMatches(
  nodeId: string,
  rect: CanvasRect,
  nodes: MivoCanvasNode[],
  options?: { verticalRatios?: number[]; horizontalRatios?: number[] },
) {
  const peers = nodes.filter((item) => item.id !== nodeId)
  let bestVertical: SnapMatch | undefined
  let bestHorizontal: SnapMatch | undefined

  const movingVerticalAnchors = [
    { value: rect.x, offset: 0, ratio: 0 },
    { value: rect.x + rect.width / 2, offset: rect.width / 2, ratio: 0.5 },
    { value: rect.x + rect.width, offset: rect.width, ratio: 1 },
  ].filter((anchor) => !options?.verticalRatios || options.verticalRatios.includes(anchor.ratio))
  const movingHorizontalAnchors = [
    { value: rect.y, offset: 0, ratio: 0 },
    { value: rect.y + rect.height / 2, offset: rect.height / 2, ratio: 0.5 },
    { value: rect.y + rect.height, offset: rect.height, ratio: 1 },
  ].filter((anchor) => !options?.horizontalRatios || options.horizontalRatios.includes(anchor.ratio))

  peers.forEach((peer) => {
    const peerVerticalTargets = [peer.x, peer.x + peer.width / 2, peer.x + peer.width]
    const peerHorizontalTargets = [peer.y, peer.y + peer.height / 2, peer.y + peer.height]

    movingVerticalAnchors.forEach((anchor) => {
      peerVerticalTargets.forEach((target) => {
        const delta = Math.abs(anchor.value - target)
        if (delta <= snapThreshold && (!bestVertical || delta < bestVertical.delta)) {
          bestVertical = { delta, target, offset: anchor.offset, ratio: anchor.ratio, peer }
        }
      })
    })

    movingHorizontalAnchors.forEach((anchor) => {
      peerHorizontalTargets.forEach((target) => {
        const delta = Math.abs(anchor.value - target)
        if (delta <= snapThreshold && (!bestHorizontal || delta < bestHorizontal.delta)) {
          bestHorizontal = { delta, target, offset: anchor.offset, ratio: anchor.ratio, peer }
        }
      })
    })
  })

  return { bestVertical, bestHorizontal }
}

function getSnapGuides(rect: CanvasRect, matches: { bestVertical?: SnapMatch; bestHorizontal?: SnapMatch }) {
  const guides: SnapGuide[] = []

  if (matches.bestVertical) {
    const guideTop = Math.min(rect.y, matches.bestVertical.peer.y) - 32
    const guideBottom = Math.max(rect.y + rect.height, matches.bestVertical.peer.y + matches.bestVertical.peer.height) + 32
    guides.push({
      id: `v-${matches.bestVertical.peer.id}`,
      orientation: 'vertical',
      position: matches.bestVertical.target,
      start: guideTop,
      end: guideBottom,
    })
  }

  if (matches.bestHorizontal) {
    const guideLeft = Math.min(rect.x, matches.bestHorizontal.peer.x) - 32
    const guideRight = Math.max(rect.x + rect.width, matches.bestHorizontal.peer.x + matches.bestHorizontal.peer.width) + 32
    guides.push({
      id: `h-${matches.bestHorizontal.peer.id}`,
      orientation: 'horizontal',
      position: matches.bestHorizontal.target,
      start: guideLeft,
      end: guideRight,
    })
  }

  return guides
}

export function getSnappedPosition(node: MivoCanvasNode, nodes: MivoCanvasNode[], x: number, y: number) {
  const matches = getSnapMatches(node.id, { x, y, width: node.width, height: node.height }, nodes)
  const snappedX = matches.bestVertical ? matches.bestVertical.target - matches.bestVertical.offset : x
  const snappedY = matches.bestHorizontal ? matches.bestHorizontal.target - matches.bestHorizontal.offset : y
  const rect = { x: snappedX, y: snappedY, width: node.width, height: node.height }

  return { x: snappedX, y: snappedY, guides: getSnapGuides(rect, matches) }
}

export function getSnappedResize(
  node: MivoCanvasNode,
  nodes: MivoCanvasNode[],
  rect: CanvasRect,
  corner: ResizeCorner,
  aspectRatio: number,
  fixedX: number,
  fixedY: number,
  options?: {
    minWidth?: number
    maxWidth?: number
  },
) {
  const east = corner.endsWith('e')
  const south = corner.startsWith('s')
  const minWidth = options?.minWidth ?? 96
  const maxWidth = options?.maxWidth ?? 6000
  const matches = getSnapMatches(node.id, rect, nodes, {
    verticalRatios: east ? [0.5, 1] : [0, 0.5],
    horizontalRatios: south ? [0.5, 1] : [0, 0.5],
  })
  const candidates: Array<{ rect: CanvasRect; match: { bestVertical?: SnapMatch; bestHorizontal?: SnapMatch } }> = []

  if (matches.bestVertical) {
    const targetWidth = east
      ? matches.bestVertical.ratio === 0
        ? 0
        : (matches.bestVertical.target - fixedX) / matches.bestVertical.ratio
      : matches.bestVertical.ratio === 1
        ? 0
        : (fixedX - matches.bestVertical.target) / (1 - matches.bestVertical.ratio)
    if (targetWidth >= minWidth && targetWidth <= maxWidth) {
      const targetHeight = targetWidth / aspectRatio
      candidates.push({
        rect: {
          x: east ? fixedX : fixedX - targetWidth,
          y: south ? fixedY : fixedY - targetHeight,
          width: targetWidth,
          height: targetHeight,
        },
        match: { bestVertical: matches.bestVertical },
      })
    }
  }

  if (matches.bestHorizontal) {
    const targetHeight = south
      ? matches.bestHorizontal.ratio === 0
        ? 0
        : (matches.bestHorizontal.target - fixedY) / matches.bestHorizontal.ratio
      : matches.bestHorizontal.ratio === 1
        ? 0
        : (fixedY - matches.bestHorizontal.target) / (1 - matches.bestHorizontal.ratio)
    const targetWidth = targetHeight * aspectRatio
    if (targetWidth >= minWidth && targetWidth <= maxWidth) {
      candidates.push({
        rect: {
          x: east ? fixedX : fixedX - targetWidth,
          y: south ? fixedY : fixedY - targetHeight,
          width: targetWidth,
          height: targetHeight,
        },
        match: { bestHorizontal: matches.bestHorizontal },
      })
    }
  }

  const bestCandidate = candidates.sort((a, b) => {
    const aDelta = a.match.bestVertical?.delta ?? a.match.bestHorizontal?.delta ?? Infinity
    const bDelta = b.match.bestVertical?.delta ?? b.match.bestHorizontal?.delta ?? Infinity
    return aDelta - bDelta
  })[0]

  if (!bestCandidate) return { ...rect, guides: [] }

  const finalMatches = getSnapMatches(node.id, bestCandidate.rect, nodes)
  const guides = getSnapGuides(bestCandidate.rect, {
    bestVertical: bestCandidate.match.bestVertical || finalMatches.bestVertical,
    bestHorizontal: bestCandidate.match.bestHorizontal || finalMatches.bestHorizontal,
  })

  return { ...bestCandidate.rect, guides }
}

export function getSnappedFreeResize(
  node: MivoCanvasNode,
  nodes: MivoCanvasNode[],
  rect: CanvasRect,
  corner: ResizeCorner,
  fixedX: number,
  fixedY: number,
  options?: {
    minWidth?: number
    minHeight?: number
    maxWidth?: number
    maxHeight?: number
  },
) {
  const east = corner.endsWith('e')
  const south = corner.startsWith('s')
  const minWidth = options?.minWidth ?? 96
  const minHeight = options?.minHeight ?? 96
  const maxWidth = options?.maxWidth ?? 10000
  const maxHeight = options?.maxHeight ?? 10000
  const clampWidth = (width: number) => Math.min(maxWidth, Math.max(minWidth, width))
  const clampHeight = (height: number) => Math.min(maxHeight, Math.max(minHeight, height))
  const nextRect = { ...rect }
  const guideMatches: { bestVertical?: SnapMatch; bestHorizontal?: SnapMatch } = {}

  const allMatches = getSnapMatches(node.id, rect, nodes, {
    verticalRatios: east ? [1] : [0],
    horizontalRatios: south ? [1] : [0],
  })

  if (allMatches.bestVertical) {
    const targetWidth = east ? allMatches.bestVertical.target - fixedX : fixedX - allMatches.bestVertical.target
    const width = clampWidth(targetWidth)

    if (width === targetWidth) {
      nextRect.width = width
      nextRect.x = east ? fixedX : fixedX - width
      guideMatches.bestVertical = allMatches.bestVertical
    }
  }

  if (allMatches.bestHorizontal) {
    const targetHeight = south ? allMatches.bestHorizontal.target - fixedY : fixedY - allMatches.bestHorizontal.target
    const height = clampHeight(targetHeight)

    if (height === targetHeight) {
      nextRect.height = height
      nextRect.y = south ? fixedY : fixedY - height
      guideMatches.bestHorizontal = allMatches.bestHorizontal
    }
  }

  return {
    ...nextRect,
    guides: getSnapGuides(nextRect, guideMatches),
  }
}
