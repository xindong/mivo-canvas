# MivoCanvas Development Record

本文档记录当前分支上的关键开发决策和实现进展，方便团队成员、未来维护者和 AI agent 快速理解为什么这么改。

当前分支：

```text
codex/mivo-document-model-v2
```

## 2026-07-01: Document Model v2 Foundation

Commit:

```text
d990211 feat: add document model v2 foundation
```

背景：

- 项目原先的 `MivoCanvasNode` 是 demo 阶段的扁平结构。
- 几何、资源、样式、关系、AI 工作流字段都散落在节点顶层。
- 这种结构短期方便 UI，但不利于 AI 命令、导入导出、未来 renderer adapter、auto layout 和协作记录。

本次目标：

- 不重写当前 DOM/SVG 画布。
- 不强行迁移所有 UI。
- 先加一个兼容式 v2 语义层，让旧 UI 继续工作，同时让数据开始结构化。

完成内容：

- 新增 v2 字段：
  - `transform`
  - `fills`
  - `strokes`
  - `effects`
  - `layout`
  - `constraints`
  - `asset`
  - `relations`
- 新增 `src/model/documentModelV2.ts`：
  - `normalizeCanvasNodeV2`
  - `normalizeCanvasNodesV2`
  - `setNodeTransform`
  - `setNodeFills`
  - `setNodeStrokes`
  - `setNodeAsset`
  - `setNodeRelations`
- 新增 `src/canvas/canvasRenderAdapter.ts`：
  - 把 v2 `transform/fills/strokes` 转成 DOM 渲染样式。
  - 让 `transform.rotation` 能进入画布呈现。
- 接入点：
  - `src/store/demoScenes.ts`
  - `src/store/canvasStore.ts`
  - `src/canvas/CanvasNodeView.tsx`

验证：

```text
npm run test:unit
npm run build
npm run lint
```

结果：

- 单元测试通过。
- build 通过。
- lint 通过。
- Vite 有 chunk size warning，不影响构建。

## 2026-07-01: Snapshot v2 And Command Bridge

Commit:

```text
3b40d78 feat: stabilize snapshot v2 command bridge
```

背景：

- 用户确认当前仍在开发期，没有需要兼容的旧文件。
- 因此数据格式不需要做旧版 archive/snapshot 迁移。
- 更适合采用 forward-only v2 策略，尽早让存储边界清晰。

本次目标：

- 将 `MivoCanvasSnapshot.version` 推进到 `2`。
- 让 archive 导出、import validation、store snapshot、demo snapshot 都经过统一规范化。
- 让关键 AI 结果节点创建路径走 command helper，而不是在 store 里重复手写字段。

完成内容：

- 新增 `src/model/canvasSnapshotModel.ts`：
  - `normalizeCanvasSnapshotV2`
  - 输出固定 `version: 2`
  - 逐节点执行 v2 normalize
  - 以当前 legacy 几何、资源、关系字段为准修复 stale v2 镜像
  - 保留 `transform.rotation`
- 新增 `src/model/aiCanvasCommands.ts`：
  - `createAiResultNode`
  - 统一生成 AI result 节点的 `generation`
  - 统一同步 `parentIds`
  - 统一同步 `aiWorkflow`
  - 统一同步 `asset`
  - 统一同步 `relations`
- 更新 archive/snapshot 路径：
  - `src/lib/canvasArchive.ts`
  - `src/lib/snapshotValidation.ts`
  - `src/store/canvasStore.ts`
  - `src/store/demoScenes.ts`
- 更新 AI 生成路径：
  - `src/store/mockGeneration.ts`
  - `src/store/canvasStore.ts`

验证：

```text
npm run test:unit
npm run build
npm run lint
```

结果：

- 4 个测试文件通过。
- 16 个测试通过。
- build 通过。
- lint 通过。
- Vite 有 chunk size warning，不影响构建。

## 当前数据策略

当前采用兼容式双写：

- legacy 字段仍服务现有 UI 和交互。
- v2 字段服务未来 renderer、AI command、导入导出和插件。
- 保存和导入时通过 normalize 自愈字段不同步。

事实来源暂定：

- 几何：`x/y/width/height` 是当前事实来源，`transform` 是结构化镜像，`rotation` 只存在于 `transform`。
- 资源：`assetUrl` 等 legacy asset 字段是当前事实来源，`asset` 和 image fill 是结构化镜像。
- 关系：`parentIds/sectionId/connector*/aiWorkflow` 是当前事实来源，`relations` 是结构化镜像。

这个选择是为了降低迁移风险。等 UI 和交互全面改到 v2 command layer 后，可以把 v2 字段升级为唯一事实来源。

## 已明确不做

当前阶段没有做：

- 旋转 UI 控件
- 旋转后的 hit testing
- 旋转后的 resize
- 完整 auto layout
- Canvas/WebGL renderer 替换
- 旧版本 archive 兼容迁移
- 协作/CRDT 操作日志

## 后续建议

短期：

1. 给 v2 数据结构补更多示例和 fixture。
2. 把更多 store mutation 改成 command helper。
3. 增加 archive round-trip 测试。
4. 在 Inspector 中展示 v2 调试信息。

中期：

1. 引入操作级 command record。
2. 将 AI context snapshot 改为优先读取 `relations`。
3. 将 renderer adapter 扩展到 effects、blend mode、image fill scale mode。
4. 设计 auto layout MVP。

长期：

1. 从兼容式双写过渡到 v2 单一事实来源。
2. 引入组件、变体、约束布局。
3. 评估 Canvas/WebGL/CanvasKit 渲染路径。
4. 为插件和 agent 暴露稳定 document API。
