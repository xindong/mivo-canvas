# P4 Schema Spike 纪要(CanvasAnchor / Version / 投影)

> **范围**:P2 期间并行项,不占 PR 序列,纯文档(不改代码)。本纪要是 **P3-0 投影契约的显式前置门禁**——没有它 P3-0 没法冻结 renderer contract(roadmap §4)。
> **输入**:①`src/types/mivoCanvas.ts` V2 语义字段 + `src/model/documentModelV2.ts` 归一逻辑;②PR #29 `experimentalAnchors`(types + `src/model/anchorModel.ts`,commit c40a017);③roadmap §9 议题清单。
> **基线**:`origin/main` = `b34e7be`(含 PR #29)。
> **边界**:只做 spike + 设计冻结,不做正式 schema 实现(那是 P4-a);组 D 的 D2 范式纪要未出,§6 留占位。

## 0. 输入摘要(读过什么)

| 输入 | 关键事实 |
|------|---------|
| `types/mivoCanvas.ts:228-242` | `ExperimentalAnchor = {id, type:'point'\|'box', targetNodeId, x, y, instruction, createdAt, width?, height?, resultNodeIds?}`;`MivoCanvasNode.experimentalAnchors?: ExperimentalAnchor[]`(L315);注释明确 **canvas 坐标系**(x/y 相对画布,非节点) |
| `model/anchorModel.ts` | 纯函数(createAnchorId/normalizeAnchors/createAnchor/addAnchorToNode/updateAnchorInstruction/removeAnchorFromNode/recordAnchorResultOnNode),无 store 依赖;`normalizeAnchors` 做 validate + 深拷贝 + 丢弃坏 anchor |
| `store/canvasStore.ts:291-294` | store action 签名:`addAnchor(nodeId, input)`/`updateAnchorInstruction(nodeId, anchorId, ...)`/`removeAnchor(nodeId, anchorId)`/`recordAnchorResult(nodeId, anchorId, resultNodeIds)` —— **anchor 宿主 = nodeId,targetNodeId 在 input 里,二者可不同** |
| `store/nodeFactory.ts:52` | `cloneNode` 经 `normalizeAnchors(node.experimentalAnchors, true)` 深拷贝 —— clipboard/history/persist 不共享引用 |
| `lib/snapshotValidation.ts:135-153,228` | 导入路径轻校验:坏 anchor **整体拒绝快照**(非丢弃);`isCanvasNode` 末尾 `(experimentalAnchors === undefined \|\| isExperimentalAnchorArray)` |
| `model/canvasSnapshotModel.ts` | `normalizeCanvasSnapshotV2` 不专门处理 anchor(走 `normalizeCanvasNodeV2`);`MivoCanvasSnapshot.version=2`,无独立 anchors 顶层字段 |
| `model/documentModelV2.ts` | 归一逻辑:`transformForNode` 从 `node.transform` 或 legacy `x/y/w/h` 算 transform;fills/strokes/asset/relations 从 legacy 或 V2 字段归一;**未触及 experimentalAnchors**(透传) |
| `canvas/canvasRenderAdapter.ts` | P3-0 起点:从 `MivoCanvasNode` 算 `NodeRenderBox`/`FrameRenderStyle`/`MarkupRenderStyle`/`textRenderStyleFor` —— **直接读 node,未固化为投影类型** |

---

## 1. CanvasAnchor 正式化设计

### 1.1 字段映射与迁移规则(experimentalAnchors → CanvasAnchor)

| ExperimentalAnchor 字段 | CanvasAnchor 正式化 | 说明 |
|------------------------|---------------------|------|
| `id` | 保留(`anchor-<uuid>`) | `createAnchorId` 已稳定 |
| `type` | 保留 `'point'\|'box'` | 不扩,后续 region/polygon 走 P4-a 再加 |
| `targetNodeId` | **重命名 + 语义澄清**:→ `targetNodeRef: {kind:'node', id}` | 现状 owner(nodeId)与 target 可不同(store action `addAnchor(nodeId, input)`),正式化应**收束为 owner=target**(anchor 宿主即被锚定的节点);若需"锚定到画布自由点"加 `kind:'canvas'`。见 §1.2 |
| `x, y` | **改坐标系**:canvas → target-node-relative(见 §1.2) | 一次性迁移:formalize 时在 `normalizeCanvasNodeV2` 里减去 target 节点 transform.x/y |
| `width?, height?` | 保留(box 必填,point 禁填) | 不变 |
| `instruction` | 保留 string | 指令载体(见 §1.3);P4-a 不升级为结构化,保持 YAGNI |
| `createdAt` | 保留 | |
| `resultNodeIds?` | 保留,定位为**非规范化索引** | 绑定图真相源是 `CanvasEdge`(见 §1.3),此字段仅做快速反查 |

**收编 / 清除判定条件**(roadmap §7 组 D / §9 P4-a):

- **收编为 CanvasAnchor** 当且仅当:① 组 D2 e2e 通过(范式"点/框 + 指令 → 生成 → 可追踪"成立);② 产品侧确认锚点范式不返工。收编动作:rename type、改坐标系(§1.2)、bump persist 版本(v8→v9,迁移器把 canvas-coord 转 node-relative)、`experimentalAnchors` 字段名改 `anchors`、`anchorModel.ts` 模块名保留但内部重命名。
- **清除** 当且仅当:范式返工或产品侧放弃。清除动作:删 `experimentalAnchors` 字段 + `anchorModel.ts` + 4 个 store action + `snapshotValidation.ts` 的 anchor 校验位。**无需 persist 迁移**(字段 optional,老快照无它仍合法)。
- **当前阶段(P2)**:字段已标注 EXPERIMENTAL(types 注释 + anchorModel 顶部),不动 persist 版本,代码标注实验;无论收编还是清除,向后兼容。

### 1.2 坐标锚定模型(canvas 坐标 vs 节点相对坐标)

- **现状(MVP)**:canvas 坐标(`x/y` 相对画布)。注释(types L223)与 `anchorModel.validateAnchor` 都按 canvas 坐标校验。
- **语义评估**:产品愿景是"图和锚点是用户的语言"——锚点应在图上,**节点移动时锚点必须跟随**。canvas 坐标下,移动节点不会移动锚点(语义 bug);MVP 阶段靠 `updateSelectedNodesPosition`(canvasStore:1346)在拖拽时手动同步 anchor.x/y,但这只覆盖"拖 anchor 节点"路径,不覆盖"拖 target 节点"路径。
- **建议正式化采用 target-node-relative**:锚点坐标存为相对 target 节点 transform 的 `(nx, ny)`(+ box 的 `nw, nh`)。投影层(P3-0)用 `targetNode.transform` 把 `(nx, ny)` 转回 canvas 坐标供渲染。收益:① 节点移动锚点自动跟随(语义自洽);② 持久化体积不涨;③ 与"anchor 宿主=target"的收束一致。
- **迁移成本**:一次性,在 `normalizeCanvasNodeV2` 里 `anchor.x -= targetNode.transform.x`(+y)。已有 snapshotValidation 可守门。
- **开放问题(留 D2 纪要 / P4-a)**:① target 节点有 rotation 时,box anchor 是否随 rotation 旋转?(MVP 图片节点无 rotation,可暂不处理,但正式化要表态)② owner ≠ target 的存量数据是否存在(需 grep 快照);若存在,收束为 owner=target 时如何处理(归并 or 拒绝)。

### 1.3 绑定图引用与指令载体

- **绑定图**:anchor 与三者的关系——target 节点(targetNodeRef)、结果节点(resultNodeIds)、target→result 的生成关系。现状:`CanvasEdge {from, to, type:'generate'\|'edit', prompt, createdAt}` 已表达 target→result;`anchor.resultNodeIds` 是冗余索引。
- **建议**:**绑定图真相源 = CanvasEdge**;anchor 只保留 `targetNodeRef` + `resultNodeIds`(非规范化索引,供 UI 快速反查,可由 edges 重建)。不要把 anchor 本身做成 edge 类型——anchor 是节点级指令载体,edge 是节点间关系,职责不同。
- **指令载体**:`instruction: string`。投影层把它透传给生成 facade(generationSlice)。正式化不升级为结构化(prompt+params)——YAGNI,等 P4-e L2 上移时若 agent 编排需要再扩。
- **与 mask 的关系**(组 D2 纪要的输入,这里只给 spike 视角):box anchor 的 `(x,y,w,h)` 与 `CanvasMaskBounds` 几何同形。生成时 box anchor 可直接转 mask bounds(减去 target 节点 transform 后归一化到 [0,1] 区间,即 `ImageCrop` 语义)。建议 P4-a 投影层提供 `boxAnchorToMaskBounds(anchor, targetNode)` 纯函数,不走 anchorModel 的 mutation 路径。

---

## 2. Version 粒度

### 2.1 全量快照 vs 增量取舍矩阵

| 维度 | 全量快照 | 增量(delta/command) | 混合(基线快照 + 增量) |
|------|---------|---------------------|----------------------|
| 存储成本 | O(N)/版本,N=节点数;千节点×百版本~MB 级 | O(1)/版本(命令记录);总量~O(版本数) | 基线 O(N) 每 K 版一次 + 增量 O(1),总量 ~O(N + 版本数/K) |
| 回溯速度 | O(1) 直接反序列化 | O(K) replay 命令链(K=距基线距离) | O(K') K'≤K,基线后 replay |
| 实现复杂度 | **低**(canvasStore 60 条快照式 undo 已落地) | 高(需 command 类型体系 + replay + 基线管理) | 中(全量基线复用现成快照逻辑 + 增量命令记录) |
| 冲突合并 | LWW 整体替换,粗 | 可细粒度(command 级)合并,但 CRDT/OT 不在范围(§10.1) | 同增量;冲突仍 LWW |
| 适用场景 | 单人/小~中画布 | 大画布、长历史、多人 | 中~大画布、跨会话回溯 |

### 2.2 与 D7(本地 undo 60 条)的边界

- **本地 undo(D7)**:快照式 60 条,**会话内编辑历史**,易失,不服务端持久化。保持现状不重写(D7 决策)。
- **服务端 Version**:跨会话/跨设备版本日志,持久化,可回溯任意历史点。**两者不共用存储**(D7 明确)。
- **建议服务端 Version 采用"混合"**:每 K 个版本或时间窗 T 落一次全量基线快照(复用 `getSnapshot`/`normalizeCanvasSnapshotV2`),中间记录增量 delta(command 记录,复用 P0-b 抽出的 `historyManager` 纯函数签名)。回溯时找最近基线 + replay。
- **清理策略**:保留最近 N 个版本 + 基线;老版本压缩为基线。阈值(N/K/T)留 P4-a 实施时定,本轮只给方向。
- **边界结论**:本地 undo 60 条不进服务端;服务端 Version 是独立日志,前端 persist 转"本地缓存 + 服务端真相"(P4-c)后,undo 仍走本地 60 条,Version 走服务端。

---

## 3. P3-0 投影字段清单(P3-0 开工的直接输入)

> **原则**:renderer 只消费 `RenderNode`/`RenderEdge`,不直接读 `MivoCanvasNode`。P3-0 把 `canvasRenderAdapter.ts` 固化为正式投影类型。Anchor 引入时**只改投影函数**,不改 renderer 消费契约。

### 3.1 RenderNode 字段(逐字段)

| 字段组 | 字段 | 来源(投影函数怎么算) |
|--------|------|---------------------|
| identity | `id, type, status, title` | `MivoCanvasNode` 直取 |
| geometry | `x, y, width, height, rotation` | `transformForNode`(`normalizeCanvasNodeV2.transform`) |
| visibility | `hidden, locked, favorited` | 直取 |
| selection | `selected: boolean` | 投影时从 `selectionSlice` 算(不存 node 上) |
| fills | `fills: CanvasNodeFill[]` | `fillsForNode`(归一) |
| strokes | `strokes: CanvasNodeStroke[]` | `strokesForNode` |
| effects | `effects?: CanvasNodeEffect[]` | 直取 + clone |
| text | `text?, fontSize?, textColor?, fontWeight?, textAlign?, textAutoWidth?, markdownDisplayMode?` | 直取 |
| markup | `markupKind?, markupBrushKind?, markupStampKind?, markupPoints?, markupStrokeColor?, markupFillColor?, markupStrokeWidth?, markupStrokeStyle?, markupOpacity?, markupStartArrow?, markupEndArrow?, markupCornerRadius?` | 直取 |
| section/frame | `frameColor?, sectionId?, sectionFillColor?, sectionBorderColor?, sectionBorderWidth?, sectionBorderStyle?, sectionTitleVisible?, sectionLockMode?, sectionTemplateId?` | 直取 |
| asset | `assetUrl?, assetMimeType?, assetOriginalName?, assetSizeBytes?, imageHasTransparency?, imageCrop?` | 直取 + `assetForNode` |
| relations | `parentIds?, groupId?, sourceNodeId?, targetNodeId?, connectorStart?, connectorEnd?, sectionId?` | `relationsForNode` |
| generation | `generation?` | 直取 |
| aiWorkflow | `aiWorkflow?` | 直取 |
| **anchors(新)** | `anchors?: RenderAnchor[]` | `experimentalAnchors` → 投影(见 3.2) |

### 3.2 RenderAnchor(新增,投影层产物)

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | anchor id |
| `type` | `'point' \| 'box'` | |
| `targetNodeId` | string | 绑定目标(正式化后 → targetNodeRef) |
| `x, y` | number | **渲染坐标**(投影层把 node-relative 转 canvas;MVP 阶段 experimentalAnchors 已是 canvas,直接透传) |
| `width?, height?` | number | box 必填 |
| `instruction` | string | 透传给生成 facade |
| `resultNodeIds?` | string[] | 绑定图结果引用(UI 高亮/反查) |
| `screenX?, screenY?` | number?(可选) | 投影层算好的屏幕坐标,供 DOM overlay(mvp 在 DOM 上画 anchor marker) |

### 3.3 RenderEdge

| 字段 | 类型 | 说明 |
|------|------|------|
| `id, from, to, type, prompt, createdAt` | 同 `CanvasEdge` | 直取 + clone |

### 3.4 为何 Anchor 引入只改投影层

- **今天(P2)**:`canvasRenderAdapter.ts` 从 `MivoCanvasNode` 算样式;`CanvasNodeView`(830 行)直接读 node。P3-0 把这层固化为 `RenderNode` 类型,renderer 只消费 `RenderNode`。
- **关键**:P3-0 投影层**现在就暴露 `anchors?: RenderAnchor[]` 字段**(哪怕是 experimental 投影),renderer 今天就不直接读 `experimentalAnchors`。
- **P4-a CanvasAnchor 正式化时**:投影函数从 `(node) => RenderNode` 改为读取正式 `anchors`(node-relative 坐标 → 投影转 canvas)。`RenderNode.anchors` 类型从 experimental 投影改为 formal 投影(可能加绑定图字段)。**renderer 的消费契约(画 anchor marker + 连线到 result)不变**。
- **若 P3-0 不暴露 anchors 字段**:renderer 会直接读 `node.experimentalAnchors`,P4-a 改坐标系/字段名时必须动 renderer——违背"投影层隔离"承诺(SC6.1)。

---

## 4. chat history 是否随 canvas 服务端化

**结论**:**随 canvas 服务端化,但作为独立集合,不嵌入 canvas 文档主体**。

**理由**:
- `chatStore` 是独立 store(persist `mivo-chat-demo` v2),与 canvas 文档(persist `mivo-canvas-demo` v8)分离。两者职责不同:chat 是"操作日志/对话上下文",canvas 是"产出物"。
- 嵌入 chat 进 canvas 文档会让文档体积膨胀 + 跨设备冲突面变大(LWW 粒度变粗)。
- 但 chat 也不应永驻前端(跨设备丢上下文)。所以:chat history 服务端化,作为独立"会话日志"集合(按 `canvasId` 索引),不入 canvas 文档主体。
- **边界**:canvas 文档持久化(P4-c)先做;chat history 服务端化作为 P4-c 从属项或 P4-e,不阻塞 Anchor/Version。本轮 spike 只给结论,不细化 schema。

---

## 5. mivoserver 映射边界

**本机未找到 mivoserver 仓库**(已尝试:`ls ~/AI-Agent/*/`、`find ~ -maxdepth 5 -iname "*mivoserver*"`,0 命中)。**不编造映射表**。

**开放问题(需 lead / 用户协助)**:
- **需要的访问方式**:① mivoserver 仓库路径(本地 clone 或 GitHub URL);② board 域 schema(FastAPI 模型定义 / OpenAPI spec / Mongo 集合 schema);③ 任务/存储/鉴权三域边界(P4-e L2 上移需要)。
- **需要的字段对照**(拿到访问后补):MivoCanvas 文档模型(`Canvas/Node/Anchor/Edge/Version`)↔ mivoserver board 域(`board/section/asset/task/?`)。在没有 schema 的情况下,P4-e(L2 上移 + mivoserver 切换)无法细化映射表,只能列占位。
- **风险**(roadmap §11):"mivoserver 契约反推翻 BFF/Anchor 设计"——缓解=P2/P3 只读 spike 提前摸底。本轮 spike 因无访问,摸底未完成,留 P4-a 前置项。

---

## 6. 待 D2 纪要合入后修订(占位)

组 D 的 **D2 范式纪要**(roadmap §7 组 D:D2 DOM 闭环 + e2e,产出"锚点粒度/指令载体形态/与 mask 的关系"范式验证纪要)尚未合入。本 spike 的以下结论待 D2 纪要合入后修订:

- §1.2 坐标锚定模型的"节点移动锚点跟随"语义(需 D2 实测确认用户预期);
- §1.3 box anchor → mask bounds 的转换函数设计(需 D2 确认与 mask 编辑的合并语义);
- §3.2 `RenderAnchor.screenX/Y` 是否必要(取决于 D2 的 DOM overlay 形态)。

D2 纪要合入后,本文件 §1.2 / §1.3 / §3.2 相关条目应同步修订并标记版本。
