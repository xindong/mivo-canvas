import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_FIXTURE_SEED = 20260704
export const SUPPORTED_NODE_COUNTS = [100, 500, 1000, 5000, 10000, 20000, 50000]
export const SUPPORTED_DPRS = [1, 2]

const __dirname = dirname(fileURLToPath(import.meta.url))
export const projectRoot = resolve(__dirname, '..', '..')
export const fixtureDir = resolve(projectRoot, 'bench', 'fixtures')

const demoAssets = [
  '/demo-assets/courage-1.jpg',
  '/demo-assets/courage-2.jpg',
  '/demo-assets/courage-3.jpg',
]

const sectionPalettes = [
  { fill: '#f6efe3', border: '#be8754', text: '#4f3721', stroke: '#9c5d31' },
  { fill: '#e8f1ef', border: '#5e9187', text: '#24423e', stroke: '#38665e' },
  { fill: '#eef0f8', border: '#6478aa', text: '#2b3554', stroke: '#465989' },
  { fill: '#f8ece9', border: '#ba6f65', text: '#5d2f2f', stroke: '#8d4f47' },
]

const minViewportScale = 0.08
const maxViewportScale = 4

const round = (value, digits = 3) => Number(value.toFixed(digits))

const clampViewportScale = (scale) =>
  Math.min(maxViewportScale, Math.max(minViewportScale, Number(scale.toFixed(3))))

const createRng = (seed) => {
  let state = Math.floor(seed) % 2147483647
  if (state <= 0) state += 2147483646

  return () => {
    state = (state * 16807) % 2147483647
    return (state - 1) / 2147483646
  }
}

const countBreakdownFor = (nodeCount) => {
  const frameCount = Math.max(4, Math.floor(nodeCount * 0.08))
  const connectorCount = Math.max(6, Math.floor(nodeCount * 0.12))
  const textCount = Math.max(12, Math.floor(nodeCount * 0.22))
  const imageCount = nodeCount - frameCount - connectorCount - textCount

  if (imageCount <= 0) {
    throw new Error(`Invalid fixture breakdown for nodeCount=${nodeCount}`)
  }

  return { imageCount, textCount, frameCount, connectorCount }
}

const sceneIdFor = (nodeCount) => `bench-dom-mixed-${nodeCount}`
const fixtureFileNameFor = (nodeCount) => `${sceneIdFor(nodeCount)}.json`

export const fixturePathFor = (nodeCount) => resolve(fixtureDir, fixtureFileNameFor(nodeCount))

const assetPromptFor = (index) => {
  const promptFamilies = [
    '角色概念图对比稿，保留冷暖对撞和高饱和点缀',
    '环境气氛草图，强调前景留白和纵深透视',
    '商品图变体探索，保持主体比例并改变光效方向',
    '分镜式参考图，突出动作节奏和焦点引导',
  ]
  return promptFamilies[index % promptFamilies.length]
}

const textBodyFor = (index) => {
  const snippets = [
    'Key beats: silhouette, trim light, negative space.',
    'Color callout: push cyan shadows, keep warm accents tight.',
    'Layout note: preserve read path from upper-left to focal node.',
    'Anchor copy: keep copy short and production-facing.',
    'QA note: compare crop headroom before sign-off.',
  ]
  return snippets[index % snippets.length]
}

const anchorForDirection = (sourceCenter, targetCenter, axis) => {
  if (axis === 'horizontal') {
    return sourceCenter.x <= targetCenter.x ? 'right' : 'left'
  }
  return sourceCenter.y <= targetCenter.y ? 'bottom' : 'top'
}

export const boundsForNodes = (nodes) => {
  if (!nodes.length) return undefined

  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))

  return {
    x: round(minX),
    y: round(minY),
    width: round(maxX - minX),
    height: round(maxY - minY),
  }
}

export const viewportForBounds = (bounds, rect = { width: 1920, height: 1080 }, options = {}) => {
  if (!bounds) return { x: 420, y: 240, scale: 1 }

  const minViewportSide = Math.max(1, Math.min(rect.width, rect.height))
  const padding = Math.min(options.padding ?? 180, Math.max(options.minPadding ?? 80, minViewportSide * 0.2))
  const availableWidth = Math.max(120, rect.width - padding)
  const availableHeight = Math.max(120, rect.height - padding)
  const scale = clampViewportScale(
    Math.min(availableWidth / Math.max(bounds.width, 1), availableHeight / Math.max(bounds.height, 1)),
  )

  return {
    x: round(rect.width / 2 - (bounds.x + bounds.width / 2) * scale),
    y: round(rect.height / 2 - (bounds.y + bounds.height / 2) * scale),
    scale,
  }
}

const frameLayoutFor = (frameCount) => {
  const columns = Math.max(4, Math.ceil(Math.sqrt(frameCount * 1.8)))
  const rows = Math.ceil(frameCount / columns)
  const gapX = 120
  const gapY = 120
  const baseWidth = 760
  const baseHeight = 520
  const totalWidth = columns * baseWidth + (columns - 1) * gapX
  const totalHeight = rows * baseHeight + (rows - 1) * gapY

  return {
    columns,
    rows,
    gapX,
    gapY,
    baseWidth,
    baseHeight,
    originX: -Math.round(totalWidth / 2),
    originY: -Math.round(totalHeight / 2),
  }
}

export function buildFixture(nodeCount, seed = DEFAULT_FIXTURE_SEED) {
  if (!SUPPORTED_NODE_COUNTS.includes(nodeCount)) {
    throw new Error(`Unsupported node count: ${nodeCount}`)
  }

  const rng = createRng(seed + nodeCount * 17)
  const { imageCount, textCount, frameCount, connectorCount } = countBreakdownFor(nodeCount)
  const layout = frameLayoutFor(frameCount)
  const frames = []
  const nodes = []
  const imageRefsByFrame = Array.from({ length: frameCount }, () => [])
  const textRefsByFrame = Array.from({ length: frameCount }, () => [])

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const column = frameIndex % layout.columns
    const row = Math.floor(frameIndex / layout.columns)
    const palette = sectionPalettes[frameIndex % sectionPalettes.length]
    const width = 680 + Math.floor(rng() * 100)
    const height = 440 + Math.floor(rng() * 90)
    const x = layout.originX + column * (layout.baseWidth + layout.gapX) + Math.floor(rng() * 28) - 14
    const y = layout.originY + row * (layout.baseHeight + layout.gapY) + Math.floor(rng() * 28) - 14
    const frameId = `bench-frame-${String(frameIndex + 1).padStart(3, '0')}`

    const frameNode = {
      id: frameId,
      type: 'frame',
      status: 'ready',
      title: `Bench Section ${String(frameIndex + 1).padStart(2, '0')}`,
      x,
      y,
      width,
      height,
      sectionFillColor: palette.fill,
      sectionBorderColor: palette.border,
      sectionBorderWidth: 2,
      sectionBorderStyle: frameIndex % 3 === 0 ? 'dashed' : 'solid',
      frameColor: palette.border,
      sectionTitleVisible: true,
    }

    frames.push({
      id: frameId,
      x,
      y,
      width,
      height,
      palette,
    })
    nodes.push(frameNode)
  }

  for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
    const frameIndex = imageIndex % frameCount
    const frame = frames[frameIndex]
    const localIndex = imageRefsByFrame[frameIndex].length
    const columns = 3
    const cellWidth = (frame.width - 64) / columns
    const col = localIndex % columns
    const row = Math.floor(localIndex / columns)
    const width = 158 + Math.floor(rng() * 18)
    const height = 214 + Math.floor(rng() * 28)
    const x = round(frame.x + 28 + col * cellWidth + Math.floor(rng() * 16))
    const y = round(frame.y + 56 + row * 230 + Math.floor(rng() * 20))
    const nodeId = `bench-image-${String(imageIndex + 1).padStart(4, '0')}`
    const node = {
      id: nodeId,
      type: 'image',
      status: 'ready',
      title: `Bench Image ${String(imageIndex + 1).padStart(4, '0')}`,
      x,
      y,
      width,
      height,
      assetUrl: demoAssets[imageIndex % demoAssets.length],
      sectionId: frame.id,
      generation: {
        prompt: assetPromptFor(imageIndex),
        model: imageIndex % 2 === 0 ? 'gpt-image-2' : 'gemini-3-pro-image',
        size: `${width * 4}x${height * 4}`,
        seed: seed + imageIndex,
        strength: round(0.42 + (imageIndex % 5) * 0.08, 2),
      },
    }
    nodes.push(node)
    imageRefsByFrame[frameIndex].push({
      id: nodeId,
      x,
      y,
      width,
      height,
    })
  }

  for (let textIndex = 0; textIndex < textCount; textIndex += 1) {
    const frameIndex = textIndex % frameCount
    const frame = frames[frameIndex]
    const localIndex = textRefsByFrame[frameIndex].length
    const width = 230 + Math.floor(rng() * 40)
    const height = 82 + Math.floor(rng() * 26)
    const columns = 2
    const row = Math.floor(localIndex / columns)
    const col = localIndex % columns
    const x = round(frame.x + 34 + col * ((frame.width - 96) / columns) + Math.floor(rng() * 14))
    const y = round(frame.y + frame.height - 156 - row * 98 + Math.floor(rng() * 12))
    const nodeId = `bench-text-${String(textIndex + 1).padStart(4, '0')}`
    const node = {
      id: nodeId,
      type: 'text',
      status: 'ready',
      title: `Bench Text ${String(textIndex + 1).padStart(4, '0')}`,
      x,
      y,
      width,
      height,
      text: textBodyFor(textIndex),
      textColor: frame.palette.text,
      textAlign: textIndex % 3 === 0 ? 'center' : 'left',
      fontSize: 18 + (textIndex % 3) * 2,
      fontWeight: textIndex % 4 === 0 ? 600 : 500,
      sectionId: frame.id,
    }
    nodes.push(node)
    textRefsByFrame[frameIndex].push({
      id: nodeId,
      x,
      y,
      width,
      height,
    })
  }

  for (let connectorIndex = 0; connectorIndex < connectorCount; connectorIndex += 1) {
    const frameIndex = connectorIndex % frameCount
    const frame = frames[frameIndex]
    const imageRefs = imageRefsByFrame[frameIndex]
    const textRefs = textRefsByFrame[frameIndex]
    const connectables = [...imageRefs, ...textRefs]
    if (connectables.length < 2) continue

    const source = connectables[connectorIndex % connectables.length]
    const target =
      connectables[(connectorIndex * 3 + 2) % connectables.length].id === source.id
        ? connectables[(connectorIndex * 3 + 3) % connectables.length]
        : connectables[(connectorIndex * 3 + 2) % connectables.length]

    const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
    const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    const horizontal = Math.abs(targetCenter.x - sourceCenter.x) >= Math.abs(targetCenter.y - sourceCenter.y)
    const sourceAnchor = anchorForDirection(sourceCenter, targetCenter, horizontal ? 'horizontal' : 'vertical')
    const targetAnchor = anchorForDirection(targetCenter, sourceCenter, horizontal ? 'horizontal' : 'vertical')

    const start =
      sourceAnchor === 'right'
        ? { x: source.x + source.width, y: sourceCenter.y }
        : sourceAnchor === 'left'
          ? { x: source.x, y: sourceCenter.y }
          : sourceAnchor === 'top'
            ? { x: sourceCenter.x, y: source.y }
            : { x: sourceCenter.x, y: source.y + source.height }
    const end =
      targetAnchor === 'right'
        ? { x: target.x + target.width, y: targetCenter.y }
        : targetAnchor === 'left'
          ? { x: target.x, y: targetCenter.y }
          : targetAnchor === 'top'
            ? { x: targetCenter.x, y: target.y }
            : { x: targetCenter.x, y: target.y + target.height }

    const padding = 28
    const x = round(Math.min(start.x, end.x) - padding)
    const y = round(Math.min(start.y, end.y) - padding)
    const width = round(Math.max(56, Math.abs(end.x - start.x) + padding * 2))
    const height = round(Math.max(56, Math.abs(end.y - start.y) + padding * 2))
    const nodeId = `bench-connector-${String(connectorIndex + 1).padStart(4, '0')}`

    nodes.push({
      id: nodeId,
      type: 'markup',
      status: 'ready',
      title: `Bench Connector ${String(connectorIndex + 1).padStart(4, '0')}`,
      x,
      y,
      width,
      height,
      sectionId: frame.id,
      markupKind: 'arrow',
      markupStrokeColor: frame.palette.stroke,
      markupStrokeWidth: 4,
      markupStrokeStyle: connectorIndex % 5 === 0 ? 'dashed' : 'solid',
      markupOpacity: 0.92,
      markupEndArrow: true,
      text: connectorIndex % 4 === 0 ? 'flow' : undefined,
      connectorStart: {
        nodeId: source.id,
        anchor: sourceAnchor,
        offset: 0.5,
      },
      connectorEnd: {
        nodeId: target.id,
        anchor: targetAnchor,
        offset: 0.5,
      },
      markupPoints: [
        { x: round(start.x - x), y: round(start.y - y) },
        { x: round(end.x - x), y: round(end.y - y) },
      ],
    })
  }

  if (nodes.length !== nodeCount) {
    throw new Error(`Fixture node count mismatch: expected ${nodeCount}, got ${nodes.length}`)
  }

  const snapshot = {
    version: 2,
    sceneId: sceneIdFor(nodeCount),
    nodes,
    edges: [],
    tasks: [
      {
        id: `bench-task-${nodeCount}`,
        label: `${nodeCount} mixed-node benchmark fixture ready`,
        status: 'done',
        progress: 100,
        nodeIds: nodes.slice(0, Math.min(12, nodes.length)).map((node) => node.id),
      },
    ],
    selectedNodeId: nodes.find((node) => node.type === 'image')?.id,
    selectedNodeIds: [nodes.find((node) => node.type === 'image')?.id].filter(Boolean),
  }

  const bounds = boundsForNodes(nodes)
  const recommendedViewport = viewportForBounds(bounds)

  return {
    meta: {
      sceneId: snapshot.sceneId,
      label: `${nodeCount} mixed benchmark fixture`,
      nodeCount,
      seed,
      counts: {
        image: imageCount,
        text: textCount,
        frame: frameCount,
        connector: connectorCount,
      },
      bounds,
      recommendedViewport,
    },
    snapshot,
  }
}

export async function writeFixtureFiles({ nodeCounts = SUPPORTED_NODE_COUNTS, seed = DEFAULT_FIXTURE_SEED } = {}) {
  await mkdir(fixtureDir, { recursive: true })
  const outputs = []

  for (const nodeCount of nodeCounts) {
    const fixture = buildFixture(nodeCount, seed)
    const path = fixturePathFor(nodeCount)
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`)
    outputs.push({
      nodeCount,
      path,
      sceneId: fixture.meta.sceneId,
      bounds: fixture.meta.bounds,
    })
  }

  return outputs
}

export { fixtureFileNameFor, sceneIdFor }
