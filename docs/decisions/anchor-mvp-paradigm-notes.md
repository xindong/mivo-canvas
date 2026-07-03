# Anchor MVP 范式验证纪要(P2-D2)

> 输入 P3-0(投影+交互分发契约)与 P4 schema spike(CanvasAnchor/Version 演进)。
> 基线:P2-D2 DOM 闭环 + e2e(mock 上游)。范围:只验证「点/框 + 指令 → 生成 → 可追踪」这一条范式。
> 实现见 `src/canvas/AnchorOverlay.tsx` + e2e `scripts/e2e-smoke.mjs`「P2-D2」段。

## 1. 锚点粒度:point vs box 哪个更贴近美术表达?

**实测观察**:D2 同时实现了 point(节点中心点)与 box(节点 50% 区域)两种锚点,e2e 用 point 跑通闭环。

- **point** 适合「对整张图下一个指令」的语义(如「把整张图变霓虹风」)——它只携带一个坐标,生成链路走 `generateBesideNode`(旁边生成,不引用区域),结果是一张新图。美术表达:方向性指令,不指定改哪里。
- **box** 适合「改这一块」的语义——它携带矩形几何,生成链路应走 `generateImageEdit('area-edit')`(区域编辑,box→mask)。美术表达:局部指令,指定改哪里。D2 把 box 几何放在 prompt 文本里(范式验证),未接真实 mask;P4 前需决定 box→mask 的映射(box 几何 → 二值 mask?还是模型原生支持 region 指令?)。

**结论给 P3-0/P4**:point 与 box 不是二选一,是两种语义层(整图指令 vs 区域指令)。CanvasAnchor 应保留 `type: 'point' | 'box'`,但 box 的几何到生成输入(mask/region)的映射在 P4 spike 中定。P3-0 投影层只需把 box 的 canvas 坐标投影到屏幕,不参与 mask 语义。

## 2. 指令载体形态:浮层 vs 侧栏?

**实测观察**:D2 用「选中锚点 → 浮层 input + Generate 按钮」(浮层在锚点旁,position:absolute,zIndex:50)。

- **浮层** 优点:指令输入框紧邻锚点,空间关系清晰(美术看着锚点打字)。缺点:锚点在视口边缘时浮层溢出(e2e 里靠 `window.__anchorGenerate` hook 绕开按钮 off-screen 点击——这正是浮层溢出的实证);多锚点时浮层归属需明确(只对选中的那个)。
- **侧栏**(如右侧 AI 面板)优点:不溢出、可容纳更长的指令历史 + 参数。缺点:指令与锚点的空间关联弱(美术要看右边栏 + 画布锚点,注意力分裂)。

**结论给 P3-0/P4**:浮层适合 MVP(单锚点单指令),但溢出问题 + 多锚点归属问题意味着正式版应走「侧栏承载指令文本 + 画布锚点高亮选中态」的混合形态(侧栏是输入区,画布是选中指示器)。P3-0 交互分发模型需定义「锚点选中」作为一等交互态(类似节点选中),浮层/侧栏只是其视图。当前 D2 的 `selectedAnchorId` 是 AnchorOverlay 本地 state + window hook——P4 应上升为 store 态(或 CanvasAnchor 的 selected 字段)。

## 3. 与 mask 的关系:何时该合并?

**实测观察**:D2 的 box 锚点把几何放 prompt 文本(`[anchor box @ x,y wxh]`),**未与现有 mask 编辑流程合并**。现有 mask 流程(ImageCropOverlay / `generateImageEdit('area-edit', {maskBounds})`)是「画 mask → 区域编辑」;box 锚点是「框选 → 挂指令 → 生成」。

- **何时该合并**:当 box 锚点的几何需要作为**真实 mask**送上游(模型按 mask 区域重绘)时,box 锚点应复用 mask 的几何→maskBounds 映射(box canvas 坐标 → 节点相对归一化 0-1 → `CanvasMaskBounds`)。D2 没做这步(范式验证阶段,用 prompt 文本表达几何)。
- **何时不该合并**:point 锚点无几何,不涉及 mask。box 锚点若模型原生支持 region 指令(不靠 mask),也不合并(几何进 prompt 即可)。

**结论给 P3-0/P4**:mask 与 box 锚点在**几何层**应共享(CanvasMaskBounds 是共同的区域表达),但在**语义层**应分离(mask 是「精确像素级区域」,box 锚点是「语义区域 + 指令」)。P4 spike 需决定:box 锚点→mask(像素级)还是 box 锚点→region-prompt(语义级)。D2 的 prompt-文本几何是过渡形态,P4 应替换为正式映射。P3-0 不涉及此(投影只管坐标,不管 mask 语义)。

## 附:D2 实现的诚实说明(给 lead)

- **锚点创建**:通过调试入口(`page.evaluate` 调 `addAnchor` store action)而非画布工具点击/拖框。原因:现有交互控制器(useCanvasInteractionController,1776 行)的工具分发深度集成,加新 tool 成本高 + 风险大;lead 明确允许「box 用调试入口」,D2 把 point 也用调试入口(一致性 + 风险)。P3-0 交互分发模型落地后,锚点创建应改为正式画布工具(点击=point,拖框=box)。
- **e2e 选择锚点 + 生成**:通过 `window.__setSelectedAnchorId` + `window.__anchorGenerate` dev hook(非 mark/button 点击)。原因:mark 是 10px 小元素 + 画布 pointer-down 与 click 竞态 + 浮层 off-screen,Playwright hit-test 不稳定。hook 调用的是同一 React 闭包(经 ref 拿最新 state),验证的是数据流(指令→生成→resultNodeIds→edge→roundtrip),非手势。正式 e2e(P3 后)应改回真实点击(交互分发模型稳定后 hit-test 可靠)。
- **box 几何**:放 prompt 文本,未接真实 mask(见上文 Q3)。
- **pre-existing flaky**:e2e 的 Eagle masonry + Remote debug GET 测试在 D1 也偶发 flaky(2 条记录 / 文本渲染竞态),非 D2 引入;D2 通过 `hasAnchors` selector 门控 AnchorOverlay 挂载(无锚点时零负载) + 杀残留进程 + 清 debug-logs 缓解,但偶发仍需重跑。
