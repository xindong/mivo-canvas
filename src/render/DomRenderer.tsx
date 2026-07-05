// DomRenderer — DOM paint surface behind the RendererAdapter contract (Phase 2b-1).
//
// Wraps the renderedNodes → <CanvasNodeView> map that lived inline in MivoCanvas.tsx.
// Extraction is behavior-identical: the same props flow to CanvasNodeView, computed
// the same way. MivoCanvas passes a `getNodeViewProps(node)` callback that closes
// over its local selection/edit/mask/handle state, so DomRenderer itself only owns
// the map + keying — it does not re-declare 22 prop types (avoids a type-mismatch
// footgun and keeps MivoCanvas the single source of truth for interaction state).
//
// 2b-2 will wire <DomRenderer> behind a <RendererLayer> switch (dom | leafer). The
// DOM path stays the default; visual diff vs. pre-2b-1 is 0%.

import { memo } from 'react'
import type { MivoCanvasNode } from '../types/mivoCanvas'
import { CanvasNodeView } from '../canvas/CanvasNodeView'
import type { CanvasNodeViewProps } from '../canvas/CanvasNodeView'

export type DomRendererProps = {
  /** The visible, filtered node set to paint (output of useEngineSpikeRenderers). */
  renderedNodes: MivoCanvasNode[]
  /** Per-node prop builder. MivoCanvas closes over its local selection/edit/mask/
   *  handle state here, so DomRenderer does not need to re-declare those types. */
  getNodeViewProps: (node: MivoCanvasNode) => Omit<CanvasNodeViewProps, 'key'>
}

export const DomRenderer = memo(function DomRenderer({
  renderedNodes,
  getNodeViewProps,
}: DomRendererProps) {
  return (
    <>
      {renderedNodes.map((node) => (
        <CanvasNodeView key={node.id} {...getNodeViewProps(node)} />
      ))}
    </>
  )
})
