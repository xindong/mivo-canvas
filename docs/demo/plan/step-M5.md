# M5 派生数据模型步骤计划

## PHASE_GOAL
把画布状态从“节点里隐式 parent/aiWorkflow”改为显式 `edges: CanvasEdge[]`，并提供 M1/M2 共用的唯一提交入口 `commitGenerationResult(...)`：每次生成或编辑都在该 action 内保存结果图到 IndexedDB、创建新 image node 和一条 `generate/edit` edge，原节点不覆盖；edge 持久化、进 snapshot、进 AI context，并在画布上显示为随节点移动的连线。

## 精确改动清单
| 文件 / 符号 | 改动 |
|---|---|
| `src/types/mivoCanvas.ts:62-66` `ConnectorBinding` 后 | 新增 `CanvasEdgeType = 'generate' \| 'edit'`、`CanvasMaskBounds = {x:number;y:number;width:number;height:number}`、`CanvasEdge = {id:string; from:string; to:string; type:CanvasEdgeType; prompt:string; createdAt:number}`。edge 不放 `maskBounds`，局部编辑范围只放在结果节点 `generation.maskBounds`，以遵守 master 的 Edge 形状。 |
| `src/types/mivoCanvas.ts:101-159` `MivoCanvasNode` | 新增 `sourceNodeId?: string`；把 `generation` 改为兼容结构：`prompt:string; model:string; size?:string; seed?:number; strength?:number; taskId?:string; createdAt?:number; maskBounds?: CanvasMaskBounds`。旧 demo scene 的 `size/seed` 继续可读。 |
| `src/types/mivoCanvas.ts:194-211` `AiCanvasContextSnapshot` | 新增 `edges: CanvasEdge[]`；`links.kind` union 增加 `CanvasEdgeType`，用于把显式 edge 投影给“查看 AI 上下文”。 |
| `src/types/mivoCanvas.ts:221-238` `MivoCanvasSnapshot` / `CanvasDocument` | 两个类型都新增 `edges: CanvasEdge[]`。 |
| `src/types/mivoCanvas.ts:240-247` `SceneDefinition` | 新增可选 `edges?: CanvasEdge[]`，让旧 scenes 不必逐个补空数组。 |
| `src/types/generation.ts:3-16` | 新增 `CommittedGenerationKind = 'generate' \| 'edit'`、`CommittedGenerationImage = { b64?: string; blob?: Blob; mimeType?: string; title?: string; width?: number; height?: number }`、`CommitGenerationResultPayload = { sourceNodeId?: string; resultImages: CommittedGenerationImage[]; prompt: string; model: string; kind: CommittedGenerationKind; maskBounds?: CanvasMaskBounds; taskId?: string; placement?: 'right' \| 'below' \| 'left' }`。`sourceNodeId` 允许可选，但 M1 空画布必须先建 ai-slot 并传 slot id，M2 必须传原 image id。 |
| `src/lib/assetStorage.ts:249-281` `saveImportedAsset` 后 | 新增 `saveGeneratedAsset(blob, name, type?)`，复用 `createAssetId()`、`prepareImportedImage()`、`withAssetStore()`，返回字段与 `saveImportedAsset` 一致：`assetUrl/name/type/sizeBytes/title/size/dimensions/sourceDimensions/hasTransparency`。该 helper 由 `commitGenerationResult` 调用，M1/M2 不直接存图。 |
| `src/store/demoScenes.ts:290-299` `snapshotFromScene` | 返回 snapshot 时加 `edges: scene.edges || []`；`empty` scene `src/store/demoScenes.ts:280-284` 不需要写 edges 字段。 |
| `src/store/aiCanvasWorkflow.ts:1-6` imports | 引入 `CanvasEdge` / `CanvasEdgeType`。 |
| `src/store/aiCanvasWorkflow.ts:8-13` `AiContextState` | 增加 `edges: CanvasEdge[]`。 |
| `src/store/aiCanvasWorkflow.ts:84-187` `buildAiContextSnapshot` | 先过滤端点都存在且未 hidden 的 `state.edges`；把这些 edge 写入返回值 `edges`，同时 `pushLink({kind: edge.type, fromNodeId: edge.from, toNodeId: edge.to})`。新增本地 predicate `isDerivationEdgeProjectionNode(node)`（条件：`node.generation?.model === 'Mivo Derivation Edge'`），`summary`、`nodes` map、legacy `parentIds/aiWorkflow/connector` links 都只遍历 `visibleContentNodes`，避免派生可视线作为普通节点或 connector link 重复进入 AI context。 |
| `src/store/canvasStore.ts:3-20` type imports | 引入 `CanvasEdge`、`CanvasEdgeType`、`CanvasMaskBounds`、`CommitGenerationResultPayload`、`saveGeneratedAsset`。 |
| `src/store/canvasStore.ts:39-49` `CanvasState` | 新增 `edges: CanvasEdge[]`；新增唯一共享 action：`commitGenerationResult(payload: CommitGenerationResultPayload): Promise<string[]>`，返回新建 result node ids；`historyPast/historyFuture` 的 snapshot 自动携带 edges。 |
| `src/store/canvasStore.ts:180-184` generation action types | 为 M1 预留 options：`generateBesideNode` / `generateIntoAiSlot` / `generateImageEdit` 后续可返回 `Promise<void>`；M5 本步新增 `commitGenerationResult`，现有 mock actions 在同步返回时也使用同一 edge 创建 helper，不再复制 edge 拼装。 |
| `src/store/canvasStore.ts:193-195` `PersistedCanvasState` | `Pick` 中加入 `edges`。 |
| `src/store/canvasStore.ts:206-227` clone helpers | 新增 `cloneEdge(edge)`、`cloneEdges(edges)`；`snapshotFromState` 使用 clone 后的 edges。 |
| `src/store/canvasStore.ts:241-248` `snapshotFromState` | `Pick` 增加 `edges`，返回对象加 `edges: cloneEdges(state.edges)`。 |
| `src/store/canvasStore.ts:263-264` id helpers | 新增 `createEdgeId = () => createNodeId('edge')`；新增 `edgeTypeForOperation(operation)`，把 `slot-generation/beside-generation/variation` 映射为 `generate`，把 `annotation-edit/prompt-edit/area-edit/remove-background/outpaint/upscale` 映射为 `edit`。 |
| `src/store/canvasStore.ts:263-264` id helpers | 新增 `blobFromCommittedGenerationImage(image)`：若 `image.blob` 存在直接用；否则把 `image.b64` 解码成 `Blob`，MIME 默认 `image/png`。新增 `displaySizeForGeneratedAsset(asset, fallbackSize)`：优先用 `asset.sourceDimensions` 经 `importedImageDisplaySize`，失败才用 source/slot 尺寸。 |
| `src/store/canvasStore.ts:361-386` `normalizeConnectorMarkupNodes` 附近 | 新增派生连线投影 helper：`derivationEdgeNodeId(edgeId)`、`isDerivationEdgeNode(node)`、`createDerivationEdgeNode(edge, nodes)`、`syncDerivationEdgeNodes(nodes, edges)`。该 helper 生成 locked `markup` arrow node，`connectorStart:{nodeId:edge.from,anchor:'right'}`，`connectorEnd:{nodeId:edge.to,anchor:'left'}`，`markupStrokeColor:'#3f6f64'`，`generation.model:'Mivo Derivation Edge'`。 |
| `src/store/canvasStore.ts:385-386` `normalizeCanvasNodes` | 保留现有 `normalizeCanvasNodes(nodes)` 签名；新增 `normalizeCanvasGraph(nodes, edges)`，内部先 `syncDerivationEdgeNodes(nodes, edges)`，再调用现有 `normalizeCanvasNodes(...)`。这样 `updateNodePosition` 等现有调用不必逐个改签名。 |
| `src/store/canvasStore.ts:400-407` `createBlankDocument` | 返回 `edges: []`。 |
| `src/store/canvasStore.ts:409-420` `canvasDocumentFromScene` | 从 snapshot 复制 `edges: cloneEdges(snapshot.edges || [])`。 |
| `src/store/canvasStore.ts:432-443` `normalizeDocument` | `const edges = cloneEdges(document.edges || [])`；nodes 使用 `normalizeCanvasGraph(cloneNodes(document.nodes), edges)`；selection 基于同步后的 nodes。 |
| `src/store/canvasStore.ts:446-476` `patchActiveCanvas` | patch 类型加入 `edges`；`nextEdges = patch.edges ?? state.edges`；`nextNodes = 'nodes' in patch || 'edges' in patch ? normalizeCanvasGraph(patch.nodes || state.nodes, nextEdges) : state.nodes`；返回 state 时带 `edges`。 |
| `src/store/canvasStore.ts:478-484` `patchWithHistory` | patch 类型加入 `edges`，沿用 `patchActiveCanvas`。 |
| `src/store/canvasStore.ts:486-509` `applySnapshot` | 从 snapshot 读取 `edges: cloneEdges(snapshot.edges || [])`；返回 state 带 `edges: document.edges`。 |
| `src/store/canvasStore.ts:592-646` `migratePersistedState` | persist version 从 6 升到 7 时，每个 document 缺 edges 补 `[]`；旧顶层 `persisted.nodes/tasks` 合并到 active document 时也补 `edges: persisted.edges || currentDocument.edges || []`。 |
| `src/store/canvasStore.ts:653-665` store 初始值 | 加 `edges: defaultDocument.edges || []`。 |
| `src/store/canvasStore.ts:666-690` `createCanvas` | set 返回值加 `edges: normalizedDocument.edges`。 |
| `src/store/canvasStore.ts:697-724` `duplicateCanvas` | set 返回值加 `edges: duplicatedDocument.edges`；不要让 edge id 复用到原 canvas 之外时指向不存在节点。若复制整 canvas，保留 edge id；若只 duplicate selected nodes，不复制 edges。 |
| `src/store/canvasStore.ts:1130-1171` `deleteNode` / `deleteSelectedNodes` | 删除节点时同步过滤 `edges.filter(edge => !deletedIds.has(edge.from) && !deletedIds.has(edge.to))`；派生 edge markup nodes 由 `syncDerivationEdgeNodes` 移除。 |
| `src/store/canvasStore.ts:1783` generation actions 前 | 实现 `commitGenerationResult(payload)`：1) trim prompt，读取 source node（若 `sourceNodeId` 存在但找不到，抛 `Source node not found`）；2) 对 `payload.resultImages` 逐张 `blobFromCommittedGenerationImage` → `saveGeneratedAsset(blob,title,mimeType)`；3) 用 `chooseAdjacentPlacement({nodes: nextNodes, anchor: source, width, height, placement: payload.placement || 'right'})` 放位；若没有 source，用 `{x:0,y:0}` 起始并按 36px stagger，但 M1/M2 demo 路径必须传 source；4) 创建 image node，写 `sourceNodeId`、`generation:{prompt,model,createdAt,maskBounds,taskId}`、`asset*` metadata；5) source 存在时创建 `CanvasEdge{id:createEdgeId(),from:source.id,to:node.id,type:payload.kind,prompt,createdAt}`；6) 一次 `patchWithHistory` 追加 nodes/edges、选中新结果集合；7) `saveGeneratedAsset` 或任何一步失败时不 patch nodes/edges。 |
| `src/store/canvasStore.ts:1783-1808` `generateVariations` | 对 `result.nodes` 中每个结果创建 `CanvasEdge`：`from: source.id`、`to: node.id`、`type:'generate'`、`prompt: node.generation?.prompt || nodePrompt(source)`、`createdAt: Date.now()`；patch 写 `edges:[...current.edges,...newEdges]`。 |
| `src/store/canvasStore.ts:1809-1882` `generateImageEdit` | M5 阶段仍可保持 mock 结果，但必须通过共享的 `appendDerivedResultNodes` / edge helper 写 `sourceNodeId`、`generation.createdAt` 和 edge。M1/M2 真实 b64 流不调用这里拼 node，而是调用 `commitGenerationResult`。 |
| `src/store/canvasStore.ts:1883-1949` `generateBesideNode` | M1 阶段把 mock 替换为：调用 `generateMivoImage` / `editMivoImage` 后，直接 `await commitGenerationResult({sourceNodeId: source.id, resultImages: response.images, prompt, model, kind:'generate'})`。本行只保留 source 解析、task 状态与上游调用，不再手写 node/edge。 |
| `src/store/canvasStore.ts:1950-2028` `generateIntoAiSlot` | M1 阶段把 mock 替换为：slot 作为 source，调用 shared image client 后 `await commitGenerationResult({sourceNodeId: slot.id, resultImages: response.images, prompt, model, kind:'generate', placement:'right' 或 slot 对齐选项})`；slot 保留，不被结果覆盖。 |
| `src/store/canvasStore.ts:2029-2098` `generateFromAnnotation` | M5 阶段为旧 annotation mock 写 edge；M2 不复用 annotation 作为 mask 结果来源。若后续真实 annotation edit 接入，也必须调用 `commitGenerationResult({kind:'edit'})`。 |
| `src/store/canvasStore.ts:2152-2153` getters | `getSnapshot()` 自动含 edges；`getAiContextSnapshot()` 改为 `buildAiContextSnapshot({ sceneId:get().sceneId, nodes:get().nodes, edges:get().edges, selectedNodeId:get().selectedNodeId, selectedNodeIds:get().selectedNodeIds })`，避免把整个 store action 对象传给 context builder。 |
| `src/store/canvasStore.ts:2155-2168` persist config | `version: 7`；`partialize` 加 `edges: state.edges`。 |
| `src/lib/snapshotValidation.ts:1-10` imports | 引入 `CanvasEdge`、`CanvasEdgeType`、`CanvasMaskBounds`。 |
| `src/lib/snapshotValidation.ts:59-75` `isImageCrop` 后 | 新增 `isCanvasMaskBounds`，校验 `x/y/width/height` 为 number 且 width/height > 0。 |
| `src/lib/snapshotValidation.ts:77-93` `isAiWorkflow` 后 | 新增 `isGeneration(value)`，允许 `prompt/model` string，`size/seed/strength/taskId/createdAt/maskBounds` 可选。 |
| `src/lib/snapshotValidation.ts:95-160` `isCanvasNode` | 加校验 `sourceNodeId`、`generation`；保留旧节点没有 `generation.createdAt` 的情况。 |
| `src/lib/snapshotValidation.ts:164-176` `isCanvasTask` 后 | 新增 `isCanvasEdge(value): value is CanvasEdge`：`id/from/to/prompt` string，`type` 是 `generate/edit`，`createdAt` number。 |
| `src/lib/snapshotValidation.ts:204-210` snapshot 校验 | `parsed.edges` 缺省视为 `[]`；若存在必须是 `CanvasEdge[]`。返回 snapshot 前补 `edges: parsed.edges || []`。 |
| `src/lib/canvasArchive.ts:21-38` | 不改资产收集逻辑；archive 的 `snapshot` 会自然包含 edges。只需确认 `snapshot.nodes` 中派生 edge markup nodes 没有 `assetUrl`，不会进入 assets。 |

## 依赖与落地顺序
1. 先改 `src/types/mivoCanvas.ts`，让 `CanvasEdge` 和 `edges` 成为唯一共享类型。
2. 改 `demoScenes.snapshotFromScene`、`snapshotValidation`，让旧 scene 和旧 JSON 都能补 `edges: []`。
3. 改 `canvasStore` 的 clone/snapshot/document/patch/migrate/persist，确保 undo/redo、canvas 切换、reload 都保留 edges。
4. 在 `assetStorage` 加 `saveGeneratedAsset`，再在 `canvasStore` 加 `commitGenerationResult(payload)`；此 action 是 M1/M2 唯一写结果图 node + edge 的入口。
5. 加 `syncDerivationEdgeNodes`，用现有 markup arrow + connector binding 显示 edge；再改 `normalizeDocument` 和 `patchActiveCanvas` 接入。
6. 改现有 mock `generate*` actions 写 `sourceNodeId` 和 edge；M1 后续把 mock assetUrl 替换成真实上游结果时直接调用 `commitGenerationResult`，不复制 node/edge 创建逻辑。
7. 改 `buildAiContextSnapshot`，让 AI 工具面板的 `查看 AI 上下文` 能看到显式 edges，同时过滤派生 edge projection markup node。

## SC 验收
| master SC | 浏览器怎么点 | 看到什么算通过 |
|---|---|---|
| M5-SC1 M1 产物是新节点且原节点不覆盖 | 完成 M1 后：空画布输入 prompt，点 `立即生成`。 | 画布保留 AI slot；生成图片是新 image node；`查看 AI 上下文` JSON 里有 `edges[0].from = slotId`、`edges[0].to = resultId`、`type = "generate"`。 |
| M5-SC1 M2/M1 编辑产物是新节点且原图不覆盖 | 选中一张 image，右键或 AI 面板触发 `generateBesideNode` / 后续 M2 局部重绘。 | 原 image 仍在原位置；新 image 出现在右侧；新节点 `sourceNodeId` 等于原图 id；edge `from` 原图、`to` 新图、`type = "edit"` 或 `"generate"`。 |
| M5-SC1 edge 存在且随节点移动 | 在画布上拖动 source 节点，再拖动 result 节点。 | 可见连线端点贴着两个节点移动；删除 source 或 result 后，该 edge 和它的可视连线一起消失；undo 后节点和 edge 一起恢复。 |
| M5 shared commit action | 在 M1 或临时 dev console 触发一次 `commitGenerationResult({sourceNodeId: slotId, resultImages:[{b64}], prompt:'test', model:'gpt-image-2', kind:'generate'})`。 | 结果图先进入 IndexedDB，画布新增 image node；原 source/slot 不覆盖；`edges` 增加 `from=slotId,to=resultId,type='generate'`；返回值是新 node id 数组。 |
| 持久化 / snapshot | 生成一条 edge 后刷新浏览器；再导出/导入 snapshot。 | 刷新后 edge 仍在；导入旧 snapshot 时没有报错且 `edges` 为 `[]`；导入新 snapshot 时 edge 数量不丢。 |

## 风险与回退
| 风险 | 处理 / 回退 |
|---|---|
| 旧 localStorage 没有 `edges` 导致启动报错 | `migratePersistedState` 统一补空数组；persist version 升到 7。回退时保留 `edges ?? []` 兼容逻辑，不清用户本地画布。 |
| 派生 edge markup node 污染普通节点统计 | `isDerivationEdgeProjectionNode` 用 `generation.model === 'Mivo Derivation Edge'` 标记；`buildAiContextSnapshot` 的 summary、nodes map、legacy links 都遍历 `visibleContentNodes`，显式 `edges` 单独输出，避免 edge projection 作为普通 markup node 重复进入 AI context。 |
| 用户删除 source 后遗留悬空 edge | `deleteNode/deleteSelectedNodes` 同步过滤 edges；`syncDerivationEdgeNodes` 每次 patch 移除端点不存在的可视线。 |
| edge 视觉与 `edges` 数据重复 | `edges` 是 source of truth；markup arrow 只由 `syncDerivationEdgeNodes` 生成。若视觉有问题，可临时关闭 `syncDerivationEdgeNodes`，数据 edges 仍保留，M1/M2 非破坏语义不丢。 |
| M1/M2 async 失败但 M5 已创建 edge | `commitGenerationResult` 内部先完成 b64/blob → `saveGeneratedAsset` 和 result node 准备，再一次性 `patchWithHistory`；任一图片保存失败时抛错且不 patch nodes/edges。M1/M2 catch 只更新 failed task / overlay error，不创建半成品节点。 |
