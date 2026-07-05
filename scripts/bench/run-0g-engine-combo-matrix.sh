#!/usr/bin/env bash
set -euo pipefail

DATE="${DATE:-2026-07-05}"
RUNS="${RUNS:-3}"
LOD_PX="${LOD_PX:-32}"
PORT_BASE="${PORT_BASE:-4180}"

ENGINES=(leafer pixi)

for index in "${!ENGINES[@]}"; do
  engine="${ENGINES[$index]}"
  port=$((PORT_BASE + index))
  npm run bench:collect -- \
    --nodes=20000 \
    --dpr=1,2 \
    --runs="${RUNS}" \
    --renderer="${engine}" \
    --culling=on \
    --virtualize=on \
    --lod=on \
    --lod-px="${LOD_PX}" \
    --port="${port}" \
    --skip-drag \
    --date="${DATE}" \
    --output="bench/baselines/engine-combo-0g-${engine}-20k-${DATE}.json" \
    --output-type=engine-combo-0g-final \
    --gate-status=pan-gate \
    --note="0g engine combo: freeze pan uses engine transform only; LOD threshold ${LOD_PX}px; zoom collected as non-gate baseline"
done
