#!/usr/bin/env bash
set -u

# Phase 0e DOM virtualization spike matrix: DOM only, culling on, virtualize on,
# DPR1/2, runs=3. Drag is skipped so pan/zoom stay isolated from node-move writes.

run() {
  local nodes=$1
  local dpr=$2
  local out="bench/baselines/0e-${nodes}-dom-virtualize-on-dpr${dpr}.json"
  local logf="bench/baselines/.0e-${nodes}-dom-virtualize-on-dpr${dpr}.log"
  echo "=== ${nodes} dom culling=on virtualize=on dpr${dpr} (runs=3) ==="
  npm run bench:collect --silent -- --nodes=$nodes --renderer=dom --culling=on --virtualize=on --dpr=$dpr --runs=3 --skip-drag --date=2026-07-05 --output=$out --output-type=0e-dom-virtualization --gate-status=final --note="Phase 0e DOM virtualization final matrix" > "$logf" 2>&1
  if [ $? -ne 0 ]; then
    echo "[FAIL] ${nodes} dpr${dpr}"
    tail -8 "$logf"
    return 1
  fi
  echo "[ok] $out"
}

for nodes in 5000 10000 20000; do
  for dpr in 1 2; do
    run "$nodes" "$dpr" || exit 1
  done
done

echo "nodes|dpr|panP95|panDuration|panLongTask|zoomP95|rendered|target|materialized|overscan|domPixel"
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises'

for (const nodes of [5000, 10000, 20000]) {
  for (const dpr of [1, 2]) {
    const path = `bench/baselines/0e-${nodes}-dom-virtualize-on-dpr${dpr}.json`
    const baseline = JSON.parse(await readFile(path, 'utf8'))
    const row = baseline.configs[0].dprResults[0]
    const run = row.runs[0]
    const pan = row.median.actions['canvas-pan']
    const zoom = row.median.actions['canvas-zoom']
    console.log([
      nodes,
      dpr,
      pan.p95FrameMs,
      pan.durationMs,
      pan.longTaskTotalMs,
      zoom.p95FrameMs,
      row.gate?.renderedNodeCount ?? run.renderState.renderedNodeCount,
      run.renderState.virtualizeTargetNodeCount,
      run.renderState.virtualizeMaterializedNodeCount,
      run.renderState.virtualizeOverscanPx,
      run.renderState.domPixelNonEmpty,
    ].join('|'))
  }
}
NODE
