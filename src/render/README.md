# src/render — 渲染投影与交互契约(目标契约,尚未全量接线;P3-0b partial 已落,全量 dispatch 挂 P3-0c gate)

> SC6.1 主体。本目录是 renderer 与数据模型之间的**目标契约层**(契约类型已冻结,全量 dispatch 接线尚未落地):
> renderer 只许消费 `RenderNode`/`RenderEdge`/`RenderAnchor` + 叶视觉类型
> (`CanvasNodeFill` 等),**不得直接依赖 `MivoCanvasNode`**。
> Anchor(P4-a CanvasAnchor)演进时只改 `projection.ts` 的投影函数,不动 renderer。
>
> **当前接线状态**:projection 类型/函数已就位但**生产渲染零消费**(renderer 仍走 `canvasRenderAdapter` 直读 `MivoCanvasNode`)。全量 dispatch 接线挂 **P3-0c gate**(详见下文),gate 触发前不算生效。

## P3-0b 状态(本 PR):partial — 全量 dispatch 接线 deferred

**已落地(本 PR,行为零变化,e2e 8 scenario 全绿)**:
- `interactionAdapter.ts` + test:`resolveHitTarget` 纯函数(edit-state 短路 + 委托 `topmostHit`)+ `isEditStateActive`。模块就位,作为未来全量接线的契约层。
- `useViewport.screenToCanvas` 切到 `viewportMatrix.screenToCanvas`(bit-for-bit 等价,与 `canvasInteraction.clientPointToCanvas` 逐位相同,viewportMatrix 单测交叉验证 + 全量 e2e 8 scenario 绿)。

**Deferred(全量 dispatch 接线,root cause 见下)**:
- InteractionAdapter 接入 controller(`handleCanvasPointerDown` 用 `resolveHitTarget`)+ 移除 per-node `onPointerDown` + DOM 承载节点委托。
- Layer enum 接线到 overlay 容器(zIndex)。
- AnchorOverlay → `RenderAnchor.screenX/Y`。
- 专项 e2e(topmostHit 集成级;函数级已由 `hitTest.test.ts` 22 用例 + `interactionAdapter.test.ts` 覆盖)。

**Root cause(全量 dispatch 接线的阻断点)**:
本 PR 曾尝试全量接线(shell `handleCanvasPointerDown` 经 `topmostHit` 路由 + 移除 per-node `onPointerDown`),`tsc`/`lint`/`test:unit` 全绿,但 `canvas-interactions` e2e 回归:Hand-tool 拖拽空白画布不再 pan(viewport 不动),而 Select-tool 拖拽同点 marquee 正常。

根因:**移除 per-node `onPointerDown` 后,tool handler 的 `event.currentTarget.setPointerCapture` 落点从 `.dom-node` 变为 shell**。`beginPan` 用 `event.currentTarget.setPointerCapture(pointerId)` 捕获指针,旧路径 currentTarget=`.dom-node`(节点 div),新路径 currentTarget=shell;捕获落点改变导致 Hand-tool pan 的 pointermove 流不复现。Select-tool marquee 不依赖 setPointerCapture 同路,故正常。

**修复路径(follow-up PR,P3-0c)**:
1. 让 tool handler 的 setPointerCapture 显式指向 shell(而非 `event.currentTarget`),或
2. 保留 per-node `onPointerDown` 仅作 capture target,shell 经 `topmostHit` 路由 anchor/line-markup hit(节点 hit 仍走 DOM dispatch),或
3. 在 controller 层显式 `shellRef.current.setPointerCapture` 后再分发到 tool handler。

三条路径都行为敏感,需专项 e2e(Hand-tool pan / 节点拖拽 / mask 编辑 / line-markup 选中)逐一验证,超出本 PR 预算。`interactionAdapter.ts` + `resolveHitTarget` 已就位,follow-up 直接接线。

## P3-0c(全量 dispatch 接线,挂 D10 gate)

> **裁决(lead,2026-07-04)**:P3-0b partial(#45)合入 main(66c2775)。全量 dispatch 接线拆为 **P3-0c**,作为 backlog 项挂在 **D10 gate** 上——gate 若触发 P3,P3-0c 是第一个 PR。

**partial 合并裁决理由**:
1. **SC6.1 验收口径 = "契约冻结 + 类型隔离 + 命中单测"**——本 PR 的契约层(`interactionAdapter.ts`/`resolveHitTarget`)+ `viewportMatrix` 单一来源 + 29 个函数级用例(`hitTest.test.ts` 22 + `interactionAdapter.test.ts` 7)已满足。全量 dispatch 接线不是 SC6.1 的验收项。
2. **全量 dispatch 重接线的真正受益方是 P3 Leafer 迁移**(Leafer paint 层需要自有 hit-test 替代 DOM `closest('.dom-node')`)。bench 初测(1000 节点 p95=25.1ms < 33ms 阈值)显示 **D10 gate 大概率判 P3 顺延**。为一个被 gate 挡住的阶段现在硬吃 Hand-tool pan 这类行为风险,收益为负。
3. **Hand-tool pan 回归的处置**:发现回归 → 立即回退 → 不带病交付 → root cause + 修复路径入文档。记正面档案。

**P3-0c 修复路径(lead 倾向选项 1)**:
1. **【首选】让 tool handler 的 `setPointerCapture` 显式指向 shell**(而非 `event.currentTarget`)——tool handler 改为接收一个显式的 capture target(shell ref),`beginPan`/`beginNodeMove` 等在 shell 上 capture。这样移除 per-node `onPointerDown` 后,捕获落点稳定在 shell,Hand-tool pan 的 pointermove 流恢复。
2. 保留 per-node `onPointerDown` 仅作 capture target,shell 经 `topmostHit` 路由 anchor/line-markup hit(节点 hit 仍走 DOM dispatch)——混合模型,部分保留 DOM dispatch。
3. 在 controller 层显式 `shellRef.current.setPointerCapture` 后再分发到 tool handler——shell 先 capture,tool handler 不再自己 capture。

**P3-0c 触发条件(D10 gate)**:
- gate 基准文件 `bench/baselines/dom-500-1000-<date>.json`(roadmap §12.1)达标 p95 > 33ms → P3 启动 → P3-0c 是第一个 PR。
- 或产品侧确认大画布需求(走一页决策记录,roadmap §12.1 D10 例外)。
- gate 未触发前,P3-0c 停留 backlog,不投入。

**P3-0c 验收清单(触发时)**:
- [ ] 选项 1 落地:tool handler setPointerCapture 显式指向 shell
- [ ] 移除 per-node `onPointerDown` + DOM 承载节点委托(pointer-events 策略:容器 none / 内部控件白名单 auto)
- [ ] `handleCanvasPointerDown` 经 `resolveHitTarget` 路由(anchor → node → empty)
- [ ] 专项 e2e:Hand-tool pan / 节点拖拽 / mask 编辑 / line-markup 选中 / DOM markdown-PDF 与图片重叠 topmost / selected 提升后顺序 / 编辑态优先级短路 / frame 背景-子节点穿透
- [ ] 行为零变化红线(全量 e2e:dev 8 scenario 绿)+ 差异点名(如 line-markup stroke tolerance 由 6-unit 容差替代 SVG stroke width,correction 非回归)

## 模块清单

| 模块 | 职责 | 状态 |
|------|------|------|
| `projection.ts` | `RenderNode`/`RenderEdge`/`RenderAnchor` 类型 + `projectNode`/`projectEdge`/`projectAnchor` 投影函数(内部跑 `normalizeCanvasNodeV2`,把 legacy + V2 输入都归一为 V2 形投影) | ✅ |
| `viewportMatrix.ts` | 统一 viewport matrix:`screenToCanvas`/`canvasToScreen`/`canvasToContainer`/`createViewportMatrix`/`applyMatrix`/`invertMatrix`。与 `canvasInteraction.clientPointToCanvas` bit-for-bit 等价(已单测交叉验证) | ✅ |
| `layers.ts` | `Layer` enum(frame 底层/content/selected提升/preview/handles/floatingUI/editOverlay)+ `layerZIndex`/`layerName`。当前 main 用 DOM-order stacking(无 inline zIndex),本 enum 为 P3-0b overlay 提供显式 zIndex | ✅ |
| `hitTest.ts` | 纯函数 hit-test:`pointInNode`/`pointInMarkupStroke`/`pointInAnchor`/`topmostHit`(两遍:anchors 先,nodes 后)+ `sortForHitTest`(frame<content<selected)。D2:锚点选中是一等交互态 | ✅ |

## 投影字段清单(对齐 docs/decisions/p4-schema-spike.md §3)

- **RenderNode**:`id, type, status, title, geometry{x,y,w,h,rotation}, hidden, locked, favorited, selected, fills[], strokes[], effects?, text?, fontSize?, textColor?, fontWeight?, textAlign?, textAutoWidth?, markdownDisplayMode?, markup*, section*, asset*, relations*, generation?, aiWorkflow?, anchors?[]`
- **RenderAnchor**:`id, type, targetNodeId, x, y, width?, height?, instruction, resultNodeIds?, screenX?, screenY?`
- **RenderEdge**:`id, from, to, type, prompt, createdAt`

`RenderAnchor.screenX/Y` 仅当 `ProjectionContext.matrix` 传入时填充(投影层算好屏幕坐标,DOM overlay 直接读)。不传 matrix 时投影是纯 canvas 坐标(便于测试 + 不耦合 viewport)。

### 与 spike §3 清单的 diff(实现时发现的调整)

1. **RenderNode.generation**:spike §3.1 写 `generation | generation | 直取`。实现时为避免 `RenderNode` 引用 `MivoCanvasNode['generation']`(inline 类型,会让 renderer 传递依赖 MivoCanvasNode),**定义了本地 `RenderGeneration` 类型**(同 shape)。SC6.1 口径更严。
2. **RenderAnchor.screenX/Y**:spike §3.2 列为 RenderAnchor 字段。实现时**保留为 optional 字段**,但只在 `projectNode`/`projectAnchor` 传入 `ViewportMatrix` 时填充。投影函数本身保持纯 canvas 坐标(无 viewport 耦合),screen 投影是 opt-in。
3. **未新增字段**:spike §3.1 列的所有字段都已在 RenderNode 上,无缺漏。

## DOM overlay pointer-events 策略(P3-0b 接线时遵守)

| 容器 | pointer-events | 说明 |
|------|----------------|------|
| `.canvas-host`(交互壳层) | `auto` | shell 层统一捕获 pointer(InteractionAdapter 入口) |
| canvas-content 层(变换容器) | `none` | 节点 DOM 不各自消费 pointer,统一委托 |
| DOM 承载节点(markdown/pdf/video/task/ai-slot/annotation) | 容器 `none`,**白名单控件** `auto` | video 播放条 / pdf 滚动 / text 编辑 / link 点击等原生交互白名单 |
| selection handles / resize handles | `auto` | 在 handles 层,优先级高于 content |
| 浮层(floating UI:anchor 浮层 / ctx menu / popovers) | `auto` | FloatingUI 层 |
| 编辑态 overlay(crop/mask/text-edit) | `auto` + **短路 hit-test** | EditOverlay 层,最高优先级 |

## 编辑态短路规则

编辑态(crop / mask / text-edit)激活时:
1. **hit-test 短路**:`topmostHit` 不参与(InteractionAdapter 直接判定编辑态 active → 路由到编辑态 handler);
2. **z-order 最高**:编辑态 overlay 渲染在 `Layer.EditOverlay`(60),高于 FloatingUI;
3. **pointer capture 归 shell**:编辑态不自己 capture,委托给 shell(统一交互分发模型)。

## P3-0b 接线清单(本 PR 不做,等 B2 hooks 落地后另派)

- [ ] **InteractionAdapter**:shell 层统一 pointer 捕获 → `screenToCanvas`(viewportMatrix)→ `topmostHit`(hitTest)→ 路由到现有 interaction hooks
- [ ] **统一 viewport matrix 接线**:`useViewport.screenToCanvas` 改为调 `viewportMatrix.screenToCanvas`(删 canvasInteraction.clientPointToCanvas 的内联公式,P3-0b 收尾)
- [ ] **CanvasNodeView 切换消费 RenderNode**:`canvasRenderAdapter` 的 CSS 格式化改为消费 `RenderNode` 而非 `MivoCanvasNode`;renderer 不再 import `MivoCanvasNode`
- [ ] **anchor overlay 接 RenderAnchor**:D2 的 `AnchorOverlay` 用 `projectNode(node, {matrix}).anchors` 的 `screenX/Y` 定位 mark;`selectedAnchorId` 上升为 store 态(D2 纪要 §2)
- [ ] **hit-test 接线**:controller 的 topmost 判定从 DOM `closest('.dom-node')` 切到 `topmostHit`;命中纯函数补单测(点选/描边/重叠/frame 穿透/locked/hidden/anchor)已在本 PR 提供
- [ ] **Layer enum 接线**:overlay 容器 `style={{ zIndex: layerZIndex(Layer.Handles) }}`;D2 AnchorOverlay 的 `zIndex:50` 改为 `Layer.FloatingUI`
- [ ] **connector stroke hit**:`connectorGeometry` 输出 polyline → `distToPolyline`(已在 hitTest 提供)

## 不做什么(防 scope creep)

- 不改 CanvasNodeView / MivoCanvas / controller 运行行为(P3-0a 是纯增量模块)
- 不删 `canvasRenderAdapter`(P3-0b 切换消费 RenderNode 后再议;P4 验收前保留作回滚阀)
- 不删 `canvasInteraction.clientPointToCanvas`(P3-0b 统一 viewport matrix 时收尾)
- 不引 `@leafer-in/editor`(roadmap §10.6)
