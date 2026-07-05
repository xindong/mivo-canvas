#!/usr/bin/env bash
# Phase 0d Pixi in-app spike matrix: Pixi only, app DOM culling on, BitmapText, DPR1, runs=3.
cd "$(dirname "$0")/../.." || exit 1
mkdir -p bench/baselines
export PATH="$PWD/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

run () {
  local nodes=$1
  local out="bench/baselines/0d-${nodes}-pixi-bitmaptext-culling-on-dpr1.json"
  local logf="bench/baselines/.0d-${nodes}-pixi-bitmaptext-culling-on-dpr1.log"
  echo "=== ${nodes} pixi app-culling=on bitmaptext dpr1 (runs=3) ==="
  npm run bench:collect --silent -- --nodes=$nodes --renderer=pixi --culling=on --dpr=1 --runs=3 --skip-drag --output=$out > "$logf" 2>&1
  if [ $? -ne 0 ]; then echo "[FAIL] ${nodes} pixi"; tail -40 "$logf"; exit 1; else echo "[ok] $out"; fi
}

for nodes in 5000 10000 20000; do
  run "$nodes"
done

echo "=== 0d matrix summary ==="
node -e '
const fs=require("fs");const rows=[];
for(const f of fs.readdirSync("bench/baselines").filter(f=>f.startsWith("0d-")&&f.endsWith(".json"))){
  let r;try{r=JSON.parse(fs.readFileSync(`bench/baselines/${f}`,"utf8"))}catch{continue}
  for(const c of r.configs) for(const d of c.dprResults){const m=d.median; const first=d.runs?.[0]||{};
    rows.push({n:c.nodeCount,dpr:d.dpr,
      panP95:m.actions["canvas-pan"].p95FrameMs,panP50:m.actions["canvas-pan"].p50FrameMs,
      panDuration:m.actions["canvas-pan"].durationMs,panLongTasks:m.actions["canvas-pan"].longTaskCount,
      panLongTaskTotal:m.actions["canvas-pan"].longTaskTotalMs,
      zoomP95:m.actions["canvas-zoom"].p95FrameMs,heap:m.overall.heapDeltaMb,
      children:first.renderState?.pixiChildren??"",expected:first.renderState?.pixiExpectedChildren??"",
      pixel:first.renderState?.pixiPixelNonEmpty??"",text:first.renderState?.pixiTextStrategy??"",
      textures:first.renderState?.pixiTexturePoolSize??""})}
}
rows.sort((a,b)=>a.n-b.n);
console.log("nodes|dpr|panP50|panP95|panDuration|panLongTasks|panLongTaskTotal|zoomP95|heapDelta|pixiChildren|expected|pixel|textStrategy|texturePool");
for(const r of rows)console.log(`${r.n}|${r.dpr}|${r.panP50}|${r.panP95}|${r.panDuration}|${r.panLongTasks}|${r.panLongTaskTotal}|${r.zoomP95}|${r.heap}|${r.children}|${r.expected}|${r.pixel}|${r.text}|${r.textures}`);
'
