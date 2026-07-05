# PixiJS 裸画天花板探针

独立 standalone 探针，回答「MivoCanvas 换 PixiJS 引擎裸画 20k 能否直接达 33ms bar」。**不属于 app 构建**——零 src/ 改动，独立目录 + 独立 package.json，由 Playwright 驱动 standalone HTML 页面。

## 它测什么

- 同一 `bench/fixtures/bench-dom-mixed-*.json` 数据源（与 `scripts/bench/collect.mjs` 的 0b Leafer/DOM 基线同源，保证对照公平）。
- Pixi v8 `Application`（WebGL）渲染：image→Sprite（8 张共享占位纹理轮换，批合）、frame/rect→Graphics、connector→Graphics 折线、text→Pixi Text（per-node 独立纹理，可 `--text=skip` 跳过）。
- 复刻 `collect.mjs` 的 pan/zoom 手势（同坐标/步数/wheel delta/150ms settle），rAF 采帧时间 + LongTask + CDP heap，runs=3 取中位。
- 绘制证据：children 数 + `gl.readPixels` 像素非空校验（沿用 0b 教训）。

## 它不测什么（诚实边界）

- **无 React/zustand store/per-node DOM/app 层开销** → 测的是引擎上限，不是集成后表现。Leafer 0b 基线是 app 内集成数，两者不对称，见 REPORT.md。
- image 纹理用 8 张共享占位（批合，乐观值）；真实每图独立纹理未测。
- text 用 per-node Pixi Text（独立纹理，悲观值，未优化批合）。

## 跑

```bash
# 1. 装探针依赖（独立 package.json，不进主仓）
cd bench/pixi-probe && npm install && cd ../..

# 2. 跑（需主仓 node_modules 已装：vite + playwright + fixture-lib）
node bench/pixi-probe/run.mjs --nodes=5000,10000,20000 --runs=3 --dpr=1 --text=skip --culling=off
```

参数：
- `--nodes=` 逗号分隔节点数（5k+ fixture 按需生成，同 collect.mjs）
- `--runs=` 每配置 run 数，取中位
- `--dpr=` 逗号分隔 DPR
- `--text=on|skip` 是否渲染 text 节点（`on`=Pixi Text 独立纹理；`skip`=跳过，引擎上限下界）
- `--culling=on|off` Pixi CullerPlugin 开关（`on`=每帧按 screen 矩形剔除离屏子节点；`off`=全画）
- `--headed` 看着跑（默认 headless）

结果写 `bench/pixi-probe/results/pixi-<nodes>-<text>-culling<on|off>-dpr<d>-<date>.json`，结构对齐 `bench/baselines/0b-*.json` 便于并排对照。

## 文件

| 文件 | 角色 |
|---|---|
| `index.html` | standalone 页面，`.canvas-shell` 容器（对齐 app 的 shell 契约，让 pan/zoom 手势代码不改） |
| `bench-runtime.mjs` | Pixi 启动 + fixture 渲染 + pan/zoom 视口 + 像素证据 + 捕获运行时（`globalThis.__MIVO_PIXI_BENCH__`，对齐 `collect.mjs` 的 `__MIVO_BENCH__`） |
| `run.mjs` | Playwright 驱动：起 vite → 开 chromium → loadFixture → waitForRender → pan/zoom → heap → 聚合中位 → 写 JSON |
| `package.json` | 独立 deps（仅 `pixi.js@8.19.0`）；vite/playwright 复用主仓 |
| `REPORT.md` | 结论 + 对照表 + 纹理/culling/不对称性分析 |
| `results/` | 跑出来的 JSON（gitignore，不入仓） |

## CI

探针不进 PR CI（同 0b 矩阵策略：重 bench 只本地/ nightly 跑）。PR 只带探针代码本身——独立目录，零 app 影响，lint/tsc/structure-guard 都不扫到（`.mjs`+`.html`，不在 `src/`）。
