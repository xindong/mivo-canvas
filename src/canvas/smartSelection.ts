import type { MivoCanvasNode } from '../types/mivoCanvas'
import { isConnectorNode } from './connectorGeometry'

export type SmartSelectionAxis = 'horizontal' | 'vertical'
export type SmartSelectionLayoutKind = 'row' | 'column' | 'grid'

export type SmartSelectionBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type SmartSelectionHandle = {
  id: string
  axis: SmartSelectionAxis
  index: number
  gap: number
  x: number
  y: number
  width: number
  height: number
  label: string
  layoutKind: SmartSelectionLayoutKind
}

export type SmartSelectionSpacingDragState = {
  pointerId: number
  axis: SmartSelectionAxis
  index: number
  layoutKind: SmartSelectionLayoutKind
  startClientX: number
  startClientY: number
  startGap: number
  startLayout: SmartSelectionLayout
}

type SmartSelectionRow = {
  nodes: MivoCanvasNode[]
  y: number
  height: number
}

type SmartSelectionColumn = {
  nodes: MivoCanvasNode[]
  x: number
  width: number
}

export type SmartSelectionLayout = {
  kind: SmartSelectionLayoutKind
  subjects: MivoCanvasNode[]
  bounds: SmartSelectionBounds
  rows: SmartSelectionRow[]
  columns: SmartSelectionColumn[]
}

type SmartSelectionOptions = {
  isEffectivelyLocked: (node: MivoCanvasNode) => boolean
  viewportScale: number
}

const minimumGap = 0
const groupingTolerance = 28

export const smartSelectionBoundsFor = (nodes: MivoCanvasNode[]): SmartSelectionBounds | undefined => {
  if (!nodes.length) return undefined

  const minX = Math.min(...nodes.map((node) => node.x))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export const smartSelectionSubjectNodesFrom = (
  selectedNodes: MivoCanvasNode[],
  options: Pick<SmartSelectionOptions, 'isEffectivelyLocked'>,
) =>
  selectedNodes.filter(
    (node) => node.type !== 'frame' && !isConnectorNode(node) && !options.isEffectivelyLocked(node),
  )

const nodeCenterX = (node: MivoCanvasNode) => node.x + node.width / 2
const nodeCenterY = (node: MivoCanvasNode) => node.y + node.height / 2

const groupRows = (nodes: MivoCanvasNode[]) => {
  const rows: SmartSelectionRow[] = []

  ;[...nodes]
    .sort((a, b) => nodeCenterY(a) - nodeCenterY(b) || a.x - b.x)
    .forEach((node) => {
      const centerY = nodeCenterY(node)
      const row = rows.find((item) => Math.abs(centerY - item.y) <= groupingTolerance)
      if (row) {
        row.nodes.push(node)
        const bounds = smartSelectionBoundsFor(row.nodes)
        row.y = row.nodes.reduce((sum, item) => sum + nodeCenterY(item), 0) / row.nodes.length
        row.height = bounds?.height || row.height
        return
      }

      rows.push({ nodes: [node], y: centerY, height: node.height })
    })

  rows.forEach((row) => row.nodes.sort((a, b) => a.x - b.x || a.y - b.y))
  return rows.sort((a, b) => a.y - b.y)
}

const groupColumns = (nodes: MivoCanvasNode[]) => {
  const columns: SmartSelectionColumn[] = []

  ;[...nodes]
    .sort((a, b) => nodeCenterX(a) - nodeCenterX(b) || a.y - b.y)
    .forEach((node) => {
      const centerX = nodeCenterX(node)
      const column = columns.find((item) => Math.abs(centerX - item.x) <= groupingTolerance)
      if (column) {
        column.nodes.push(node)
        const bounds = smartSelectionBoundsFor(column.nodes)
        column.x = column.nodes.reduce((sum, item) => sum + nodeCenterX(item), 0) / column.nodes.length
        column.width = bounds?.width || column.width
        return
      }

      columns.push({ nodes: [node], x: centerX, width: node.width })
    })

  columns.forEach((column) => column.nodes.sort((a, b) => a.y - b.y || a.x - b.x))
  return columns.sort((a, b) => a.x - b.x)
}

export const smartSelectionLayoutFor = (
  selectedNodes: MivoCanvasNode[],
  options: Pick<SmartSelectionOptions, 'isEffectivelyLocked'>,
): SmartSelectionLayout | undefined => {
  const subjects = smartSelectionSubjectNodesFrom(selectedNodes, options)
  const bounds = smartSelectionBoundsFor(subjects)
  if (!bounds || subjects.length < 2) return undefined

  const rows = groupRows(subjects)
  const columns = groupColumns(subjects)
  const hasGridShape = subjects.length >= 4 && rows.length > 1 && columns.length > 1
  const kind: SmartSelectionLayoutKind = hasGridShape ? 'grid' : bounds.width >= bounds.height ? 'row' : 'column'

  return {
    kind,
    subjects,
    bounds,
    rows,
    columns,
  }
}

const sortedSubjectsForAxis = (layout: SmartSelectionLayout, axis: SmartSelectionAxis) =>
  [...layout.subjects].sort((a, b) => (axis === 'horizontal' ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x))

export const smartSelectionGapFor = (
  layout: SmartSelectionLayout,
  axis: SmartSelectionAxis,
  index: number,
) => {
  if (layout.kind === 'grid') {
    if (axis === 'horizontal') {
      const current = layout.columns[index]
      const next = layout.columns[index + 1]
      if (!current || !next) return 0
      return next.x - next.width / 2 - (current.x + current.width / 2)
    }

    const current = layout.rows[index]
    const next = layout.rows[index + 1]
    if (!current || !next) return 0
    return next.y - next.height / 2 - (current.y + current.height / 2)
  }

  const sorted = sortedSubjectsForAxis(layout, axis)
  const current = sorted[index]
  const next = sorted[index + 1]
  if (!current || !next) return 0

  return axis === 'horizontal' ? next.x - (current.x + current.width) : next.y - (current.y + current.height)
}

const spacingHandleSizeFor = (viewportScale: number) => ({
  track: 6 / viewportScale,
  minHit: 24 / viewportScale,
  maxHit: 72 / viewportScale,
})

export const smartSelectionHandlesFor = (
  selectedNodes: MivoCanvasNode[],
  options: SmartSelectionOptions,
): SmartSelectionHandle[] => {
  const layout = smartSelectionLayoutFor(selectedNodes, options)
  if (!layout) return []

  const { track, minHit, maxHit } = spacingHandleSizeFor(options.viewportScale)
  const handles: SmartSelectionHandle[] = []
  const addAxisHandles = (axis: SmartSelectionAxis) => {
    const groups =
      layout.kind === 'grid'
        ? axis === 'horizontal'
          ? layout.columns
          : layout.rows
        : sortedSubjectsForAxis(layout, axis)

    groups.slice(0, -1).forEach((item, index) => {
      const next = groups[index + 1]
      if (!next) return

      const gap = smartSelectionGapFor(layout, axis, index)
      if (gap < 0) return

      if (axis === 'horizontal') {
        const itemRight =
          layout.kind === 'grid'
            ? (item as SmartSelectionColumn).x + (item as SmartSelectionColumn).width / 2
            : (item as MivoCanvasNode).x + (item as MivoCanvasNode).width
        const nextLeft =
          layout.kind === 'grid'
            ? (next as SmartSelectionColumn).x - (next as SmartSelectionColumn).width / 2
            : (next as MivoCanvasNode).x
        const width = Math.max(minHit, Math.min(maxHit, Math.max(gap, minHit)))
        handles.push({
          id: `smart-spacing-${layout.kind}-${axis}-${index}`,
          axis,
          index,
          gap: Math.round(gap),
          x: (itemRight + nextLeft) / 2 - width / 2,
          y: layout.bounds.y + layout.bounds.height / 2 - track / 2,
          width,
          height: track,
          label: `${Math.max(0, Math.round(gap))}`,
          layoutKind: layout.kind,
        })
        return
      }

      const itemBottom =
        layout.kind === 'grid'
          ? (item as SmartSelectionRow).y + (item as SmartSelectionRow).height / 2
          : (item as MivoCanvasNode).y + (item as MivoCanvasNode).height
      const nextTop =
        layout.kind === 'grid'
          ? (next as SmartSelectionRow).y - (next as SmartSelectionRow).height / 2
          : (next as MivoCanvasNode).y
      const height = Math.max(minHit, Math.min(maxHit, Math.max(gap, minHit)))
      handles.push({
        id: `smart-spacing-${layout.kind}-${axis}-${index}`,
        axis,
        index,
        gap: Math.round(gap),
        x: layout.bounds.x + layout.bounds.width / 2 - track / 2,
        y: (itemBottom + nextTop) / 2 - height / 2,
        width: track,
        height,
        label: `${Math.max(0, Math.round(gap))}`,
        layoutKind: layout.kind,
      })
    })
  }

  if (layout.kind === 'row') addAxisHandles('horizontal')
  else if (layout.kind === 'column') addAxisHandles('vertical')
  else {
    addAxisHandles('horizontal')
    addAxisHandles('vertical')
  }

  return handles
}

const uniformLineUpdates = (
  layout: SmartSelectionLayout,
  axis: SmartSelectionAxis,
  targetGap: number,
) => {
  const sorted = sortedSubjectsForAxis(layout, axis)
  const updates: Array<{ id: string; x: number; y: number; width: number; height: number }> = []
  const first = sorted[0]
  if (!first) return updates

  let cursor = axis === 'horizontal' ? first.x : first.y
  const center = axis === 'horizontal' ? nodeCenterY(first) : nodeCenterX(first)

  sorted.forEach((node) => {
    if (axis === 'horizontal') {
      updates.push({
        id: node.id,
        x: cursor,
        y: center - node.height / 2,
        width: node.width,
        height: node.height,
      })
      cursor += node.width + targetGap
      return
    }

    updates.push({
      id: node.id,
      x: center - node.width / 2,
      y: cursor,
      width: node.width,
      height: node.height,
    })
    cursor += node.height + targetGap
  })

  return updates
}

const columnBounds = (column: SmartSelectionColumn) => {
  const bounds = smartSelectionBoundsFor(column.nodes)
  return { minX: bounds?.x || 0, width: bounds?.width || column.width }
}

const rowBounds = (row: SmartSelectionRow) => {
  const bounds = smartSelectionBoundsFor(row.nodes)
  return { minY: bounds?.y || 0, height: bounds?.height || row.height }
}

const uniformGridUpdates = (
  layout: SmartSelectionLayout,
  axis: SmartSelectionAxis,
  targetGap: number,
) => {
  const xOffsets = new Map<string, number>()
  const yOffsets = new Map<string, number>()

  if (axis === 'horizontal') {
    const firstColumnBounds = columnBounds(layout.columns[0])
    let nextX = firstColumnBounds.minX
    layout.columns.forEach((column) => {
      const bounds = columnBounds(column)
      const dx = nextX - bounds.minX
      column.nodes.forEach((node) => xOffsets.set(node.id, dx))
      nextX += bounds.width + targetGap
    })
  }

  if (axis === 'vertical') {
    const firstRowBounds = rowBounds(layout.rows[0])
    let nextY = firstRowBounds.minY
    layout.rows.forEach((row) => {
      const bounds = rowBounds(row)
      const dy = nextY - bounds.minY
      row.nodes.forEach((node) => yOffsets.set(node.id, dy))
      nextY += bounds.height + targetGap
    })
  }

  return layout.subjects.map((node) => ({
    id: node.id,
    x: node.x + (xOffsets.get(node.id) || 0),
    y: node.y + (yOffsets.get(node.id) || 0),
    width: node.width,
    height: node.height,
  }))
}

export const smartSelectionSpacingUpdates = (
  drag: SmartSelectionSpacingDragState,
  clientX: number,
  clientY: number,
  viewportScale: number,
) => {
  const delta =
    drag.axis === 'horizontal'
      ? (clientX - drag.startClientX) / viewportScale
      : (clientY - drag.startClientY) / viewportScale
  const targetGap = Math.max(minimumGap, drag.startGap + delta)

  return {
    gap: Math.round(targetGap),
    updates:
      drag.startLayout.kind === 'grid'
        ? uniformGridUpdates(drag.startLayout, drag.axis, targetGap)
        : uniformLineUpdates(drag.startLayout, drag.axis, targetGap),
  }
}
