#!/usr/bin/env bash
# Phase 0c pan-cache spike matrix: Leafer only, culling on, DPR1, runs=3.
cd "$(dirname "$0")/../.." || exit 1
mkdir -p bench/baselines
export PATH="$PWD/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

run () {
  local nodes=$1 pan_cache=$2
  local out="bench/baselines/0c-${nodes}-leafer-pan-cache-${pan_cache}-dpr1.json"
  local logf="bench/baselines/.0c-${nodes}-leafer-pan-cache-${pan_cache}-dpr1.log"
  echo "=== ${nodes} leafer culling=on pan-cache=${pan_cache} dpr1 (runs=3) ==="
  npm run bench:collect --silent -- --nodes=$nodes --renderer=leafer --culling=on --pan-cache=$pan_cache --dpr=1 --runs=3 --skip-drag --output=$out > "$logf" 2>&1
  if [ $? -ne 0 ]; then echo "[FAIL] ${nodes} pan-cache=${pan_cache}"; tail -20 "$logf"; exit 1; else echo "[ok] $out"; fi
}

for nodes in 5000 10000 20000; do
  run "$nodes" off
  run "$nodes" on
done

echo "=== 0c matrix summary ==="
node -e '
const fs=require("fs");const rows=[];
for(const f of fs.readdirSync("bench/baselines").filter(f=>f.startsWith("0c-")&&f.endsWith(".json"))){
  let r;try{r=JSON.parse(fs.readFileSync(`bench/baselines/${f}`,"utf8"))}catch{continue}
  for(const c of r.configs) for(const d of c.dprResults){const m=d.median; const first=d.runs?.[0]||{};
    rows.push({n:c.nodeCount,panCache:r.protocol.panCache,dpr:d.dpr,
      panP95:m.actions["canvas-pan"].p95FrameMs,panP50:m.actions["canvas-pan"].p50FrameMs,
      panDuration:m.actions["canvas-pan"].durationMs,panLongTasks:m.actions["canvas-pan"].longTaskCount,
      panLongTaskTotal:m.actions["canvas-pan"].longTaskTotalMs,
      zoomP95:m.actions["canvas-zoom"].p95FrameMs,heap:m.overall.heapDeltaMb,
      children:first.renderState?.leaferChildren??"",expected:first.renderState?.leaferExpectedChildren??"",
      pixel:first.renderState?.leaferPixelNonEmpty??"",captures:first.afterPanRenderState?.leaferPanCacheCaptures??""})}
}
rows.sort((a,b)=>a.n-b.n||a.panCache.localeCompare(b.panCache));
console.log("nodes|panCache|dpr|panP50|panP95|panDuration|panLongTasks|panLongTaskTotal|zoomP95|heapDelta|leaferChildren|expected|pixel|captures");
for(const r of rows)console.log(`${r.n}|${r.panCache}|${r.dpr}|${r.panP50}|${r.panP95}|${r.panDuration}|${r.panLongTasks}|${r.panLongTaskTotal}|${r.zoomP95}|${r.heap}|${r.children}|${r.expected}|${r.pixel}|${r.captures}`);
'
