# src/render — 渲染投影与交互契约(P3-0a)

> SC6.1 主体第一段。本目录是 renderer 与数据模型之间的**契约层**:
> renderer 只许消费 `RenderNode`/`RenderEdge`/`RenderAnchor` + 叶视觉类型
> (`CanvasNodeFill` 等),**不得直接依赖 `MivoCanvasNode`**。
> Anchor(P4-a CanvasAnchor)演进时只改 `projection.ts` 的投影函数,不动 renderer。

## 模块清单(P3-0a 全部为新增模块 + 测试,不改 renderer/controller 运行行为)

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
