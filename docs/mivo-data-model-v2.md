# Mivo Data Model v2

本文档是 MivoCanvas 当前开发期的数据结构规范，面向后续开发者、设计工程师、AI agent、导入导出工具和未来插件作者。

当前项目没有需要兼容的历史生产文件，因此数据格式采用 forward-only 策略：归档和快照都以 v2 为当前格式，不再为旧版本文件做迁移分支。代码仍会在保存、导入和替换快照时做规范化，目的是修复开发过程中可能出现的字段不同步。

## 版本

### Archive

`MivoCanvasArchive` 是导出和复制画布时使用的外层容器：

```ts
type MivoCanvasArchive = {
  kind: 'mivo-canvas-archive'
  version: 2
  snapshot: MivoCanvasSnapshot
  assets: SerializedCanvasAsset[]
}
```

规则：

- `kind` 必须是 `mivo-canvas-archive`。
- `version` 当前固定为 `2`。
- `snapshot` 必须是 `MivoCanvasSnapshot version: 2`。
- `assets` 只包含 IndexedDB 中的本地导入素材序列化数据。公共 demo 路径如 `/demo-assets/...` 不进入 `assets`。

相关代码：

- `src/lib/canvasArchive.ts`
- `src/lib/snapshotValidation.ts`

### Snapshot

`MivoCanvasSnapshot` 是画布状态的核心保存格式：

```ts
type MivoCanvasSnapshot = {
  version: 2
  sceneId: CanvasId
  nodes: MivoCanvasNode[]
  tasks: CanvasTask[]
  selectedNodeId?: string
  selectedNodeIds?: string[]
}
```

规则：

- `version` 当前固定为 `2`。
- `nodes` 中每个节点都应经过 `normalizeCanvasNodeV2` 或 `normalizeCanvasSnapshotV2`。
- `tasks` 只记录任务状态和关联节点 ID，不直接持有节点数据。
- `selectedNodeId` 是主选中对象；`selectedNodeIds` 是多选集合。

相关代码：

- `src/model/canvasSnapshotModel.ts`
- `src/store/canvasStore.ts`
- `src/store/demoScenes.ts`

## 节点模型

`MivoCanvasNode` 当前是兼容式模型：保留旧 UI 正在使用的 legacy 字段，同时新增 v2 语义字段。

### Legacy 字段

这些字段仍被当前 UI、交互和部分几何逻辑直接读取：

```ts
{
  id: string
  type: CanvasNodeType
  title: string
  x: number
  y: number
  width: number
  height: number
  assetUrl?: string
  assetMimeType?: string
  assetOriginalName?: string
  assetSizeBytes?: number
  parentIds?: string[]
  sectionId?: string
  targetNodeId?: string
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  aiWorkflow?: CanvasAiWorkflow
}
```

### v2 语义字段

这些字段是后续渲染器、AI 命令、导入导出和插件系统应该优先理解的结构：

```ts
{
  transform?: CanvasNodeTransform
  fills?: CanvasNodeFill[]
  strokes?: CanvasNodeStroke[]
  effects?: CanvasNodeEffect[]
  layout?: CanvasNodeLayout
  constraints?: CanvasNodeConstraints
  asset?: CanvasNodeAssetRef
  relations?: CanvasNodeRelations
}
```

## 事实来源

当前阶段采用双写模型。因为画布交互仍大量依赖 legacy 字段，所以事实来源规则如下：

### 几何

当前事实来源：

- `x`
- `y`
- `width`
- `height`

同步目标：

- `transform.x`
- `transform.y`
- `transform.width`
- `transform.height`

`transform.rotation` 是 v2 字段独有，当前没有 legacy 对应字段。规范化时应保留已有 `transform.rotation`，没有时补 `0`。

### 资源

当前事实来源：

- `assetUrl`
- `assetMimeType`
- `assetOriginalName`
- `assetSizeBytes`

同步目标：

- `asset`
- image 类型节点的 `fills[]` image fill

### 关系

当前事实来源：

- `parentIds`
- `sectionId`
- `targetNodeId`
- `connectorStart`
- `connectorEnd`
- `aiWorkflow`

同步目标：

- `relations`

### 视觉样式

当前事实来源仍按节点类型分布在 legacy 字段中：

- frame: `sectionFillColor`, `sectionBorderColor`, `sectionBorderWidth`, `sectionBorderStyle`
- markup: `markupFillColor`, `markupStrokeColor`, `markupStrokeWidth`, `markupStrokeStyle`, `markupOpacity`
- text: `textColor`, `fontSize`, `fontWeight`, `textAlign`

同步目标：

- `fills`
- `strokes`

## 核心字段

### transform

```ts
type CanvasNodeTransform = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}
```

说明：

- 坐标为画布文档空间坐标。
- `rotation` 单位为 degree。
- 当前渲染层已经能消费 `rotation`，但没有旋转 UI 和旋转感知交互。

### fills

```ts
type CanvasNodeFill =
  | {
      id: string
      kind: 'solid'
      color: string
      opacity: number
      visible: boolean
    }
  | {
      id: string
      kind: 'image'
      assetUrl: string
      opacity: number
      visible: boolean
      scaleMode: 'fill' | 'fit' | 'crop' | 'tile'
    }
```

说明：

- `fills` 是有序数组，后续可支持多层填充。
- image 节点当前会生成一个 `kind: 'image'` 的 fill。
- frame 和 markup 当前会生成 `kind: 'solid'` 的 fill。

### strokes

```ts
type CanvasNodeStroke = {
  id: string
  color: string
  width: number
  style: 'solid' | 'dashed'
  opacity: number
  visible: boolean
}
```

说明：

- 当前主要由 frame 和 markup 使用。
- 后续可以扩展 stroke alignment、cap、join 等字段。

### asset

```ts
type CanvasNodeAssetRef = {
  url: string
  mimeType?: string
  originalName?: string
  sizeBytes?: number
}
```

说明：

- `url` 可以是公共路径，也可以是 IndexedDB 导入素材 URL。
- `asset` 是对 legacy asset 字段的结构化镜像。

### relations

```ts
type CanvasNodeRelations = {
  parentIds?: string[]
  sectionId?: string
  targetNodeId?: string
  connectorStart?: ConnectorBinding
  connectorEnd?: ConnectorBinding
  aiWorkflow?: CanvasAiWorkflow
}
```

说明：

- `relations` 是关系数据的结构化镜像。
- AI 结果节点必须同时写入 `aiWorkflow` 和 `relations.aiWorkflow`。
- 连接线节点使用 `connectorStart` 和 `connectorEnd` 表达端点绑定。

### aiWorkflow

```ts
type CanvasAiWorkflow = {
  kind: 'slot' | 'annotation' | 'result'
  status?: 'empty' | 'queued' | 'generating' | 'ready' | 'failed'
  operation?: AiWorkflowOperation
  prompt?: string
  sourceNodeIds?: string[]
  anchorNodeId?: string
  annotationNodeId?: string
  slotId?: string
  placement?: 'slot' | 'right' | 'left' | 'below'
  createdAt?: number
}
```

说明：

- `sourceNodeIds` 记录 AI 输入来源。
- `anchorNodeId` 记录布局锚点。
- `annotationNodeId` 和 `slotId` 记录特定工作流上下文。
- AI 结果节点应通过 `createAiResultNode` 创建。

## 规范化流程

### Node Normalize

使用：

```ts
normalizeCanvasNodeV2(node)
normalizeCanvasNodesV2(nodes)
```

职责：

- 从 legacy 几何字段补 `transform`。
- 从 asset 字段补 `asset` 和 image fill。
- 从 frame/markup legacy 样式补 `fills` 和 `strokes`。
- 从关系字段补 `relations`。
- clone 数组和嵌套对象，避免共享引用。

### Snapshot Normalize

使用：

```ts
normalizeCanvasSnapshotV2(snapshot)
```

职责：

- 强制输出 `version: 2`。
- 逐个节点执行 v2 规范化。
- 修复 stale v2 字段：以当前 legacy 几何、资源、关系字段为准重新生成 v2 镜像。
- 保留已有 `transform.rotation`。
- clone tasks 和 selection 数组。

### Command Helpers

使用：

```ts
setNodeTransform(node, patch)
setNodeFills(node, fills)
setNodeStrokes(node, strokes)
setNodeAsset(node, asset)
setNodeRelations(node, relations)
createAiResultNode(input)
```

规则：

- 命令函数必须 immutable，不能修改输入对象。
- 命令函数必须同步 legacy 字段和 v2 字段。
- 新 AI 结果节点必须通过 `createAiResultNode`，不要在 store 中手写 `parentIds / aiWorkflow / relations / asset / fills`。

## 示例

一个普通 image 节点：

```json
{
  "type": "image",
  "status": "ready",
  "id": "ref-hero",
  "title": "Courage Study 01",
  "x": 90,
  "y": -53,
  "width": 204,
  "height": 362,
  "assetUrl": "/demo-assets/courage-1.jpg",
  "fills": [
    {
      "id": "ref-hero-image-fill",
      "kind": "image",
      "assetUrl": "/demo-assets/courage-1.jpg",
      "opacity": 1,
      "visible": true,
      "scaleMode": "fill"
    }
  ],
  "asset": {
    "url": "/demo-assets/courage-1.jpg"
  },
  "transform": {
    "x": 90,
    "y": -53,
    "width": 204,
    "height": 362,
    "rotation": 0
  }
}
```

一个 AI result 节点应包含：

```json
{
  "type": "image",
  "status": "ready",
  "id": "result-1",
  "title": "AI result from Source",
  "x": 360,
  "y": 20,
  "width": 300,
  "height": 200,
  "assetUrl": "/result.png",
  "parentIds": ["source-1"],
  "aiWorkflow": {
    "kind": "result",
    "status": "ready",
    "operation": "beside-generation",
    "prompt": "make it brighter",
    "sourceNodeIds": ["source-1"],
    "anchorNodeId": "source-1",
    "placement": "right",
    "createdAt": 12345
  },
  "relations": {
    "parentIds": ["source-1"],
    "aiWorkflow": {
      "kind": "result",
      "status": "ready",
      "operation": "beside-generation",
      "prompt": "make it brighter",
      "sourceNodeIds": ["source-1"],
      "anchorNodeId": "source-1",
      "placement": "right",
      "createdAt": 12345
    }
  }
}
```

## 扩展规则

新增节点能力时优先按这个顺序落地：

1. 在 `src/types/mivoCanvas.ts` 定义类型。
2. 在 `src/model/documentModelV2.ts` 增加 normalize/command 同步逻辑。
3. 在 `src/model/canvasSnapshotModel.ts` 确认保存自愈策略。
4. 在 `src/canvas/canvasRenderAdapter.ts` 增加渲染适配。
5. 在 store 或 UI 中调用 command helper，不手写散落字段。
6. 增加单元测试覆盖字段同步。

## 当前限制

- 旋转只有数据和渲染能力，没有 UI 控件。
- 旋转后的 hit testing、resize、selection bounds 仍未旋转感知。
- auto layout 只有类型占位，还没有布局引擎。
- effects 只有类型占位，还没有 UI 和渲染完整实现。
- component/variant 体系尚未定义。
