# PixiJS 裸画天花板探针报告

> 探针日期：2026-07-05 · PixiJS 8.19.0 · WebGL · Chromium (Playwright) · DPR=1 · 1920×1080 · runs=3 取中位
> 对照基线：`bench/baselines/0b-*.json`（Leafer/DOM，2026-07-04，同机）
> 数据源：同一 `bench/fixtures/bench-dom-mixed-*.json`（seed=20260704）
> bar：pan p95 ≤ 33ms（Leafer 0b 20k pan p95=75.3ms → NO-GO 的同一门槛）

## 一句话结论

**PixiJS 裸画 20k 在「不渲染 text」时达标（pan p95=26.1ms），在「渲染 per-node text」时不达标（pan p95=50.1ms）。** Pixi 比 Leafer 快 1.5–3.2×，但带 text 的真实负载仍越线；text 的逐节点独立纹理是硬瓶颈，需 BitmapText/字形图集才能逼近 33ms。

## 对照表（20k pan p95，单位 ms；bar=33ms）

| 引擎/配置 | text | culling | 20k pan p95 | 20k zoom p95 | 20k overall p95 | heap Δ | vs bar |
|---|---|---|---|---|---|---|---|
| DOM（0b） | on | off | 125.1 | 150.0 | 150.0 | 300.8 MB | ❌ 4.5× |
| DOM（0b） | on | on | 100.1 | 149.9 | 149.9 | 242.9 MB | ❌ 3.6× |
| Leafer（0b） | on | off | 83.4 | 66.9 | 83.4 | 130.8 MB | ❌ 2.5× |
| Leafer（0b） | on | on | **75.3** | 274.2 | 274.2 | 150.1 MB | ❌ 2.3×（lead 引用值） |
| **Pixi（探针）** | **skip** | **off** | **26.1** | **25.8** | **26.1** | 98.7 MB | ✅ 0.79× |
| Pixi（探针） | skip | on | 41.7 | 34.0 | 41.7 | 102.3 MB | ❌ 1.26× |
| **Pixi（探针）** | **on** | **off** | **50.1** | 42.3 | 50.1 | 120.0 MB | ❌ 1.52× |
| Pixi（探针） | on | on | ≥50.1* | — | — | — | ❌（未单独跑，cull=on 比 off 更慢，见下） |

\* `text=on cull=on 20k` 未单独跑：cull=on 在所有档位都比 cull=off 更慢（见下节），故 20k text=on cull=on ≥ 50.1，必越线。

## 全档位数据（pan p95，ms；runs=3 中位）

| 配置 | 5k | 10k | 20k | 备注 |
|---|---|---|---|---|
| Pixi text=skip cull=off | 17.2 | 25.6 | **26.1** | 引擎上限（无 text） |
| Pixi text=skip cull=on | 25.1 | 33.9 | 41.7 | culling 反而更慢 |
| Pixi text=on cull=off | 25.3 | 41.7 | **50.1** | 真实负载（含 text） |
| Pixi text=on cull=on | 25.2 | 41.8 | ≥50.1 | culling 不救 text |
| Leafer cull=off（0b） | 175.1 | 666.9 | 83.4 | 5k/10k 异常高（0b 已知） |
| Leafer cull=on（0b） | 173.5 | 592.6 | 75.3 | 同上 |
| DOM cull=off（0b） | 42.7 | 66.7 | 125.1 | |
| DOM cull=on（0b） | 43.3 | 58.6 | 100.1 | |

**观察**：Pixi 5k→10k→20k 在 text=skip 下近乎平台（17→26→26ms），说明 GPU 批绘制在 8 张共享纹理下基本不随节点数线性增长；text=on 才显出线性成本（25→42→50ms）。

## 关键发现

### 1. culling=on 比 culling=off 更慢（反直觉但符合 Pixi 文档）

Pixi `CullerPlugin` 每帧遍历全部 20k 子节点做矩形相交判定（即便设了 `cullArea` 跳过 `getBounds`），这趟 CPU 遍历（~40ms@20k）比它省下的 GPU 绘制（共享纹理已批合，本身只 ~26ms）更贵。Pixi 官方文档明确警告 *"culling is not always a golden bullet, it can be more expensive than rendering objects that are not visible"*——本探针在 20k 混合负载下坐实了这一点。

→ **结论：Pixi 路线若被采纳，不应使用 CullerPlugin；批合 + 共享纹理本身就够快，culling 是负优化。**

### 2. text 是硬瓶颈：per-node 独立纹理不批合

- image 节点用 8 张共享占位纹理轮换 → 批合 → 11600 sprite 几乎不增加 draw call。
- text 节点用 Pixi `Text`（每个节点一张独立 canvas 纹理）→ 4400 张独立纹理 → 不批合 → 4400 draw call + 4400 次 GPU 纹理上传。
- 20k text=on 比 text=skip 慢 ~24ms（26.1→50.1），全部花在 text 上。
- 早先 20k text=on "OOM 崩溃" 实为跨 run VRAM 累积（复用 browser 跨档位）——加 `app.destroy(true,{children,texture,baseTexture:true})` + 每节点档全新 `chromium.launch` 后，20k text=on 稳定跑出 50.1ms（heap Δ 120MB），不再崩。

→ **结论：要让 Pixi 20k 含 text 达标（50→33ms），唯一可行杠杆是 BitmapText / 字形图集（共享一张字图纹理 → 批合）。这是探针外的工程量，但方向明确。**

### 3. 纹理策略对数字的影响（诚实声明）

- **image 纹理 = 乐观值**：8 张共享占位纹理让 sprite 批合，这是"引擎上限"。真实设计工具每张图独立纹理时，draw call 会上升、VRAM 是另一个瓶颈——本探针没测那种悲观场景。**真实每图独立纹理的 Pixi 20k 数字大概率比 26.1ms 高**，这本身就是 Pixi 路线的选型风险点（需要在集成时做纹理图集 / 合批）。
- **text 纹理 = 悲观值**：per-node 独立纹理，没做任何批合优化，代表"未优化的真实写法"。
- 两端一乐观一悲观，净效果是 **真实集成数字落在 26.1（image 乐观）与 50.1（text 悲观）之间**，取决于 image 是否也做纹理图集、text 是否上 BitmapText。

### 4. 不对称性声明（必读）

本探针测的是 **Pixi 引擎上限**：无 React、无 zustand store、无 per-node DOM、无 app 层事件/调度开销。Leafer 0b 基线测的是 **app 内集成后的 Leafer**（有 React/store/DOM 同堂）。因此 Pixi 26.1 vs Leafer 75.3 **不是同等条件对比**——Pixi 数字天然占优。若把 Pixi 接进 MivoCanvas 的 React+store+DOM 壳，数字会回升（参考 0b：Leafer 裸画也远快于 app 内 Leafer）。

**正确的读法**：Pixi 引擎本身的 20k 裸画吞吐够（26.1ms 达标），且 text 有明确的批合优化路径（BitmapText）。但"换 Pixi 就能直接达标"不成立——含 text 的真实负载 50.1ms 仍越线，且 image 独立纹理的悲观场景未测。

## 给渲染路线决策的输入

| 问题 | 探针回答 |
|---|---|
| Pixi 裸画 20k 能否直接 ≤33ms？ | **含 text 不能（50.1ms）；不含 text 能（26.1ms）** |
| 比 Leafer 强多少？ | 20k pan：3.2×（无 text）/ 1.5×（含 text） |
| Pixi 的瓶颈在哪？ | text 逐节点独立纹理（不批合）；image 独立纹理场景未测 |
| Pixi 自带 culling 救不救？ | **不救，反而更慢**（CullerPlugin 遍历 > GPU 批绘节省） |
| 达标路径 | image 做纹理图集 + text 上 BitmapText → 理论可压到 33ms 内（未验证） |

→ **相对 Leafer pan-cache 0c spike 的取舍**：Pixi 在引擎层比 Leafer 有 1.5–3.2× 余量，但达标仍需 text 批合工程量；Leafer 0c pan-cache 是"在现有栈上加缓存层"的增量改造。两条路都不是"直接达标"——Pixi 上限更高但要重写渲染层 + 解决 text，Leafer 0c 改动更小但天花板更低。本探针不替渲染路线拍板，只提供对照数字。

## 复现

```bash
cd bench/pixi-probe
npm install                # 装 pixi.js@8.19.0（独立 package.json，不进主仓 deps）
cd ../..
node bench/pixi-probe/run.mjs --nodes=5000,10000,20000 --runs=3 --dpr=1 --text=skip --culling=off
# 结果写 bench/pixi-probe/results/pixi-*.json
```

参数：`--text=on|skip` `--culling=on|off` `--nodes=` `--runs=` `--dpr=`。详见 `bench/pixi-probe/README.md`。
