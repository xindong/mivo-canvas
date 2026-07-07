# PR-C 拖拽性能实施计划（drag-perf）— v2

> 状态：设计定稿 v2（吸收 GPT-5.5 二审 5 条 findings，修订点标【v2】），可直接执行。执行 worker 无需再做设计决策。
> 仓库根：`/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
> 涉及审计项：R01 / R02 / R02b / C03 / C04 / C05
> 硬约束：`src/render/`（projection / hitTest / interactionAdapter / layers / viewportMatrix / rendererMode / cullingMode）为冻结资产，**只允许新增测试，不允许改任何源文件**；undo/redo 与拖拽手势外部行为完全不变。

---

## 0. 背景与根因链

拖拽路径（每个 pointermove 一次）：

```
useNodeTransform.tryMoveNodeTransform (src/canvas/useNodeTransform.ts:153-209)
  → updateSelectedNodesPosition (src/store/nodeMutationSlice.ts:37-63)
    → normalizeCanvasNodes(state.nodes.map(...))   ← R01 主根因
       = normalizeSectionMembership → normalizeConnectorMarkupNodes → normalizeCanvasNodesV2
         (src/store/canvasDocumentModel.ts:242-243)
    → patchActiveCanvas → zustand set → React 全量渲染
      → MivoCanvas.tsx renderedNodes.map → 每节点 isNodeEffectivelyLocked O(n) ← C03
      → CanvasNodeView（已是 React.memo，src/canvas/CanvasNodeView.tsx:476）
        → canvasRenderAdapter 每导出函数最多 3 次 normalize 深克隆 ← R02
```

三层 normalize 中，前两层（sectionMembership / connectorMarkup）本身已做"无变化则原引用返回"（canvasDocumentModel.ts:173、:208），**只有第三层 `normalizeCanvasNodeV2`（src/model/documentModelV2.ts:180-196）无条件重建每个节点的全部子对象**。N=1000 时每帧 1000 次深克隆；且节点引用全部变化导致 `CanvasNodeView` 的 `memo` 全部失效——**克隆成本 + memo 失效双重代价**。

---

## 1. R01 主修：normalizeCanvasNodeV2 加"已归一化快速路径"

### 1.1 方案选择：快速路径（方案 A），不做"只归一 moveSet"（方案 B），不组合

**结论：只做 A（二审确认成立）。** 理由：

1. **B 语义不安全**。`normalizeCanvasNodes` 前两层是跨节点推导：
   - `normalizeSectionMembership`（canvasDocumentModel.ts:168-174）按**全量节点几何**重算每个非 section 节点的 `sectionId`——拖 frame 时**不在 moveSet 的节点**的 membership 也可能改变。
   - `normalizeConnectorMarkupNodes`（canvasDocumentModel.ts:206-229）让连接器跟随绑定端点——挂在被拖节点上的连接器**本身不在 moveSet**，却必须每帧重算，否则拖拽时连接器不跟手。
2. **A 恰好只消真浪费**。前两层已引用保持；第三层加 O(1) 判据后未动节点原引用返回（零克隆 + memo 命中）；被 `setNodeTransform` 更新的节点输出天然满足判据（见 1.3），二次 normalize 免费。
3. A 同时让 R02 的 adapter normalize 近似 no-op。

### 1.2 【v2】改动位置与形态：拆分 clone/normalize 双入口 + 带形状校验的谓词

**二审 blocker（F1）**：`src/store/nodeFactory.ts:29-30` 的 `cloneNode = { ...normalizeCanvasNodeV2(node), ... }` —— fills/strokes/effects/layout/constraints/asset/relations 的**克隆语义完全依赖 normalize 必产新对象**。cloneNode 服务 history/clipboard/persist（canvasDocumentModel.ts:57、createNodeCopy 等），快速路径直返原引用会让克隆与源共享子对象。

**修法（已定）**：`src/model/documentModelV2.ts` 拆出两个入口，共用同一构建体：

```ts
// ① 现 normalizeCanvasNodeV2 的函数体（documentModelV2.ts:180-196）原样改名为 clone 入口：
//    无快速路径，永远全量重建 + 浅克隆全部子对象 —— clone 语义与今天逐字节一致
export const cloneCanvasNodeV2 = (node: MivoCanvasNode): MivoCanvasNode => {
  const transform = transformForNode(node)
  return withLegacyGeometry(
    {
      ...node,
      fills: fillsForNode(node),
      strokes: strokesForNode(node),
      effects: node.effects ? node.effects.map(cloneEffect) : undefined,
      layout: cloneLayout(node.layout),
      constraints: cloneConstraints(node.constraints),
      asset: assetForNode(node),
      relations: relationsForNode(node),
    },
    transform,
  )
}

// ② normalize 入口 = 谓词短路 + 复用同一构建体
export const normalizeCanvasNodeV2 = (node: MivoCanvasNode): MivoCanvasNode =>
  isNormalizedCanvasNodeV2(node) ? node : cloneCanvasNodeV2(node)
```

`src/store/nodeFactory.ts:30` 改为 `...cloneCanvasNodeV2(node)`（import 同步调整）。cloneNode 其余自补的深拷贝字段（markupPoints/connectorStart/connectorEnd/parentIds/generation/aiWorkflow/experimentalAnchors，nodeFactory.ts:31-52）原样不动。

**谓词（含【v2】F3 形状校验）**：

```ts
// 【v2】F3：最小形状校验 —— null / 非数组 fills / 非对象 asset 等畸形字段
// 一律判"未归一化"，落回全量路径，保持与旧实现完全一致的行为
// （fills:null 旧路径归一为 undefined；fills:{} 旧路径 .map 抛错 —— 都不能被快速路径静默吞掉）
const isArrayOrUndefined = (value: unknown) => value === undefined || Array.isArray(value)
const isPlainObjectOrUndefined = (value: unknown) =>
  value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value))

// 判据逐条镜像 fillsForNode/strokesForNode/assetForNode/relationsForNode 的
// 合成触发条件（真值判断保持一致，不改成 !== undefined）
const isNormalizedCanvasNodeV2 = (node: MivoCanvasNode): boolean => {
  // ⓪【v2】semantic 字段形状校验（违者 → 全量路径，复现旧行为）
  if (!isArrayOrUndefined(node.fills) || !isArrayOrUndefined(node.strokes) || !isArrayOrUndefined(node.effects)) return false
  if (
    !isPlainObjectOrUndefined(node.asset) ||
    !isPlainObjectOrUndefined(node.relations) ||
    !isPlainObjectOrUndefined(node.layout) ||
    !isPlainObjectOrUndefined(node.constraints)
  ) return false

  // ① transform 完整且与 legacy 几何镜像一致（防"半归一化"：有 transform 但 legacy x/y 陈旧）
  const t = node.transform
  if (!t || typeof t.rotation !== 'number') return false
  if (t.x !== node.x || t.y !== node.y || t.width !== node.width || t.height !== node.height) return false

  // ② fills 缺失时，不存在任何会触发合成的 legacy 字段（镜像 fillsForNode:82-123）
  //    注意用 !node.fills（truthiness），空数组 [] 视为"已归一"，与旧路径 `if (node.fills)` 提前返回一致
  if (!node.fills) {
    if ((node.type === 'image' || node.type === 'task-placeholder') && node.assetUrl) return false
    if (node.type === 'frame' && node.sectionFillColor) return false
    if (node.type === 'markup' && node.markupFillColor) return false
  }

  // ③ strokes 缺失时，不存在合成触发字段（镜像 strokesForNode:125-155，保持 || 真值链原样）
  if (!node.strokes) {
    if (node.type === 'frame' && (node.sectionBorderColor || node.frameColor || node.sectionBorderWidth)) return false
    if (node.type === 'markup' && (node.markupStrokeColor || node.markupStrokeWidth)) return false
  }

  // ④ asset 缺失但存在 legacy assetUrl → 需合成（镜像 assetForNode:70-80）
  if (!node.asset && node.assetUrl) return false

  // ⑤ relations 缺失但存在任一 legacy 关系字段 → 需合成（镜像 relationsForNode:157-169）
  if (
    !node.relations &&
    (node.parentIds || node.sectionId || node.targetNodeId ||
     node.connectorStart || node.connectorEnd || node.aiWorkflow)
  ) return false

  return true
}
```

行为核对：`fills: null` 在 ⓪ 被拦（null 非 undefined 非数组）→ 全量路径 → `if (node.fills)` falsy → 按合成规则归一为合成值或 undefined，与旧行为一致；`fills: {} as never` 在 ⓪ 被拦 → 全量路径 → `{}` truthy → `.map` 抛 TypeError，**保持旧路径的显式报错，不被快速路径静默吞掉**。

### 1.3 判据正确性论证（执行 worker 照此写测试，不需要重推）

- **⓪-⑤ 全部成立时全量路径是"值恒等"的**：全量路径对已存在的 fills/strokes/effects/layout/constraints/asset/relations 只做浅克隆，值不变；① 保证 transform 与 legacy 一致、rotation 已是 number 不被 `?? 0` 改写；`withLegacyGeometry` 回写值与现值相同。返回原引用是纯优化。
- **【v2】克隆语义不再依赖 normalize**：唯一依赖"必产新对象"的调用点 `cloneNode` 已切到 `cloneCanvasNodeV2`（全仓调用点分类见 §1.5），其余调用点均为 render 读值、结构共享写入或全新字面量构造。
- **半归一化节点必被放行到全量路径**：transform 有但 legacy x 陈旧 → ① 相等性失败；缺 rotation → ① typeof 失败；fills 缺但 frame 带 `sectionFillColor` → ② 失败；strokes/asset/relations 同理 ③④⑤；null/畸形字段 → ⓪ 失败【v2】。
- **`setNodeTransform`（documentModelV2.ts:200-210）输出满足判据**：返回 `withLegacyGeometry(normalizeCanvasNodeV2(node), transform)`，五字段齐全且 legacy 同步回写。拖拽帧里被移动节点在随后的 `normalizeCanvasNodesV2` 中也走快速路径。
- **既有语义原样保留**：`relations` 存在时 normalize 不用顶层 `sectionId` 刷新 `relations.sectionId`（relationsForNode:158 直接克隆返回）——快速路径与全量路径行为一致，不引入分歧。
- **连接器节点**：`normalizeConnectorMarkupNodes` 对带 binding 的连接器每帧无条件重建（canvasDocumentModel.ts:218），既有行为、数量小，不在本 PR 范围（测试断言排除连接器）。

### 1.4 复杂度效果

每帧：未动节点 = 一次 O(1) 字段谓词（无分配）；被动节点 = 原有成本。React 层：未动节点引用稳定 → `CanvasNodeView`（memo）跳过重渲。

### 1.5 【v2】normalizeCanvasNodeV2 全仓调用点排查与分类（执行时逐条复核）

排查命令（落地前重跑，防新增调用点漂移）：

```bash
grep -rn "normalizeCanvasNodeV2\|normalizeCanvasNodesV2" src --include="*.ts" --include="*.tsx" | grep -v ".test.ts"
```

2026-07-05 基线分类（三类：**clone**=依赖必产新对象，必须改用 cloneCanvasNodeV2；**write**=不可变更新/结构共享，快速路径安全；**render**=只读取值，快速路径安全）：

| 调用点 | 类别 | 判定依据 |
|---|---|---|
| `src/store/nodeFactory.ts:30`（cloneNode） | **clone → 改 cloneCanvasNodeV2** | history/clipboard/persist 深拷贝契约，快速路径会共享子对象（二审 F1） |
| `src/store/canvasDocumentModel.ts:243`（normalizeCanvasNodesV2，写路径三层管线） | write | R01 优化目标本体；store 全链路不可变，结构共享安全 |
| `src/model/documentModelV2.ts:209,213,237,263,280`（setNodeTransform/Fills/Strokes/Asset/Relations 内部） | write | 输出再 spread 成新顶层对象；未变子对象结构共享是不可变模型标准行为 |
| `src/model/canvasSnapshotModel.ts:12`（normalizeNodeForSnapshot） | write | 输入是 spread 新对象且 fills/strokes/asset/relations 已显式置 undefined；persist 只做 JSON 序列化，且 generation/markupPoints 在旧实现中本就与源共享引用（normalize 从不克隆这两个字段），不存在"从深拷贝退化"问题 |
| `src/model/aiCanvasCommands.ts:66` | write（构造） | 输入是全新字面量对象，无共享风险 |
| `src/store/nodeCreationSlice.ts:390,402` | write | 输入 `{ ...node, ...style, fills: undefined, strokes: undefined }` 为新 spread 对象 |
| `src/store/demoScenes.ts:32`（makeNode） | write（构造） | 输入是全新字面量 |
| `src/canvas/canvasRenderAdapter.ts:33,35,37` | render | 只 `.find`/`.transform` 读值（R02 改造对象） |
| `src/render/projection.ts:203`（projectNode，冻结区） | render | projectNode 输出 RenderNode 时对 fills/strokes/effects/markupPoints/generation/aiWorkflow 自行克隆（projection.ts:223-227,242,280-281），与源无共享；无需也不允许改 |

结论：仅 cloneNode 一处切换入口；其余 8 处快速路径安全。执行时若 grep 出**新调用点**，按同表三分类法归类后再落地，clone 类一律切 `cloneCanvasNodeV2`。

---

## 2. R02：canvasRenderAdapter 每函数 normalize 一次

### 2.1 改动位置

`src/canvas/canvasRenderAdapter.ts:33-81`。现状：`frameRenderStyleFor` / `markupRenderStyleFor` 各自调用 `firstSolidFillFor` + `firstStrokeFor`（每个内部各 normalize 一次）= 每节点每帧最多 2-3 次 normalize。

### 2.2 修改后形态（伪代码级）

```ts
// 三个 helper 改为接收"已归一化节点"，不再各自 normalize：
const firstSolidFillOf = (n: MivoCanvasNode) => n.fills?.find(isVisibleSolidFill)
const firstStrokeOf = (n: MivoCanvasNode) => n.strokes?.find(visibleStroke)
const transformOf = (n: MivoCanvasNode) =>
  n.transform || { x: n.x, y: n.y, width: n.width, height: n.height, rotation: 0 }

export const nodeRenderBoxFor = (node: MivoCanvasNode): NodeRenderBox => {
  const transform = transformOf(normalizeCanvasNodeV2(node))   // 保留防御性 normalize
  ...（其余原样）
}

export const frameRenderStyleFor = (node: MivoCanvasNode): FrameRenderStyle => {
  const n = normalizeCanvasNodeV2(node)          // 每函数恰好一次
  const fill = firstSolidFillOf(n)
  const stroke = firstStrokeOf(n)
  // fallback 链保持逐字不变：fill?.color || node.sectionFillColor || '#ffffff' 等
  ...
}

export const markupRenderStyleFor = ...   // 同构改法
// textRenderStyleFor 不动（不调 normalize）
```

约束：三个导出函数的**返回值逐字段不变**（fallback 链、默认值、单位字符串全部原样）。R01 落地后这里的 normalize 对 store 节点是引用直返，保留它只作为对"外部未归一节点"的防御。

---

## 3. R02b【先行】：projection ↔ adapter 投影语义对照测试

### 3.1 差异处置决策：三选一 → **选"不改代码、测试锁定 + 文档化差异"**

差异本体：`projectNode`（src/render/projection.ts:223）给 `fills: n.fills ?? []`（缺省空数组），同时把 legacy `sectionFillColor` 等也拷进 RenderNode（:255）；adapter（canvasRenderAdapter.ts:63）则做二次 fallback `fill?.color || node.sectionFillColor || '#ffffff'`。

- 不改 projection：`src/render/` 冻结（P3-0b 接线曾出 Hand-tool pan 回归，D10 gate 判 P3 顺延）。
- 不改 adapter：live 渲染路径，动 fallback 有视觉回归风险。
- **测试锁定**：证明"adapter 的最终解析值 = 对 projectNode 输出套同一条解析公式"，即 RenderNode 的 `fills[] + legacy 字段` 携带 adapter fallback 所需全部信息，两套实现**信息等价、解析公式一致**。未来 P3-0b 让 renderer 消费 RenderNode 时，消费端套用该公式即可与今日像素一致。差异文档化写进测试文件头注释。

### 3.2 新增测试文件

`src/canvas/canvasRenderAdapter.parity.test.ts`（新文件；放 src/canvas 不触碰冻结目录，允许 import `../render/projection` 只读）。

解析公式（测试内定义一次，作为锁定契约）：

```ts
const resolveSectionFill = (r: RenderNode) =>
  r.fills.find((f) => f.kind === 'solid' && f.visible)?.color || r.sectionFillColor || '#ffffff'
const resolveSectionStrokeColor = (r: RenderNode) =>
  r.strokes.find((s) => s.visible)?.color || r.sectionBorderColor || r.frameColor || '#ff8a00'
// width/style、markup fill/stroke/width/style/opacity 同构定义，
// 默认值逐字抄 canvasRenderAdapter.ts:63-80 现值
```

断言矩阵（每个 fixture 同时断言 frame 四项 / markup 五项 / geometry 三类）：

| # | fixture | 锁定点 |
|---|---------|--------|
| P1 | legacy frame（只有 sectionFillColor/BorderColor/Width/Style，无 fills/strokes） | normalize 合成路径两侧一致 |
| P2 | V2 frame（显式 fills+strokes，visible:true） | fills 优先级一致 |
| P3 | frame 带 fills 但全部 `visible:false` | **分歧焦点**：adapter 回落 legacy → 公式在 RenderNode 上给出同值 |
| P4 | frame 无任何 fill 来源 | 双默认 '#ffffff' / '#ff8a00' 一致；且 `projectNode(x).fills` 是 `[]` 不是 undefined（锁定缺省语义） |
| P4b【v2】 | frame `fills: []` **且** sectionFillColor 并存 | 空数组不触发合成（旧路径 `if (node.fills)` truthy 提前返回）：adapter find 落空 → 回落 sectionFillColor；公式在 RenderNode（fills=[] + sectionFillColor）上同值 |
| P4c【v2】 | frame `strokes: []` **且** sectionBorderColor/sectionBorderWidth/sectionBorderStyle/frameColor 并存 | 同 P4b 的 stroke 侧（color/width/style 三项 fallback 全走 legacy） |
| P5 | legacy markup（markupFillColor/StrokeColor/Width/Style/Opacity） | markup 合成路径一致 |
| P5b【v2】 | markup `fills: []` 且 markupFillColor 并存 | 同 P4b 的 markup 侧 |
| P6 | V2 markup（显式 fills/strokes） | 同 P2 |
| P6b【v2】 | markup `strokes: []` 且 markupStrokeColor/Width/Style/Opacity 并存 | 同 P4c 的 markup 侧（含 strokeOpacity fallback → markupOpacity） |
| P7 | image 节点（assetUrl，无 transform） | `nodeRenderBoxFor` 的 width/height/transform 字符串 == 由 `projectNode(x).geometry` 拼出的同式（`translate(${x}px, ${y}px)` + rotation 后缀规则一致） |
| P8 | 带 rotation 的节点 | rotate 后缀两侧一致 |

另加一条**注册性断言**：`projectNode` 对上表全部 fixture 输出的 `fills`/`strokes` 恒为数组（`Array.isArray`），锁死 projection 的缺省 `[]` 语义不被后续改动悄悄变成 undefined。

### 3.3 时序要求

该测试必须**先于 R01/R02 的任何源码行为改动**落地并绿（安全网，进 commit #1）。R01/R02 改完后必须仍绿（证明两项优化没有移动投影语义）。

---

## 4. C03 + C04：锁定判定 O(n²) → O(n)，规则文本收敛为全仓一份【v2】

### 4.1 现状

- `src/canvas/MivoCanvas.tsx:108-114`：本地 `isNodeEffectivelyLocked(nodeId, nodes)`，内部 `nodes.find` 两次；唯一调用点 `MivoCanvas.tsx:760` 在 `renderedNodes.map` 内逐节点调用 → O(n²)。
- 双实现：`src/canvas/useNodeTransform.ts:14-17` 已导出 `isNodeEffectivelyLocked(node, nodes)`；`useCanvasInteractionController.ts:11` 在消费。
- store 层 `isEffectivelyLocked`（canvasDocumentModel）为 store 侧规则，不在本 PR 范围，不动。

### 4.2 【v2】修改：抽单一 primitive，两个消费入口共用一份规则文本

二审 F5：v1 的 useMemo 把 `locked || sectionLockMode==='all'` 规则又内联了一份，C04"消双份"没消干净。**修法（已定）**：`src/canvas/useNodeTransform.ts` 收敛为一个 primitive + 两个消费入口：

```ts
// useNodeTransform.ts —— 全仓（canvas 层）唯一一份锁定规则文本：
const isLockedWithSection = (node: MivoCanvasNode, section: MivoCanvasNode | undefined): boolean =>
  Boolean(node.locked || section?.sectionLockMode === 'all')
// （section 的 type==='frame' 过滤由两个查找侧各自保证，与现实现一致）

// 消费入口 1：单节点即时判定（签名/复杂度与现导出版完全一致，交互路径不劣化）
export const isNodeEffectivelyLocked = (node: MivoCanvasNode, nodes: MivoCanvasNode[]): boolean =>
  isLockedWithSection(
    node,
    node.sectionId ? nodes.find((item) => item.id === node.sectionId && item.type === 'frame') : undefined,
  )

// 消费入口 2【新增导出】：批量 Set（渲染路径用，O(n)）
export const lockedNodeIdSetFor = (nodes: MivoCanvasNode[]): Set<string> => {
  const sectionsById = new Map(nodes.filter((n) => n.type === 'frame').map((n) => [n.id, n]))
  return new Set(
    nodes
      .filter((n) => isLockedWithSection(n, n.sectionId ? sectionsById.get(n.sectionId) : undefined))
      .map((n) => n.id),
  )
}
```

MivoCanvas 侧：

1. **删除** MivoCanvas.tsx:108-114 本地函数（C04）。
2. `visibleNodes` useMemo（:151）之后新增：`const lockedNodeIds = useMemo(() => lockedNodeIdSetFor(visibleNodes), [visibleNodes])`（import 自 useNodeTransform）。
3. `MivoCanvas.tsx:760` 改为 `effectiveLocked={lockedNodeIds.has(node.id)}`。

**防劣化约束**：`isNodeEffectivelyLocked` 不得改成"内部建 Set"——`useCanvasInteractionController.ts:132` 在 `selectedNodes.some(...)` 里逐节点调用它，内建 Set 会造成 O(n²)+分配回退。primitive 是纯布尔函数，两个入口各自负责查找策略。

**语义等价论证**：旧 MivoCanvas 本地版 = find(node) + find(section, type==='frame') + `locked || sectionLockMode==='all'`；新 Set 版 sectionsById 只收 frame、布尔链在 isLockedWithSection 中逐字对应；renderedNodes ⊆ visibleNodes 保证 node 必在集合计算范围内。

### 4.3 structure-guard 提示

MivoCanvas.tsx 在白名单内（基线 965 行）。本项对 MivoCanvas.tsx 净行数约 -7 +3 = **净负**；useNodeTransform.ts 增约 +14 行（不在超限风险区）。若 guard 报异常，先跑仓库实际 guard 入口确认再调整。

---

## 5. C05：culling 版 rectsIntersect 重命名消歧

- `src/canvas/MivoCanvas.tsx:98-101`：闭区间版（`>=`，边缘相触算相交——culling 宁可多渲染）。**重命名**为 `rectsIntersectInclusive`，唯一调用点 `MivoCanvas.tsx:236` 同步改名。
- `src/canvas/canvasInteraction.ts:242-243`：开区间版（`<`/`>`，边缘相触不算——选区语义）。**保持原名原样**，调用方不动。
- 零行为改动：纯标识符重命名。可选加一行注释注明与 canvasInteraction.rectsIntersect 的区间语义差异。

---

## 6. 新增/修改测试清单

| 文件 | 新增/修改 | 断言要点 |
|------|----------|----------|
| `src/canvas/canvasRenderAdapter.parity.test.ts` | **新增**（commit #1，先行） | §3.2 P1-P8 全矩阵（含【v2】P4b/P4c/P5b/P6b 空数组用例）+ fills/strokes 恒数组断言 |
| `src/store/nodeFactory.test.ts` | 【v2】追加（commit #1，先行） | **cloneNode 深拷贝契约**：对**已归一化**节点（先过一遍 normalizeCanvasNodeV2 取 `once`，须含 fills/strokes/effects/layout/constraints/asset/relations 全字段 + relations 内 parentIds/connectorStart/aiWorkflow.sourceNodeIds 嵌套）执行 `cloneNode(once)`：a) 七个子对象全部 `not.toBe` 源对应引用；b) 嵌套层 `relations.parentIds`、`relations.connectorStart`、`relations.aiWorkflow.sourceNodeIds` 亦非同引用；c) mutation 隔离：改 `once.fills[0].color`、push `once.relations.parentIds`，clone 不受影响；d) 值相等：clone `toEqual` 源（时序敏感字段除外） |
| `src/model/documentModelV2.test.ts` | 追加 | ① 幂等：`normalizeCanvasNodeV2(once) toBe once`（image/frame/markup/text 各一条）②【v2】空数组幂等：frame `fills:[]`+sectionFillColor、frame `strokes:[]`+sectionBorderColor、markup `fills:[]`+markupFillColor、markup `strokes:[]`+markupStrokeColor 的已归一节点均 `toBe(node)` 且 fills/strokes 保持 `[]` 未被合成（防谓词被误写成 `!fills?.length`）③ 半归一化守卫（每条断言非原引用且值被修正）：transform 有但 x 陈旧 → 新对象且 x 被重写；缺 rotation → 补 0；frame 无 fills 有 sectionFillColor → 合成 fill；image 无 asset 有 assetUrl → 合成 asset；无 relations 有 sectionId → 合成 relations ④【v2】畸形字段：`fills: null as never` → 归一后为 undefined（或合成值）且非原引用；`fills: {} as never` → `expect(() => ...).toThrow()`（与旧路径一致，不被静默吞）⑤ `setNodeTransform` 输出满足幂等 ⑥【v2】`cloneCanvasNodeV2` 对已归一节点仍产全新子对象（clone 与 normalize 行为分岔的直接断言） |
| `src/store/canvasDocumentModel.test.ts` | 追加（沿用既有文件） | 写路径引用保持（CI 功能门，无计时抖动）：20 个已归一节点（含 1 frame、2 个 section 成员、1 个带 binding 连接器），移动 1 个后跑 `normalizeCanvasNodes`：a) 未动/非连接器/membership 不变节点 `toBe` 原引用；b) 被移动节点值正确；c) 连接器几何跟随重算；d) frame 拖过非成员节点后其 sectionId 被重算（锁定否决方案 B 的两条语义） |
| `src/canvas/canvasRenderAdapter.test.ts` | 只增不改 | 既有断言必须原样通过（R02 是内部重构） |

不新增 e2e 场景；现有 `npm run test:e2e` 冒烟覆盖拖拽手势外部行为。

---

## 7. 性能测量步骤与通过阈值

bench 入口：`scripts/bench/collect.mjs`（`npm run bench:collect`），fixtures：`npm run bench:fixtures`。**现有 bench 只有 canvas-pan / canvas-zoom（collect.mjs:547,654-655），无拖拽动作；且 loadFixture 后 `setActiveTool('hand')`（collect.mjs:337），hand 工具在节点上 pointerdown 走 `beginPan`（canvasToolHandlers.ts:59-71 handToolHandler.onNodePointerDown）而非 beginNodeMove——不切工具的话 drag 场景测到的是 pan，完全测不到写路径（二审 F2）。**

### 7.1 【v2】commit #1 新增 bench 动作 `canvas-drag`（仅 scripts/，含工具切换与位移断言）

在 `scripts/bench/collect.mjs` 中：

1. 仿 `panCanvas`（:473-494）新增（【v2】关键差异：前后切工具 + 拖完断言节点真的动了）：

```js
// store 读取沿用 loadFixture（:337）已验证的 `await import('/src/store/canvasStore.ts')` 模式
const nodePositionInStore = (page, nodeId) =>
  page.evaluate(async (id) => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    const target = useCanvasStore.getState().nodes.find((item) => item.id === id)
    return target ? { x: target.x, y: target.y } : null
  }, nodeId)

const setBenchTool = (page, tool) =>
  page.evaluate(async (id) => {
    const { useCanvasStore } = await import('/src/store/canvasStore.ts')
    useCanvasStore.getState().setActiveTool(id)
  }, tool)

const dragNode = async (page) => {
  // 【v2】F2：fixture 加载后 activeTool==='hand'，hand 在节点上按下走 beginPan。
  // 切到 select 才能进 beginNodeMove 写路径；结束后恢复 hand，保住 pan/zoom gate 口径。
  await setBenchTool(page, 'select')
  try {
    const node = page.locator('[data-node-id]').first()   // CanvasNodeView.tsx:626
    const nodeId = await node.getAttribute('data-node-id')
    const before = await nodePositionInStore(page, nodeId)
    if (!before) throw new Error(`Drag target ${nodeId} not found in store`)

    const box = await node.boundingBox()
    if (!box) throw new Error('Missing draggable node bounding box')
    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()                                // select 工具 → beginNodeMove → 写路径
    for (const point of [
      { x: startX + 240, y: startY + 60 },
      { x: startX + 120, y: startY - 140 },
      { x: startX + 300, y: startY + 180 },
      { x: startX + 40,  y: startY + 20 },
    ]) {
      await page.mouse.move(point.x, point.y, { steps: 18 })
    }
    await page.mouse.up()
    await page.waitForTimeout(150)

    // 【v2】F2：正确性断言 —— 节点没动 = 没走 beginNodeMove，baseline 是假的，必须炸
    const after = await nodePositionInStore(page, nodeId)
    if (!after || (after.x === before.x && after.y === before.y)) {
      throw new Error(
        `canvas-drag did not move node ${nodeId} (before=${JSON.stringify(before)}, after=${JSON.stringify(after)}) — not exercising the node-move write path`,
      )
    }
  } finally {
    await setBenchTool(page, 'hand')                       // 恢复，pan/zoom 口径不变
  }
}
```

（目标节点选取【v3】：不再依赖"首个 `[data-node-id]`"——drag 此时跑在 pan/zoom 之后、viewport 已移动，改为从 store 取第一个 `!locked && !hidden` 且 type 为 image/text/frame 的节点 id，用 `[data-node-id="<id>"]` 定位后先 `scrollIntoViewIfNeeded()` 再取 boundingBox；boundingBox 仍为 null 时 throw。该滚动/定位步骤都发生在 canvas-drag 自己的 runAction 计时段内，不触碰 pan/zoom 段。）

2. 【v3 · 二审终审修正】`runAction('canvas-drag', () => dragNode(page))` 放到 **pan/zoom 之后**（:655 之后），不是之前——drag 走真实写路径会改 store（selectNode + 节点位移，拖中 frame 还会连带子节点），若先跑会让 pan/zoom gate 的输入状态不再是 clean post-render fixture，等于变相改 gate 口径。顺序定为：render settle → canvas-pan → canvas-zoom（二者仍在干净 fixture 上测，gate 上下文零污染）→ canvas-drag（独立 perAction，允许弄脏 store，测完本轮 run 即结束，无需恢复 fixture）。`'canvas-drag'` 加进 aggregateRuns label 列表（:547）、per-run `actions`/`traces`（:699-706）、`segments`/`traceMarks`（:804-806）。**overall/gate 聚合（:658-663）保持只聚合 pan/zoom，一行不动**；canvas-drag 只作为独立 perAction 指标输出。
3. `traceAction` 的 user_timing 过滤（:446）`canvas-` 前缀已覆盖 `canvas-drag`，无需改。

### 7.2 测量流程（before/after 同一机器、同一命令、关后台重负载）

```bash
npm run bench:fixtures                                # 首次
# BEFORE：在 commit #1（parity 测试 + clone 拆分 + bench drag，均无行为改动）上：
npm run bench:collect -- --nodes=1000 --dpr=1 --runs=5 --culling=on
npm run bench:collect -- --nodes=1000 --dpr=1 --runs=5 --culling=off   # off 放大全量渲染成本，信号更干净
# 记录输出 JSON 中 perAction['canvas-drag'].p95FrameMs / longTaskCount（中位数聚合）
# AFTER：全部改动落地后重复完全相同两条命令
```

结果连同原始 JSON 路径记入 PR 描述（before/after 对照表）。

### 7.3 通过阈值

| 指标（nodes=1000, dpr=1） | 阈值 |
|---|---|
| `canvas-drag` p95FrameMs（culling=off） | after ≤ before × 0.5，**或** after ≤ 16.7ms（满足其一即过；before 已 <16.7ms 则要求不劣化 >5%） |
| `canvas-drag` longTaskCount（culling=off） | after ≤ before |
| `canvas-pan` / `canvas-zoom` p95FrameMs（culling=on） | after ≤ before × 1.10（防守回归线） |
| runs 间稳定性 | p95StdDev >before 2 倍时加跑 `--runs=9` 复测取中位 |

计时阈值为**本地测量门**（记录进 PR），不写成 CI 断言（CI 机器计时抖动大）；CI 功能性等价门 = §6 的引用保持 + 深拷贝契约测试。

### 7.4 常规验证

```bash
npx vitest run          # 全部单测
npm run lint
npm run build           # tsc -b，类型门
npm run test:e2e        # dev 双进程拓扑（先 npm run start:server）
node scripts/ci/structure-guard.mjs   # 以仓库 CI 实际入口为准，本地先跑
```

e2e 重点观察：拖拽/多选拖拽/框选/连接器跟随/undo-redo/复制粘贴（clone 路径）全绿。

---

## 8. 风险与回滚

| 风险 | 概率 | 缓解 | 回滚 |
|------|------|------|------|
| 快速路径判据漏判半归一化/畸形形态 → 陈旧或坏数据渗入 | 低（判据镜像合成条件 + ⓪ 形状校验【v2】+ §6 守卫矩阵逐条覆盖） | documentModelV2.test.ts 半归一化 + null/畸形矩阵；parity 双向锁定 | R01 短路是单表达式：normalizeCanvasNodeV2 改回 `cloneCanvasNodeV2(node)` 即完全复旧，可独立 revert |
| 【v2】clone 语义被快速路径破坏（history/clipboard/persist 共享子对象） | 已消除（cloneNode 切 cloneCanvasNodeV2，入口物理分离） | nodeFactory.test.ts 深拷贝契约 + mutation 隔离断言；§1.5 全仓调用点分类复核 | commit #1 本身零行为变化，revert 场景仅限连带回滚 |
| 引用保持提高 memo 命中率，暴露隐藏 stale-props 假设 | 低 | e2e 冒烟 + 手动拖拽/选择/锁定/隐藏走查 | 同 R01 单点回滚 |
| 隐式依赖"normalize 必产新引用" | 已排除（§1.5 逐调用点分类；zustand 每次产新数组，外层引用照常变化） | canvasDocumentModel.test.ts 锁定新契约 | 同上 |
| adapter 手滑改 fallback 默认值 | 低 | parity 测试 R02 前已绿、R02 后必须仍绿 | R02 独立 commit revert |
| 【v2】bench drag 测的是 pan（假 baseline） | 已消除（切 select 工具 + 拖后位移断言，没动就 throw） | dragNode 内建正确性断言 | 场景独立于 src |
| bench 目标节点 locked/视口外 | 低 | §7.1 备选节点策略 + boundingBox 判空 throw | 同上 |
| MivoCanvas.tsx structure-guard | 低（本文件净负行数） | §4.3 | — |
| undo/redo 语义 | 无变化路径（captureHistory 时机、patch* 调用点未动；history 深拷贝走 cloneNode→cloneCanvasNodeV2 逐字节同旧） | e2e undo 场景 | — |

**总回滚策略**：按 §9 分 5 个独立 commit，任一项可单独 `git revert`，互无编译依赖。

---

## 9. 执行顺序（commit 粒度）【v2】

| # | commit | 内容 | 门 |
|---|--------|------|-----|
| 1 | `test+refactor: parity tests, cloneCanvasNodeV2 split, bench drag scenario` | §3 parity 测试（须绿）+【v2】§1.2 拆出 `cloneCanvasNodeV2`（此时 normalizeCanvasNodeV2 = 直接调用它，**尚无快速路径，零行为变化**）+ `cloneNode` 切到 cloneCanvasNodeV2 +【v2】nodeFactory.test.ts 深拷贝契约测试 + §7.1 canvas-drag bench 动作（含工具切换与位移断言） | vitest 绿；跑 §7.2 BEFORE 基线并存档 JSON（drag 位移断言必须过——证明基线测的是写路径） |
| 2 | `perf(model): normalized fast path in normalizeCanvasNodeV2` | §1.2 谓词（含 ⓪ 形状校验）+ 短路；§6 documentModelV2 追加（幂等/空数组/半归一化/畸形/clone 分岔）+ canvasDocumentModel.test.ts 引用保持 | vitest 全绿（parity + nodeFactory 契约仍绿） |
| 3 | `perf(canvas): single normalize per adapter accessor` | §2 adapter 重构 | vitest 全绿 |
| 4 | `perf(canvas): shared lock primitive + memoized lockedNodeIds` | §4 C03+C04（isLockedWithSection primitive + lockedNodeIdSetFor 导出 + MivoCanvas 删本地版） | vitest 绿 + structure-guard |
| 5 | `refactor(canvas): rename culling rectsIntersect → rectsIntersectInclusive` | §5 C05 | lint/build 绿 |
| 收尾 | — | §7.2 AFTER 测量 → 对照表 + 阈值判定写入 PR 描述；§7.4 全套验证 | 全绿 + 阈值达标 |

非目标（明确不做，防执行漂移）：不动 `src/render/` 任何源文件；不给连接器节点做引用保持；不动 store 层 `isEffectivelyLocked`；不改 bench overall/gate 聚合口径（仍只聚合 pan/zoom）；不做"只归一 moveSet"；不把 `isNodeEffectivelyLocked` 改成内建 Set 的实现。

---

## 【v4 · 执行期裁决】R02b 因 PR #72 语义变化改走精简版（方案 B）

执行 worker 开工核查发现：PR #72（a076953）的 sinkVisualDefaults 已把产品缺省色物化进 projectNode 输出的 fills/strokes（projection.ts:233-277,:311），原 §3 "projection 缺省 [] vs adapter fallback" 的分歧本体已消失，且 projection.test.ts:240-398 两个 describe 块已逐字段锁定 adapter ↔ projection 等价（含空数组+legacy 并存、invisible 回落全套）。

裁决（lead）：
1. R02b 改为**精简版** src/canvas/canvasRenderAdapter.parity.test.ts：只补真实缺口——P7（image 节点 nodeRenderBoxFor transform 字符串 == 由 projectNode.geometry 拼出的同式）、P8（rotation 后缀一致）、注册性断言（projectNode 对 frame/markup 输出 fills/strokes 恒 Array.isArray，不断言内容）+ 头注释文档化"sinkVisualDefaults 已使 fallback 公式冗余，保留作消费端兜底契约"。P1-P6/P4b/P4c/P5b/P6b **不重复测**。
2. **R02（commit #3 adapter 改单次 normalize）的安全网改由 projection.test.ts:240-398 承担**：该组测试在全部 5 个 commit 的每道门都必须绿，等价于原 P1-P6 的作用。
3. §6 documentModelV2 的快速路径幂等测试（含 fills:[]/strokes:[] 空数组四例、畸形字段、半归一化矩阵）**全部保留不变**——那是谓词正确性的锁，与 parity 无关。
4. 原 §3.2 P4 "fills 恒 []" 断言作废（现实是 [synthetic 默认色]），以现状为准。
