# Phase 0g Engine Combo Spike

日期：2026-07-05

## 结论

**Leafer 变体 GO。** 20k、DPR1/2、runs=3 的 worst DPR pan p95 为 **17.3ms**，低于 33ms bar，pan long-task total 为 0ms。建议下一阶段以 Leafer 路线正式化：保留 0e 冻结语义，但 pan 期间只更新 Leafer zoomLayer；全景态启用阈值 LOD，zoom settle 后恢复高清。

**Pixi 变体 NO-GO。** DPR1 median pan p95 42.5ms，DPR2 median pan p95 125.0ms，DPR2 pan long-task total 20.621s。虽然裸 Pixi 探针曾在“不画文字”下过线，但 in-app 0g 的 Pixi 仍被 17,600 display objects + DPR2 WebGL render 成本击穿，不建议作为当前主线。

## 实现口径

- Flags：`?renderer=leafer|pixi&culling=on&virtualize=on&lod=on&lodPx=32`。
- Freeze：pan 期间不触发 React viewport commit；engine+LOD 模式下也跳过 DOM layer 和背景网格的逐帧 transform，只调用引擎相机桥。
- LOD：`max(node.width,node.height) * viewport.scale < 32px` 时 image/text 降级为纯色矩形；frame/rect 本来就是矩形。
- 20k fixture scale=0.08，因此 11,600 image + 4,400 text 进入 LOD；1,600 frame 保持高保真矩形。
- 证据门禁：children 数、LOD 计数、像素非空、DPR1/2 runs=3 JSON 均落盘。

## 最终矩阵

数据文件：

- `bench/baselines/engine-combo-0g-leafer-20k-2026-07-05.json`
- `bench/baselines/engine-combo-0g-pixi-20k-2026-07-05.json`

| Engine | DPR | pan p95 | pan duration | pan long-task total | zoom p95 | children | LOD nodes | 判定 |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Leafer | 1 | 9.9ms | 1,241.4ms | 0ms | 75.0ms | 17,600 | 16,000 | GO |
| Leafer | 2 | 17.3ms | 1,391.3ms | 0ms | 182.1ms | 17,600 | 16,000 | GO |
| Pixi | 1 | 42.5ms | 6,528.6ms | 534ms | 466.6ms | 17,600 | 16,000 | NO-GO |
| Pixi | 2 | 125.0ms | 20,842.6ms | 20,621ms | 592.8ms | 17,600 | 16,000 | NO-GO |

Zoom 不判卷，但暴露后续任务：Leafer zoom p95 在 DPR2 仍高，Phase 2b 正式化需要把 LOD 恢复放到 zoom settle 后的预算队列里。

## Zoom-in 恢复验证

Playwright 复核 20k fixture：

| Engine | before scale | before LOD | after scale | after LOD | pixel |
|---|---:|---:|---:|---:|---|
| Leafer | 0.08 | 16,000 | 4.00 | 0 | non-empty |
| Pixi | 0.08 | 16,000 | 4.00 | 0 | non-empty |

这说明 LOD 不是永久降级；放大到局部视图后 image/text 会恢复高保真绘制。

## 六方对照

| Phase | 配置 | 20k pan p95 | 结论 |
|---|---|---:|---|
| 0b | DOM culling-on | 100.1ms | NO-GO，仍有大量 DOM/过滤成本 |
| 0b | Leafer culling-on | 75.3ms | NO-GO，未解决 app 层逐帧开销 |
| 0c | Leafer pan-cache | 241.6ms | NO-GO，canvas snapshot/恢复成本过高 |
| #91 | bare Pixi skip text | 26.1ms | GO，但不是 in-app 集成 |
| 0d | in-app Pixi BitmapText | 341.5ms | NO-GO，集成层成本主导 |
| 0e | DOM virtualization freeze | 658.3ms worst DPR | NO-GO，移动数千 DOM 仍过重 |
| 0g | Leafer freeze + LOD | 17.3ms worst DPR | GO |
| 0g | Pixi freeze + LOD | 125.0ms worst DPR | NO-GO |

## 架构建议

推荐进入 **Leafer Phase 2b 正式化**，但必须把 0g 的三个约束作为硬设计：

1. pan 期间只做引擎相机 transform，不做 DOM/background transform，不做 React/store/过滤重算。
2. 全景态必须有 LOD；image/text 在小投影尺寸下不画纹理/文字。
3. zoom 恢复高清必须 settle 后分批，避免把 zoom p95 带进 pan 路线。

Pixi 暂不建议切主线。若将来重启 Pixi，需要先验证 LOD rect 合批（单 Graphics/mesh 而非 16k per-node Graphics）和 DPR2 render 成本，否则裸探针优势无法迁移到 app 内。
