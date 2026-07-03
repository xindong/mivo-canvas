import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import type { ExperimentalAnchor, MivoCanvasNode } from '../types/mivoCanvas'

// AnchorOverlay — P2-D2 minimal DOM closed-loop (roadmap §7 组 D).
//
// Renders the experimentalAnchors committed on image nodes as small marks (dot for
// point, dashed rect for box) in screen space, a debug toolbar to create anchors on
// the selected image (point + box), and a floating instruction input + Generate
// button for the selected anchor. Generate delegates to the existing
// generateBesideNode (point semantics) / generateImageEdit (box semantics) actions
// and records the result node ids back onto the anchor + lets the generation action
// build the derivation edge.
//
// This is a PARADIGM-VALIDATION overlay, not production UI:
//  - Anchor creation is via debug buttons (not a canvas tool with click/drag). Real
//    tool integration is deferred; point + box both use the debug entry per the
//    task's "box 用调试入口" allowance (extended to point for consistency + risk).
//  - The instruction carrier is a floating panel (informs the 浮层 vs 侧栏 question).
//  - Box geometry is carried in the prompt text (no real mask wiring); informs the
//    "与 mask 的关系" question (see docs/decisions anchor MVP notes).

type Viewport = { x: number; y: number; scale: number }

type Props = { viewport: Viewport }

const toOverlayX = (viewport: Viewport, x: number) => viewport.x + x * viewport.scale
const toOverlayY = (viewport: Viewport, y: number) => viewport.y + y * viewport.scale

// Stable empty array so the `nodes` selector returns the same reference when no
// anchors exist → the overlay does NOT re-render on every node/store change in
// unrelated views (e.g. the assets drawer). Only when an anchor exists does it
// subscribe to the live nodes array.
const EMPTY_NODES: MivoCanvasNode[] = []

const isImageNode = (node: MivoCanvasNode | undefined): node is MivoCanvasNode =>
  Boolean(node && node.type === 'image' && !node.hidden)

export const AnchorOverlay = ({ viewport }: Props) => {
  const nodes = useCanvasStore((s) =>
    s.nodes.some((n) => n.experimentalAnchors?.length) ? s.nodes : EMPTY_NODES,
  )
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId)
  const addAnchor = useCanvasStore((s) => s.addAnchor)
  const updateAnchorInstruction = useCanvasStore((s) => s.updateAnchorInstruction)
  const recordAnchorResult = useCanvasStore((s) => s.recordAnchorResult)
  const generateBesideNode = useCanvasStore((s) => s.generateBesideNode)
  const generateImageEdit = useCanvasStore((s) => s.generateImageEdit)

  const [selectedAnchorId, setSelectedAnchorId] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedNode = nodes.find((n) => n.id === selectedNodeId)

  // Collect (node, anchor) pairs so the overlay can render every anchor + resolve
  // the owning node for generate.
  const allAnchors: Array<{ node: MivoCanvasNode; anchor: ExperimentalAnchor }> = []
  for (const node of nodes) {
    if (!node.experimentalAnchors) continue
    for (const anchor of node.experimentalAnchors) allAnchors.push({ node, anchor })
  }

  const selected = allAnchors.find((p) => p.anchor.id === selectedAnchorId)

  const selectAnchor = (anchorId: string, currentInstruction: string) => {
    setSelectedAnchorId(anchorId)
    setInstruction(currentInstruction)
    setError(null)
  }

  const addPoint = () => {
    if (!isImageNode(selectedNode)) return
    addAnchor(selectedNode.id, {
      type: 'point',
      targetNodeId: selectedNode.id,
      x: Math.round(selectedNode.x + selectedNode.width * 0.5),
      y: Math.round(selectedNode.y + selectedNode.height * 0.5),
      instruction: '',
    })
  }
  const addBox = () => {
    if (!isImageNode(selectedNode)) return
    addAnchor(selectedNode.id, {
      type: 'box',
      targetNodeId: selectedNode.id,
      x: Math.round(selectedNode.x + selectedNode.width * 0.25),
      y: Math.round(selectedNode.y + selectedNode.height * 0.25),
      width: Math.round(selectedNode.width * 0.5),
      height: Math.round(selectedNode.height * 0.5),
      instruction: '',
    })
  }

  const generate = async () => {
    if (!selected || generating) return
    const { node, anchor } = selected
    const trimmed = instruction.trim()
    if (!trimmed) {
      setError('指令不能为空')
      return
    }
    setGenerating(true)
    setError(null)
    try {
      updateAnchorInstruction(node.id, anchor.id, trimmed)
      // Prompt carries the instruction + anchor geometry context (paradigm: the
      // upstream receives both the intent and the spatial target).
      const geometry =
        anchor.type === 'box'
          ? ` [anchor box @ ${anchor.x},${anchor.y} ${anchor.width}x${anchor.height}]`
          : ` [anchor point @ ${anchor.x},${anchor.y}]`
      const prompt = `${trimmed}${geometry}`
      const resultNodeIds =
        anchor.type === 'box'
          ? await generateImageEdit(node.id, 'area-edit', prompt)
          : await generateBesideNode(node.id, prompt)
      if (resultNodeIds.length) recordAnchorResult(node.id, anchor.id, resultNodeIds)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  const inputRef = useRef<HTMLInputElement>(null)
  // Keep a ref to the latest generate() so the e2e window hook calls the current
  // closure (with up-to-date instruction/selected state), not a stale one.
  const generateRef = useRef(generate)
  useEffect(() => {
    generateRef.current = generate
  })

  // Dev/e2e hook: expose the anchor-selection setter + a generate trigger on window
  // so tests can drive the closed-loop without relying on mark/button hit-tests
  // (small marks + off-screen panels race the click). Manual UI still works.
  useEffect(() => {
    const w = window as {
      __setSelectedAnchorId?: (id: string | null) => void
      __anchorGenerate?: () => Promise<void>
    }
    w.__setSelectedAnchorId = (id) => setSelectedAnchorId(id)
    w.__anchorGenerate = () => generateRef.current()
    return () => {
      delete w.__setSelectedAnchorId
      delete w.__anchorGenerate
    }
  }, [])

  // Render nothing when there are no committed anchors. The first anchor is
  // created via the store action (debug entry — real canvas tool integration is
  // deferred); once one exists, marks + the instruction panel render. This keeps
  // the overlay out of the render path for unrelated views (e.g. the assets drawer)
  // so it can't perturb their timing.
  if (allAnchors.length === 0) return null

  return (
    <>
      {/* debug toolbar */}
      <div className="anchor-debug-toolbar" data-testid="anchor-debug-toolbar" style={toolbarStyle}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>Anchor MVP</span>
        <button
          type="button"
          className="anchor-debug-add-point"
          data-testid="anchor-debug-add-point"
          onClick={addPoint}
          disabled={!isImageNode(selectedNode)}
          style={btnStyle}
        >
          + Point
        </button>
        <button
          type="button"
          className="anchor-debug-add-box"
          data-testid="anchor-debug-add-box"
          onClick={addBox}
          disabled={!isImageNode(selectedNode)}
          style={btnStyle}
        >
          + Box
        </button>
      </div>

      {/* anchor marks (screen space) */}
      {allAnchors.map(({ anchor }) => {
        const left = toOverlayX(viewport, anchor.x)
        const top = toOverlayY(viewport, anchor.y)
        const isSel = anchor.id === selectedAnchorId
        if (anchor.type === 'box') {
          return (
            <div
              key={anchor.id}
              className={`anchor-mark anchor-mark-box${isSel ? ' is-selected' : ''}`}
              data-anchor-id={anchor.id}
              data-anchor-type="box"
              data-anchor-has-result={Boolean(anchor.resultNodeIds?.length)}
              onClick={(e) => {
                e.stopPropagation()
                selectAnchor(anchor.id, anchor.instruction)
              }}
              style={{
                position: 'absolute',
                left,
                top,
                width: Math.max(8, (anchor.width ?? 0) * viewport.scale),
                height: Math.max(8, (anchor.height ?? 0) * viewport.scale),
                border: `${isSel ? 2 : 1}px dashed ${isSel ? '#ff8a00' : '#6957e8'}`,
                borderRadius: 4,
                cursor: 'pointer',
                pointerEvents: 'auto',
                boxSizing: 'border-box',
                zIndex: 60,
              }}
            />
          )
        }
        return (
          <div
            key={anchor.id}
            className={`anchor-mark anchor-mark-point${isSel ? ' is-selected' : ''}`}
            data-anchor-id={anchor.id}
            data-anchor-type="point"
            data-anchor-has-result={Boolean(anchor.resultNodeIds?.length)}
            onClick={(e) => {
              e.stopPropagation()
              selectAnchor(anchor.id, anchor.instruction)
            }}
            style={{
              position: 'absolute',
              left: left - 5,
              top: top - 5,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: isSel ? '#ff8a00' : '#6957e8',
              border: '2px solid #fff',
              cursor: 'pointer',
              pointerEvents: 'auto',
              boxSizing: 'border-box',
              zIndex: 60,
            }}
          />
        )
      })}

      {/* floating instruction panel for the selected anchor */}
      {selected ? (
        <div
          className="anchor-instruction-panel"
          data-testid="anchor-instruction-panel"
          style={{
            position: 'absolute',
            left: toOverlayX(viewport, selected.anchor.x) + 12,
            top: toOverlayY(viewport, selected.anchor.y) - 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: 6,
            background: 'rgba(255,255,255,0.96)',
            border: '1px solid #d8d2c8',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            pointerEvents: 'auto',
            zIndex: 50,
            minWidth: 220,
          }}
        >
          <label style={{ fontSize: 10, opacity: 0.6 }}>
            {selected.anchor.type} anchor → {selected.node.title.slice(0, 24)}
          </label>
          <input
            ref={inputRef}
            className="anchor-instruction-input"
            data-testid="anchor-instruction-input"
            type="text"
            value={instruction}
            placeholder="指令:如 add neon glow"
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                generate()
              }
            }}
            disabled={generating}
            style={{ fontSize: 12, padding: '4px 6px', border: '1px solid #ccc', borderRadius: 4 }}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className="anchor-generate-button"
              data-testid="anchor-generate-button"
              onClick={generate}
              disabled={generating}
              style={{ ...btnStyle, flex: 1 }}
            >
              {generating ? '生成中…' : 'Generate'}
            </button>
          </div>
          {error ? <span style={{ color: '#c33', fontSize: 11 }}>{error}</span> : null}
          {selected.anchor.resultNodeIds?.length ? (
            <span style={{ fontSize: 10, color: '#2a7' }}>
              结果: {selected.anchor.resultNodeIds.join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

const toolbarStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  padding: '4px 8px',
  background: 'rgba(255,255,255,0.92)',
  border: '1px solid #d8d2c8',
  borderRadius: 6,
  boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  pointerEvents: 'auto',
  zIndex: 40,
}

const btnStyle: CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  border: '1px solid #b9b2a4',
  borderRadius: 4,
  background: '#fff',
  cursor: 'pointer',
}
