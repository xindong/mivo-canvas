# Record Schema 定稿(T1.2a)

> 状态:**已裁决(2026-07-10),裁决记录见各节**(DP-1/DP-2/tasks/status/矛盾1 均已拍,见 §4.1/§4.2/§4.3/§2.1/§6/§8)。
> 日期:2026-07-10。
> 范围:架构迁移 P1 的设计前置——为 T1.2 内核收口(document→DocKernel/session→SessionStore、records 扁平化、per-record revision)提供逐字段 schema 权威文档,同时定 CRDT(Yjs)映射策略。后续"成功定义 6"(plan §0)以此文档为验收依据。
> 上游真相源:`docs/decisions/platform-architecture-2026-07-07.md`(§6/§13)、`docs/plan/arch-migration-execution-plan.md`(§3 DP-1/DP-2/DP-6、§4 T1.2a 行)。
> 源码事实源:`src/types/mivoCanvas.ts`、`src/types/generation.ts`、`src/model/documentModelV2.ts`、`src/model/anchorModel.ts`、`src/store/canvasDocumentModel.ts`、`src/store/chatStore.ts`。字段清单逐个抄核自源码,无"其余字段同上"。
>
> **冲突合并语义术语**:LWW=last-write-wins(按 revision/timestamp 取后者);序列=保序集合,插入/删除按 id+op 合并(Yjs Y.Array 语义);不可变=字段一旦设定不参与合并(只在 record 创建时写)。record 级合并=每节点独立 record 带 revision,服务端按节点粒度 merge,同节点才冲突(platform §13.5、A2)。

---

## 0. 汇总表(验收清点用)

**MivoCanvasNode 顶层字段总数:64**(抄核自 `src/types/mivoCanvas.ts:252-340`)。

| 归属类别 | 计数 | 字段(简) |
|---|---|---|
| DocKernel record 字段(canonical,存) | 40 | id, type, title; transform; fills, strokes, effects, layout, constraints; asset; relations; text, fontSize, textColor, fontWeight, textAlign, textAutoWidth; markupKind, markupBrushKind, markupStampKind, markupPoints, markupStartArrow, markupEndArrow, markupCornerRadius; sectionTitleVisible, sectionLockMode, sectionTemplateId; markdownDisplayMode; imageHasTransparency, assetSourceDimensions, imageCrop; sourceNodeId, groupId, locked, hidden, favorited; generation; aiWorkflow; experimentalAnchors; annotationBounds |
| 派生不存(镜像/运行态派生,加载时重算) | 24 | x, y, width, height(←transform); assetUrl, assetMimeType, assetOriginalName, assetSizeBytes(←asset); sectionFillColor, sectionBorderColor, sectionBorderWidth, sectionBorderStyle, frameColor(←fills/strokes); markupFillColor, markupStrokeColor, markupStrokeWidth, markupStrokeStyle, markupOpacity(←fills/strokes); parentIds, sectionId, targetNodeId, connectorStart, connectorEnd(←relations); status(派生自 tasks,record 不存,降级 session,§2.1) |
| 丢弃(运行时/UI,不持久化) | 0 | MivoCanvasNode 无纯运行时字段;运行时态在 session/tasks 域 |

> 注(已裁决 2026-07-10):纯图关系字段(parentIds/sectionId/targetNodeId/connectorStart/connectorEnd)canonical 统一归 relations 嵌套 Y.Map,顶层 flat 全降 D;`aiWorkflow` canonical 留顶层(K),`relations.aiWorkflow` 迁移后移除(不再镜像)——单一家园,无两个方向的 canonical。`status` 降级 session 派生(record 不存,入 D,§2.1)。故 **K=40/D=24/×=0**。

**CanvasDocument 顶层字段:9**(title, sourceTemplateId, projectId, createdAt, updatedAt, nodes, edges, tasks, selectedNodeId/Ids)。详见 §4。
**ChatMessage 字段:17**(见 §5,DP-6 预留,不展开到字段级,指向 T1.3)。

---

## 1. scope 分层与映射策略(据 platform §13.1/§13.2/§13.5)

四层 scope(按"数据的命运"分类,非按模块):

| scope | 内容 | 同步策略 | CRDT? |
|---|---|---|---|
| **document** | nodes/edges/anchors/画布与项目结构;chat 消息(per-canvas collection) | 服务端真相 + **节点级合并**(每 record 带 revision,同节点才冲突) | ✅ 字段级改造与此同向 |
| **user**(session) | 相机 per 画布、最近打开、工具偏好、面板开合、**选择态**(DP-1)、聊天草稿 | 跨设备同步、按人隔离:简单 KV + LWW | ❌ 不进 CRDT |
| **asset** | 图片内容(内容寻址) | 服务端化(T1.5) | ❌ |
| **编排/session** | 运行时:正在跑的 tasks、generation 进度、focus/编辑态 | 不过网(服务端只接 records + assetId + user-state KV) | ❌ |

**DocKernel 映射(platform §13.2 + §6)**:`canvasStore documentSlice + documentModelV2 → DocKernel`(唯一文档真相源)。records 扁平化:**独立 id + 字段级属性,可无损映射 Y.Map/Y.Array 的形状**(每节点独立 id、属性扁平、无嵌套大 JSON)。spike 验收=现有 Doc 无损映射 Y.Map/Y.Array(platform §6 owner 修正)。

**CRDT 映射规则(本文件定)**:
- 每个节点 = 一个 **Y.Map**(key=字段名,value=叶子或子结构)。
- 有序集合(fills/strokes/effects/markupPoints/experimentalAnchors/sourceNodeIds/resultNodeIds/parentIds)= **Y.Array<Y.Map>**(元素各带稳定 id,增删按 id 合并,保序)。
- 纯标量叶子(number/string/boolean/enum)= **Y.Map 的叶子 key**,LWW(Yjs 默认)。
- 子结构对象(transform/asset/relations/generation/aiWorkflow/annotationBounds/layout/constraints)= **嵌套 Y.Map**(平台 §6 要求"无嵌套大 JSON"指不要整 blob,但字段级 Y.Map 嵌套是允许且推荐的——每个叶子仍独立可合并)。
- `id`/`type` = **不可变**(创建后不参与合并,避免 id 漂移导致 record 身份混乱)。
- `revision` = **每 record 一个**(platform §13.5 硬约束,spike 阶段就要有,不是 P4c 才加),LWW 用其做 tie-break。

---

## 2. MivoCanvasNode 顶层字段逐个(schema 决策)

> 类型抄核自 `src/types/mivoCanvas.ts:252-340`。归属:K=DocKernel record 字段;D=派生不存(镜像,加载时由 canonical 重算);×=丢弃。CRDT:M=Y.Map 叶子/A=Y.Array/嵌M=嵌套 Y.Map/不可变。冲突:LWW/序列/不可变。

### 2.1 身份与类型(不可变 / canonical)

| 字段 | 类型 | 语义 | 归属 | CRDT | 冲突 |
|---|---|---|---|---|---|
| id | string | 节点稳定 id(createNode 时分配) | K | Y.Map 叶子 | **不可变** |
| type | CanvasNodeType | 节点类型(image/text/frame/annotation/markup/markdown/pdf/video/ai-slot/task-placeholder) | K | Y.Map 叶子 | **不可变**(改 type = 删旧建新) |
| title | string | 节点标题 | K | Y.Map 叶子 | LWW |
| status | NodeStatus | 'ready'\|'generating'\|'failed'\|'queued' | **D**(record 不存;session 派生自 tasks) | — | —(不持久化,不合并) |

> `status`(已裁决 2026-07-10):record 内不存,降级 session 派生。理由:last-known 缓存 = 第二真相源,split-brain 风险。**派生规则**:task 存在→随 task 状态;task 不存在→节点有 asset 视为 ready、无 asset 视为 failed。当前源码 MivoCanvasNode 内仍持久化(过渡),迁移后移除(record 内不存)。影响 §7 canvasActionModel #168 的 status 读取断言(须同步迁移:status 改从 tasks 派生)。

### 2.2 几何

| 字段 | 类型 | 语义 | 归属 | CRDT | 冲突 |
|---|---|---|---|---|---|
| transform | CanvasNodeTransform{x,y,width,height,rotation} | canonical 几何(含 rotation) | K | 嵌M(5 叶子) | LWW(逐叶子) |
| x,y,width,height | number | **镜像** transform 同名字段(documentModelV2 `transformForNode` 重算) | D | — | — |

> documentModelV2 `withLegacyGeometry` 强制 x/y/w/h == transform.x/y/w/h(L171-178, L62-68)。迁移:transform 为 canonical,x/y/w/h 派生不存(加载时回填,兼容旧客户端读)。

### 2.3 视觉嵌套结构(canonical,详见 §3)

| 字段 | 类型 | 归属 | CRDT |
|---|---|---|---|
| fills | CanvasNodeFill[](solid\|image) | K | **A**(Y.Array<Y.Map>,元素按 id) |
| strokes | CanvasNodeStroke[] | K | **A** |
| effects | CanvasNodeEffect[](shadow\|blur) | K | **A** |
| layout | CanvasNodeLayout{mode,direction,gap,padding} | K | 嵌M(padding 亦嵌M) |
| constraints | CanvasNodeConstraints{horizontal,vertical} | K | 嵌M |

### 2.4 资产

| 字段 | 类型 | 语义 | 归属 | CRDT |
|---|---|---|---|---|
| asset | CanvasNodeAssetRef{url,mimeType,originalName,sizeBytes} | canonical 资产引用 | K | 嵌M |
| assetUrl, assetMimeType, assetOriginalName, assetSizeBytes | string\|number | **镜像** asset(`assetForNode` L70-80 重算) | D | — |

> 迁移后 asset 为 canonical(asset.url → T1.5 后改为 assetId 引用),四个 flat 字段派生不存。**注意(已确认 2026-07-10)**:`asset` 当前是 url 字符串,非内容寻址 id;T1.5 资产服务端化后改为 `assetId`(内容寻址),旧 url 作过渡兼容。维持现 K+过渡注记写法,T1.5 切换(详见 §6 矛盾 3)。

### 2.5 关系

| 字段 | 类型 | 语义 | 归属 | CRDT |
|---|---|---|---|---|
| relations | CanvasNodeRelations(迁移后:{parentIds?,sectionId?,targetNodeId?,connectorStart?,connectorEnd?};aiWorkflow 移出归顶层) | canonical 关系聚合(纯图关系字段家园) | K | 嵌M(parentIds=A) |
| parentIds | string[] | 顶层 flat,canonical=relations.parentIds(`relationsForNode` L161) | D | — |
| sectionId | string | 顶层 flat,canonical=relations.sectionId(裁决:纯图关系字段归 relations) | D | — |
| targetNodeId | string | 顶层 flat,canonical=relations.targetNodeId | D | — |
| connectorStart, connectorEnd | ConnectorBinding{nodeId,anchor,offset?} | 顶层 flat,canonical=relations.connectorStart/End | D | — |
| aiWorkflow(in relations) | — | **迁移后移除**(canonical 留顶层 aiWorkflow,§2.9,不再镜像) | ×(移除) | — |

> documentModelV2 `relationsForNode`(L157-169)从 parentIds/sectionId/targetNodeId/connectorStart/connectorEnd/aiWorkflow 合成 relations。**已裁决(矛盾 1,2026-07-10)**:纯图关系字段(parentIds/sectionId/targetNodeId/connectorStart/connectorEnd)canonical 统一归 relations 嵌套,顶层 flat 全降 D;aiWorkflow canonical 留顶层,relations.aiWorkflow 迁移后移除。单一家园,不再双写。

### 2.6 文本

| 字段 | 类型 | 归属 | CRDT | 冲突 |
|---|---|---|---|---|
| text | string | K | Y.Map 叶子 | LWW |
| fontSize | number | K | 叶子 | LWW |
| textColor | string | K | 叶子 | LWW |
| fontWeight | number | K | 叶子 | LWW |
| textAlign | 'left'\|'center'\|'right' | K | 叶子 | LWW |
| textAutoWidth | boolean | K | 叶子 | LWW |

### 2.7 标注/笔迹(canonical 部分)

| 字段 | 类型 | 归属 | CRDT | 冲突 |
|---|---|---|---|---|
| markupKind | MarkupKind | K | 叶子 | 不可变(创建后定) |
| markupBrushKind | MarkupBrushKind | K | 叶子 | LWW |
| markupStampKind | CanvasStampKind | K | 叶子 | LWW |
| markupPoints | MarkupPoint[]{x,y,pressure?} | K | **A**(Y.Array<Y.Map>,笔迹点序列,按顺序合并) | 序列 |
| markupStartArrow | boolean | K | 叶子 | LWW |
| markupEndArrow | boolean | K | 叶子 | LWW |
| markupCornerRadius | number | K | 叶子 | LWW |
| markupFillColor | string | **D**(镜像 fills,`fillsForNode` L110-120) | — | — |
| markupStrokeColor | string | **D**(镜像 strokes,`strokesForNode` L141) | — | — |
| markupStrokeWidth | number | **D**(镜像 strokes) | — | — |
| markupStrokeStyle | MarkupStrokeStyle | **D**(镜像 strokes) | — | — |
| markupOpacity | number | **D**(镜像 fills/strokes opacity) | — | — |

### 2.8 框/Section

| 字段 | 类型 | 归属 | CRDT | 冲突 |
|---|---|---|---|---|
| sectionId | string | **D**(顶层 flat,canonical=relations.sectionId,见 §2.5) | — | — |
| sectionTitleVisible | boolean | K | 叶子 | LWW |
| sectionLockMode | SectionLockMode('all'\|'background') | K | 叶子 | LWW |
| sectionTemplateId | string | K | 叶子 | LWW |
| sectionFillColor | string | **D**(镜像 fills,`fillsForNode` L98-108) | — | — |
| sectionBorderColor | string | **D**(镜像 strokes,`strokesForNode` L128) | — | — |
| sectionBorderWidth | number | **D**(镜像 strokes) | — | — |
| sectionBorderStyle | SectionBorderStyle | **D**(镜像 strokes) | — | — |
| frameColor | string | **D**(镜像 strokes,L132) | — | — |

### 2.9 生成/AI

| 字段 | 类型 | 语义 | 归属 | CRDT |
|---|---|---|---|---|
| generation | {prompt,model,size?,seed?,strength?,taskId?,createdAt?,maskBounds?,maskSourceSize?} | 已提交生成的参数快照(成功出图后落) | K | 嵌M(maskBounds/maskSourceSize 嵌M) |
| aiWorkflow | CanvasAiWorkflow | canonical AI 工作流(顶层;relations.aiWorkflow 迁移后移除,不再镜像) | K | 嵌M(sourceNodeIds=A) |
| sourceNodeId | string | 本节点由哪个节点生成(生成链路) | K | 叶子 | LWW |

### 2.10 其它持久化

| 字段 | 类型 | 归属 | CRDT | 冲突 |
|---|---|---|---|---|
| markdownDisplayMode | MarkdownDisplayMode | K | 叶子 | LWW |
| imageHasTransparency | boolean | K | 叶子 | LWW |
| assetSourceDimensions | ImageDimensions{width,height} | K | 嵌M | LWW |
| imageCrop | ImageCrop{x,y,width,height} | K | 嵌M | LWW |
| groupId | string | K | 叶子 | LWW |
| locked | boolean | K | 叶子 | LWW |
| hidden | boolean | K | 叶子 | LWW |
| favorited | boolean | K | 叶子 | LWW |

### 2.11 实验性(anchor / annotation,DP-2)

| 字段 | 类型 | 语义 | 归属 | CRDT |
|---|---|---|---|---|
| experimentalAnchors | ExperimentalAnchor[] | P2-D1 实验锚点(anchorModel 验证/normalize) | **K**(已裁决收编为顶层 Anchor record,§4.2) | A(node-embedded 过渡;收编后升独立 record) |
| annotationBounds | CanvasMaskBounds | P2-C2 实验标注 area-edit 区 | **K**(已裁决收编为 annotation 节点 formal 子字段,§4.2) | 嵌M |

---

## 3. 嵌套结构 CRDT 映射细化(T1.2a 行点名项)

### 3.1 transform(CanvasNodeTransform)
Y.Map 5 叶子(x/y/width/height/rotation,均 number,LWW)。`rotation` 默认 0(documentModelV2 `defaultRotation`)。无嵌套大 JSON。✅ 无损映射。

### 3.2 fills(CanvasNodeFill[] = solid | image,判别联合)
**Y.Array<Y.Map>**。每元素带稳定 `id`(documentModelV2 合成 `${node.id}-image-fill`/`-section-fill`/`-markup-fill`),kind 判别。solid 子字段(id/kind/color/opacity/visible),image 子字段(id/kind/assetUrl/opacity/visible/scaleMode)。`kind` 不可变(改 kind = 替换元素);其余 LWW。`assetUrl`(image fill)→ T1.5 后改 assetId。✅ 无损映射。

### 3.3 strokes(CanvasNodeStroke[])
**Y.Array<Y.Map>**,元素按 `id`,子字段(id/color/width/style/opacity/visible)全 LWW。✅

### 3.4 effects(CanvasNodeEffect[] = shadow | blur)
**Y.Array<Y.Map>**,元素按 `id`,kind 判别不可变。shadow(color/x/y/blur/spread/opacity/visible)、blur(radius/visible)子字段 LWW。✅

### 3.5 asset(CanvasNodeAssetRef)
嵌套 Y.Map 4 叶子(url/mimeType/originalName/sizeBytes)。"无嵌套大 JSON" 约束满足(4 标量)。T1.5 后 url → assetId。✅

### 3.6 relations(CanvasNodeRelations)
嵌套 Y.Map。parentIds = **Y.Array<string>**(序列合并,按 nodeId)。sectionId/targetNodeId = 叶子 LWW。connectorStart/End = 嵌套 Y.Map(nodeId/anchor/offset?)。**aiWorkflow 不在 relations**(裁决:canonical 留顶层 aiWorkflow,§3.8;relations.aiWorkflow 迁移后移除)。✅

### 3.7 generation(node.inline type, mivoCanvas.ts:313-327)
嵌套 Y.Map。prompt/model LWW;size/seed/strength LWW;taskId LWW(指向 tasks registry);createdAt 不可变;maskBounds/maskSourceSize 嵌套 Y.Map(4/2 标量)。`maskSourceSize` 注释明确"可选+向后兼容,缺失时检测器跳过历史洞区"——迁移时作 optional 叶子,不 bump persist version。✅

### 3.8 aiWorkflow(CanvasAiWorkflow, mivoCanvas.ts:112-132)
嵌套 Y.Map。kind 不可变;status/operation LWW;prompt LWW;sourceNodeIds = **Y.Array<string>**;anchorNodeId/annotationNodeId/slotId 叶子 LWW;placement LWW;createdAt 不可变;progress/stage/startedAt LWW(F5 服务端轮询 patch);**elapsedSec 派生不存**(注释明确 "derived elapsed seconds, patched each poll so render stays pure"——runtime,不入 record)。✅

### 3.9 experimentalAnchors(ExperimentalAnchor[], DP-2 已裁决:收编)
**Y.Array<Y.Map>**。元素按 `id`(anchorModel `createAnchorId`),type(point|box)不可变。子字段(targetNodeId/x/y/instruction/createdAt/width?/height?/resultNodeIds?)。resultNodeIds = Y.Array<string>。anchorModel.ts `validateAnchor` 白名单字段 + box 强制 width/height。**已裁决(§4.2,2026-07-10)**:收编为顶层 `Anchor` record(document 域,独立 id+revision)——本节 Y.Array<Y.Map> 映射是 node-embedded 过渡形态,收编后 anchor 升为独立 DocKernel record(每 anchor 一 Y.Map,独立 revision,与 nodes/edges 并列)。详见 §4.2。✅

### 3.10 annotationBounds(CanvasMaskBounds, DP-2 已裁决:收编)
嵌套 Y.Map 4 叶子(x/y/width/height)。canvas-coordinate(相对画布,非节点)。**已裁决(§4.2,2026-07-10)**:收编为 annotation 节点 formal 子字段(非独立 record)。详见 §4.2。✅

---

## 4. CanvasDocument 层(tasks / selection 归属 + DP-1/DP-2)

> 源码:`src/types/mivoCanvas.ts:432-445`(CanvasDocument)、`src/store/canvasDocumentModel.ts`(compactDocumentForPersist L93、selectionFrom L110、content-patch 判定 L57/L68)。CanvasDocument 顶层 9 字段:title, sourceTemplateId, projectId, createdAt, updatedAt, nodes[], edges[], tasks[], selectedNodeId/Ids。

### 4.1 DP-1:文档内 selection 归属(已拍板,本文件记录迁移)
plan §3 已拍:**选择态单一真相源归 session、不双写(迁移前实施)**。

| 决策点 | 选项 | 推荐 | 理由 | 影响面 |
|---|---|---|---|---|
| selectedNodeId / selectedNodeIds 归属 | (a) 留 document record (b) 迁 session/user 域 **(c) 丢弃 selection-only 不持久化** | **(b) 迁 session/user 域**(DP-1) | 选择是 per-user per-session 视图态,非文档内容;两用户同改同画布不应互相覆盖对方选区;platform §13.1 user 域"按人隔离简单 KV+LWW" | compactDocumentForPersist(L93)现 clone selectedNodeIds → 迁后删;canvasDocumentModel `selectionFrom`(L110)迁 SessionStore;`content patch` 判定(L57"selection-only 不 bump updatedAt")语义不变但 selection 移出;**影响 §7 projectsSlice #164(画布 CRUD 返 selection)+ canvasActionModel #168(选区 action)** |

> **注(已裁决 2026-07-10)**:CanvasDocument.selectedNodeId/Ids 迁移后从 document record 移除,落 /api/user-state(按 canvasId+userId KV)。旧 persist 快照里的 selection 字段在 v10 本地迁移时迁到 session 存储(T1.2 persist v10 大版本迁移,plan T1.2 行)。**迁移窗口不冻结 selection 读写**——迁移瞬间选区清空可接受,v10 迁移后首次加载 selection 为空属预期降级行为(非 bug)。

### 4.2 DP-2:anchorModel 形式化或删(T1.2a 一并拍)
plan §3:**anchorModel:formal 化或删,T1.2a schema 定稿时一并拍**。源码 `src/model/anchorModel.ts` + `ExperimentalAnchor`(mivoCanvas.ts:236-250)+ `annotationBounds`(mivoCanvas.ts:339)均标 P2-D1/P2-C2 EXPERIMENTAL,迁移规则(roadmap §9 P4-a)"收编为 formal type 或删"。

| 决策点 | 选项 | 推荐 | 理由 | 影响面 |
|---|---|---|---|---|
| experimentalAnchors 去留 | (a) 删字段+anchorModel+actions (b) 收编为顶层 document record `Anchor`(独立 record,像 nodes/edges) **(c) 保留 node-embedded 但 formal 类型** | **(b) 收编为顶层 `Anchor` record**(document scope) | platform §13.1 document scope 明列 "nodes/edges/anchors"——anchor 本就是 document 域概念,应是独立 record(每 anchor 独立 id+revision,节点级合并);node-embedded 的 Y.Array<Y.Map> 虽可映射但 anchor 跨节点查询/协作合并不如独立 record 干净;anchorModel.ts 已是 pure helpers,迁出代价小 | record 多一类(tldraw ShapeUtil 对照,§13.3);anchorModel actions 改写为 record-level;**影响 §7 canvasActionModel #168(anchor action 分发)——须同步迁移表征断言** |
| annotationBounds 去留 | (a) 删 (b) 收编为 annotation 节点的 formal 字段 | **(b) 收编为 annotation 节点 formal 字段**(非独立 record) | annotationBounds 是单节点的 area-edit 区,语义属 annotation 节点本身,非跨节点;作 annotation 类型的 formal 子字段即可 | annotation 节点 schema 加该子字段;BFF maskPng 合成不变(server/lib/maskPng.ts) |

> **已裁决(2026-07-10)**:experimentalAnchors (b) 收编为顶层 `Anchor` record;annotationBounds (b) 收编为 annotation 节点 formal 子字段。**理由**:锚点对话是产品范式核心(MivoCanvas=人↔agent/图(锚点)对话,见 memory project_project_mivocanvas_vision),删除与产品愿景矛盾;platform §13.1 明列 anchors 为 document 域。anchorModel.ts 由 pure helpers 升为 record-level actions。

### 4.3 tasks 归属(新决策点,推荐)
CanvasTask(mivoCanvas.ts:397-413:id/label/status/progress/stage?/nodeIds/preset?)当前在 CanvasDocument.tasks。语义:异步生成任务运行态(进度/状态由 GET /tasks/:id 轮询)。

| 决策点 | 选项 | 推荐 | 理由 | 影响面 |
|---|---|---|---|---|
| tasks 归属 | (a) document record(随画布存) (b) session/asset 域(服务端 tasks registry,FX-2 per-user) **(c) 拆:preset demo 任务留 document、real 任务迁服务端** | **(b) session/asset 域(服务端 tasks registry)** | tasks 是运行态(进度/状态),非文档内容;FX-2 已定"tasks registry per-user 服务端按 user 隔离";FX-3"僵尸 task 卡回落"跨设备复跑须服务端真相;document 只存 nodes/edges/anchors + chat | compactDocumentForPersist(L96 cloneTasks)迁后删 tasks 字段;chatStore `messagesByScene` 内 serverTaskId 引用不变(指向服务端);**影响 §7 chatHydration #167(task 卡 hydrate/settle)+ projectsSlice #164(画布含 tasks seed)** |
| preset demo 任务(`preset:true`,demoScenes 两固定 id) | (a) 仍随画布 seed 存 (b) 迁 demo-seed 机制 | **(a) 随 demo seed 存(不进 document record)** | preset 是 demo 固定 seed(canvasGenerationHydration 跳过),非用户数据;保留 demo seed 路径,不污染 document schema | demoScenes.ts 不动;document record 无 tasks 字段 |

> **已裁决(2026-07-10)**:(b) tasks 迁服务端 tasks registry(FX-2 per-user);preset demo 任务留 demo seed(不进 document record)。document record 无 tasks 字段。

---

## 5. chat 消息归属(DP-6 预留,不展开到字段级,指向 T1.3)

plan §3 DP-6:**chat 随文档域走 `/api/canvas` 子资源(messagesByScene 键随 canvas 生命周期),独立集合存储(D6),级联语义见 FX-7**。

- scope:**document 域,per-actor 私有 collection**(platform §13.1 明列 chat 消息在 document 域;§13.2 chatStore 消息 → document 域独立 collection 走同一 PersistAdapter)。**DP-6R(2026-07-12)**:chat-message envelope.ownerId=**actor**(写入者本人,per-actor 私有),PK=(actor,'chat-message',msgId)——两 actor 可在同 canvas 拥同 msgId;~~per-canvas 独立 collection(随画布分享)~~ 已订正为不随画布分享、成员互不可见。chat-collection 仍 per-canvas under canvas owner(仅 liveness,随 canvas 生命周期级联 FX-7),不含 per-actor 状态。chat 写入/reorder 不 bump 共享 canvas contentVersion;reorder 走 per-actor×canvas 独立 orderRevision(api-surface §4.2.3)。
- 键:`messagesByScene: Record<string, ChatMessage[]>`(chatStore.ts:86),键 = sceneId(= canvasId)。迁移:每 canvas 一条 messages collection,随 canvas 生命周期级联(FX-7 软删语义)。
- ChatMessage(chatStore.ts:65-83)17 字段:id/role/kind?/text/createdAt/status/enhance?/resultNodeIds?/origin?/error?/errorKind?/timeoutRetryKey?/timeoutRetryCount?/selectedNodeId?/selectedNodeType?/generationContext?/retryDisabledReason?/maskEdit?(runtime 不持久化,但 serverTaskId/sourceDeleted 持久化)。
- **不在本文件展开到字段级 CRDT 映射**——chat 是独立 collection,字段级 schema 随 T1.3(4 API + PersistAdapter)定稿;本处只钉归属(document 域)+ 键语义(messagesByScene/canvasId)+ 级联随 FX-7。
- 表征对照:chatHydration #167(chatStore.ts hydrate/settleExpiredChatMessages 回落 + messagesByScene 键语义,baseline 114 expect/30 it/6 describe)——DP-6 落地时该表征断言不许改。

---

## 6. 发现的矛盾与裁决(源码 vs 计划/架构;lead 2026-07-10 拍板)

1. **sectionId / aiWorkflow 顶层与 relations 内并存**:[已裁决] 纯图关系字段(parentIds/sectionId/targetNodeId/connectorStart/connectorEnd)canonical 统一归 relations 嵌套 Y.Map,顶层 flat 全降 D;aiWorkflow canonical 留顶层,relations.aiWorkflow 迁移后移除。单一家园,不再双写。源码现状(documentModelV2 `relationsForNode` L157-169 合成、`setNodeRelations` L376-393 回填,L267/L328 与 L220-227 双写)在 T1.2 实施时按此收口。详见 §2.5/§2.8/§2.9/§3.6。
2. **`status` 字段身份模糊**:[已裁决] 降级 session 派生,record 内不存(入 D)。派生规则:task 存在→随 task 状态;task 不存在→节点有 asset 视为 ready、无 asset 视为 failed。理由:last-known 缓存 = 第二真相源,split-brain 风险。影响 §7 #168。详见 §2.1。
3. **`asset` 是 url 非 assetId**:[已确认] T1.5 资产服务端化时 record 内 asset 字段 url→assetId(内容寻址),现维持 K+过渡注记,不阻塞 T1.2a。详见 §2.4/§3.5。
4. **计划 §4 T1.2 行"records 扁平化"vs 架构 §6"无嵌套大 JSON"**:[记录备查,非真矛盾] §6 反对整段不可合并 JSON blob,字段级嵌套 Y.Map(每叶子独立合并)正是 §6 推荐"可无损映射 Y.Map/Y.Array 形状"。两者不冲突。

---

## 7. 表征测试对照(schema 决策影响点)

迁移硬约束(plan §2/§7):**表征测试先行、迁移后一字不改**。下表标 schema 决策会影响哪些表征断言——这些点落地时须同步迁移表征(断言数不减、内容不改,只改数据来源)。

| 表征测试(PR) | 文件 | baseline | 受影响的 schema 决策 |
|---|---|---|---|
| #163 | src/store/authSlice.characterization.test.ts | SSO 网关身份链路(authSlice+authClient)钉现状 | **无直接影响**(auth 不在 document record 范围);身份模型对齐见 DP-4/T1.4 |
| #164 | src/store/projectsSlice.characterization.test.ts | 项目/画布 CRUD 现状语义 | **selection 迁 session(§4.1)、tasks 迁服务端(§4.3)、nodes/edges 扁平 record**——画布 CRUD 返 id + selection 来源变;断言语义不改,数据来源改 |
| #167 | src/store/chatHydration.characterization.test.ts | 114 expect/30 it/6 describe | **DP-6 chat per-canvas collection(§5)**——messagesByScene 键语义、settleExpiredChatMessages 回落;hydrate 来源从 IDB → /api/canvas 子资源,断言不改 |
| #168 | src/canvas/actions/canvasActionModel.characterization.test.ts(+ quickbar) | 315 expect/203 tests(part1/2+quickbar) | **anchor 收编为 record(§4.2)、status 派生(§2.1)、selection 迁出(§4.1)**——anchor action 分发、status 读取、选区 action 须同步迁移;command 形式化(T2.3)亦影响 |

> **落地清单**:T1.2 实施时,凡触及上表"受影响"项的 PR,须在 PR 说明"表征断言数不减、内容不改、仅改数据来源",并在该 PR 附迁移前后表征跑通证据。

---

## 8. 裁决结果(2026-07-10 lead 拍板)

| 未决项 | 裁决 | 落地小节 |
|---|---|---|
| DP-1 迁移窗口是否冻结 selection 读写 | **不冻结**;迁移瞬间选区清空可接受,v10 迁移后首次加载 selection 为空属预期降级行为 | §4.1 |
| DP-2 experimentalAnchors 去留 | **(b) 收编为顶层 `Anchor` record**(document 域,独立 id+revision);锚点对话是产品范式核心,删除与愿景矛盾 | §4.2/§3.9/§2.11 |
| DP-2 annotationBounds 去留 | **(b) 收编为 annotation 节点 formal 子字段** | §4.2/§3.10/§2.11 |
| tasks 归属 | **(b) 服务端 tasks registry(FX-2 per-user)+ preset demo 留 demo seed**;document record 无 tasks 字段 | §4.3 |
| status 字段 | **降级 session 派生,record 不存**(入 D);派生规则:task 存在→随 task 状态,task 不存在→有 asset→ready、无 asset→failed;last-known 缓存=第二真相源 split-brain 风险 | §2.1/§6 矛盾 2 |
| 矛盾 1 双写镜像 | **按语义单一家园**:纯图关系字段 canonical 归 relations(顶层 flat 降 D);aiWorkflow canonical 留顶层,relations.aiWorkflow 移除 | §2.5/§2.8/§2.9/§3.6/§6 矛盾 1 |
| asset url→assetId 时机 | **维持现文档写法**(T1.5 切换,现 K+过渡注记) | §2.4/§6 矛盾 3 |

> K/D 终值(裁决后重算):**K=40 / D=24 / ×=0**(sectionId 由 K 降 D,其余不变;total 64 不变)。PR #174 保持 draft,合并由 merge-queue 走。
