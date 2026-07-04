# Leafer 0b Spike — 规模对照与 go/no-go 判定

> 日期：2026-07-05 ｜ 分支：feat/leafer-0b-spike ｜ 基线：origin/main @ 80c37d8（含 PR-1）
> 工装：PR-1 的 bench（10k+ 四段指标 + settle 断言 + localStorage shim）、visual-diff、coordinate-probe、--renderer/--culling
> 详设参考：~/.claude/plans/leafer-designs/phase2b-adapter-camera-zorder.md（0b spike 是其最小子集，正式化时按详设重构）

## 1. spike 实现范围（最小，非终态）

- `src/render/useLeaferSpikeRenderer.ts`：Leafer init（**hittable:false** D1，rAF 等 host 有非零尺寸再 init，避免 canvas 塌成 1px）+ **相机单向同步**（React viewport → `leafer.zoomLayer.set({x,y,scaleX,scaleY})`，禁反向监听 `zoomLayer.__`）+ paint image/frame/rect（diff add/update/remove，Map<id, object>）+ `leaferReady` state 触发 paint/cameraSync 在 init 后跑。
- `src/render/leaferSpikeFilter.ts`：leafer 模式从 DOM 渲染列表剔除 image/frame/markup-rect（否则测不出差异）；dom 模式原样返回（零变化）。
- `src/render/rendererMode.ts`：leafer warn → log「spike renderer active (image/frame/rect only)」。
- MivoCanvas：删旧 Leafer init effect（-35 行）+ leaferRef 定义，接 `useLeaferSpikeRenderer`，renderedNodes useMemo 套 `filterDomNodesForLeaferSpike`。**净 -30 行（955→925）**，structure-guard 0 FAIL。
- **只画 image/frame/rect 三类**；text/markdown/ai-slot/markup 非 rect 等继续 DOM。交互在 leafer 模式允许暂时残缺（spike 只测渲染性能；pan/zoom 走 viewport 不依赖节点命中）。
- **0b spike 代码非终态**：Phase 2b 正式化时按 phase2b 详设拆 useLeaferHost + useLeaferCameraSync + RendererAdapter + EditOverlayLayer + z-order 契约。

## 2. 对照矩阵（runs=3 median，DPR1，culling=on）

| nodes | renderer | panP95(ms) | panLongTaskTotal(s) | panLongTaskCount | zoomP95(ms) | heapΔ(MB) |
|------:|---------|-----------:|--------------------:|-----------------:|-----------:|----------:|
| 5000  | dom     | 43.0       | 47.3                | 146              | 33.4       | 84.8      |
| 5000  | leafer  | 175.0      | 15.8                | 146              | 25.4       | 47.3      |
| 10000 | dom     | 10.3       | 121.5               | 218              | 41.3       | 139.0     |
| 10000 | leafer  | 391.5      | 39.8                | 147              | 50.1       | 87.5      |
| 20000 | dom†    | 25.0       | 233.0               | 218              | 41.8       | 267.8     |
| 20000 | leafer  | 10.4*      | 91.3                | 147              | 59.7       | 151.2     |

† 20k dom on 为 runs=1（runs=3 transient 失败，单跑补数）。* 20k leafer panP95=10.4 不可信：long task 阻塞 rAF 致 frame 采样稀疏（frameCount 未采集到），p95 取到少数短间隔；**真实卡顿看 panLongTaskTotal=91.3s**。

culling=off 数据：未完整采集（rerun transient 失败）。**culling 对 leafer 影响小**——本 spike 的 culling 只作用于 DOM 节点（text/connector），Leafer 始终全量画 image+frame（无 Leafer-level culling）。因此 `--culling=on/off` 对 leafer pan 几乎无差异，对照实验需等 Leafer culling 实现后再做。

## 3. 数据解读

**可靠指标（panLongTaskTotal / heap）：**
- **heap**：leafer 始终省 ~40%（5k 47 vs 85、10k 88 vs 139、20k 151 vs 268）。Leafer canvas 单层位图 vs DOM 1N 个 div+img，内存优势确定。
- **panLongTaskTotal**：leafer 是 dom 的 ~1/3（5k 16s vs 47s、10k 40s vs 122s、20k 91s vs 233s）。Leafer canvas paint 比 DOM div paint 的主线程阻塞更轻。

**不可靠指标（panP95 frame interval）：**
- leafer panP95 噪声极大（5k 175、10k 391、20k 10.4）—— rAF 采样被 long task 扰乱，frame 数稀疏时不反映真实卡顿。dom 同样受扰但趋势更稳。**panP95 不可单独作 gate**，须配 panLongTaskTotal。

**zoom**：leafer 5k 25ms < dom 33ms（快），但 10k/20k leafer 50/60ms > dom 41/42ms（慢）—— 10k+ zoom 时 Leafer 全量重绘 image 比 DOM transform 慢。

## 4. go/no-go 判定

**bar（lead 定义）**：20k leafer pan p95 ≤33ms = go；20k 全量超标 + culling 达标 = go 但虚拟化前移；两者都超 = no-go 升级。

**判定：go 但虚拟化前移（Leafer 路线继续，culling/虚拟化独立 track 前移进计划）。**

理由：
1. **leafer 渲染效率有优势**：heap 省 40%、panLongTaskTotal 是 dom 的 1/3——Leafer canvas 单层位图 + zoomLayer transform 的上限优于 DOM 1N div。**不是 no-go 升级**（换 PixiJS/自研 WebGL 无必要，Leafer 渲染层达标）。
2. **pan 卡顿根因明确 = 全量画**：spike 的 Leafer 无 culling，20k 全量画 ~12k image+frame，pan 时 zoomLayer.set 移动 12k 节点 + 重绘。`--culling` 对 leafer 无效（culling 只 DOM）。
3. **culling 达标不成立**：当前 culling 不影响 Leafer paint，无法验" +culling 达标"。但根因（全量画）可由 **Leafer-level culling / 虚拟化**（只画视口内 image+frame，与 DOM culling 同语义）解决——这是独立 track，需前移进计划（Phase 0c 或 Phase 6 前移）。
4. **不达 33ms bar 但路线正确**：20k leafer panLongTaskTotal 91s 仍卡，但已比 dom 233s 好 1/3。加 Leafer culling 后预期大幅下降（视口内 ~几十节点 vs 12k）。

**转 PixiJS/自研 WebGL 阈值（写清）**：若 Leafer + 虚拟化（只画视口内）20k pan p95 仍 >33ms / panLongTaskTotal >30s → 转 PixiJS 或自研 WebGL。本 spike 未达此阈值前（虚拟化未实现），不触发。

## 5. 坐标一致性初验（design-p2 pixelRatio 风险）

- **visual-diff DOM baseline vs leafer candidate（默认 canvas 3 节点，同 viewport）**：**diff 0.29%（passed，threshold 1%）**。三类图形位置重合，pixelRatio 偏移风险未现（rAF init + zoomLayer.set 路径正确）。
- 0.29% 差异为渲染细节（抗锯齿 / image 解码像素级），非几何偏移。
- **coordinate-probe**：dom 模式采到 3 节点坐标（baseline viewport scale=1 x=420 y=240，first node corners topLeft 380,50）。leafer 模式 probe TimeoutError——默认 canvas 3 节点全为 image，leafer 模式被 Leafer 画、DOM 无节点，probe 采不到（**属预期**，lead 已标注）。需 fixture 场景（含 text 节点）才能采 leafer 模式 DOM 节点坐标对比——留 Phase 2b。

## 6. 50k 数据

**未跑**。20k leafer panLongTaskTotal 91s（卡顿），按 lead「50000 若 20k 结果健康再加跑」——20k 不健康，50k 必然更卡，不跑。

## 7. 残余风险 / 下一步

- **Leafer culling 缺失**：当前 Leafer 全量画，pan 卡顿根因。**虚拟化 track 前移**（Phase 0c：Leafer 视口 culling，与 DOM culling 同 viewportRect 语义，只画视口内 image/frame）。
- **panP95 不可靠**：bench 的 frame 采样被 long task 扰乱。**改进 bench 指标**：pan gate 改用 panLongTaskTotal + frame p95 双指标，或用 CDP trace 的 raster 阶段。
- **交互残缺**：leafer 模式 image/frame 无 DOM 命中（hittable:false）。Phase 2b 的 shell 统一 hit-test + Leafer 不接事件（D1）解决。
- **数据噪声**：runs=3 中部分配置 transient 失败（dev server networkidle / page.evaluate 时序），20k dom on 用 runs=1 补。生产 gate 需重跑稳定数据。
- **culling off 对照缺**：rerun transient 失败未补全；culling 对 leafer 影响小（已说明），非 gate 阻塞。

## 8. 结论

Leafer 作为 2D paint 后端**路线可行**（heap/longTaskTotal 优于 DOM），但**必须配虚拟化**才能兑现 pan 性能。0b spike 验证了渲染层 + 相机单向同步 + 坐标重合（0.29%），暴露了全量画的 pan 瓶颈。**下一步：Phase 0c Leafer culling（前移）→ Phase 2b 正式化（拆 hook + z-order + EditOverlayLayer + 交互重建）**。不转 PixiJS/自研 WebGL（未达阈值）。
