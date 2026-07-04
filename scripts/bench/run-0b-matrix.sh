#!/usr/bin/env bash
# 0b-2 对照矩阵 bench：用 npm run 避免 node 直接调的 cwd/PATH 问题
cd "$(dirname "$0")/.." || exit 1
mkdir -p bench/baselines
export PATH="$PWD/node_modules/.bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

run () {
  local nodes=$1 renderer=$2 culling=$3 dpr=$4
  local out="bench/baselines/0b-${nodes}-${renderer}-${culling}-dpr${dpr}.json"
  local logf="bench/baselines/.${nodes}-${renderer}-${culling}-dpr${dpr}.log"
  if [ -f "$out" ]; then echo "[skip] $out"; return; fi
  echo "=== ${nodes} ${renderer} ${culling} dpr${dpr} (runs=3) ==="
  npm run bench:collect --silent -- --nodes=$nodes --renderer=$renderer --culling=$culling --dpr=$dpr --runs=3 --output=$out > "$logf" 2>&1
  if [ $? -ne 0 ]; then echo "[FAIL] ${nodes} ${renderer} ${culling} dpr${dpr}"; tail -4 "$logf"; else echo "[ok] $out"; fi
}

for culling in on off; do for r in dom leafer; do run 5000 $r $culling 1; done; done
for culling in on off; do for r in dom leafer; do run 10000 $r $culling 1; done; done
for culling in on off; do for r in dom leafer; do run 10000 $r $culling 2; done; done
for culling in on off; do for r in dom leafer; do run 20000 $r $culling 1; done; done

echo "=== 矩阵完成，汇总 ==="
node -e '
const fs=require("fs");const rows=[];
for(const f of fs.readdirSync("bench/baselines").filter(f=>f.startsWith("0b-")&&f.endsWith(".json"))){
  let r;try{r=JSON.parse(fs.readFileSync(`bench/baselines/${f}`,"utf8"))}catch{continue}
  for(const c of r.configs) for(const d of c.dprResults){const m=d.median;
    rows.push({n:c.nodeCount,ren:r.protocol.renderer,cull:r.protocol.culling,dpr:d.dpr,
      load:m.loadFixtureMs,sync:m.renderSyncMs,panP95:m.actions["canvas-pan"].p95FrameMs,
      zoomP95:m.actions["canvas-zoom"].p95FrameMs,heap:m.overall.heapDeltaMb,
      lt:m.overall.longTaskCount,panLt:m.actions["canvas-pan"].longTaskCount})}
}
rows.sort((a,b)=>a.n-b.n||a.ren.localeCompare(b.ren)||a.cull.localeCompare(b.cull)||a.dpr-b.dpr);
console.log("nodes|renderer|culling|dpr|loadFixture|renderSync|panP95|zoomP95|heapDelta|longTask|panLongTask");
for(const r of rows)console.log(`${r.n}|${r.ren}|${r.cull}|${r.dpr}|${r.load}|${r.sync}|${r.panP95}|${r.zoomP95}|${r.heap}|${r.lt}|${r.panLt}`);
'
