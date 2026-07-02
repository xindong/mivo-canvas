# MivoCanvas 代码清单（CODE-INVENTORY）

> 快照：2026-07-02 | 源码 `8fa20b9`（此刻检出于 `demo/improve-hud`，**内容与 `demo/canvas-ai @ 8fa20b9` 完全一致**）
> 生成方式：3 个 gpt-5.5 worker 按层分工只读盘点，本文件为合成总清单。
> 详细逐文件清单见文末「分层详情」三份 part。
> 验证边界：本轮**全部只读源码盘点**，未重跑 `npm run build` / `npm run test:e2e`；构建/e2e 通过、真实交互结论来自权威文档（`DEMO-STATUS.md`、`context-handoff-2026-07-02.md`）与前几轮 worker 走查，**本轮未现场复验**。

---

## 一、整体结构

### 技术栈
React 19 + React-DOM · Vite 8（dev server + Node 中间层）· TypeScript 6 · Zustand 5（状态）· LeaferJS（画布 host）· react-markdown + remark-gfm · lucide-react · Playwright（e2e smoke）。

### 目录骨架
```
src/
├── main.tsx / App.tsx        # 入口 + 应用外壳编排（App 含 P3 收起 AI panel）
├── app/                      # 面板层：AIToolPanel(M1) / LibraryWorkspace(M4) / TaskQueue / Inspector / TopBar / ProjectSidebar
├── canvas/                   # 画布层：MivoCanvas + 交互控制器 + 工具体系 + overlays(mask/crop) + 菜单 + 几何 + actions/
│   ├── nodeTypes/            # 节点类型注册 + 能力
│   └── actions/              # 动作模型 / 选择模型 / runtime
├── store/                    # canvasStore(主) / aiCanvasWorkflow / demoScenes / mockGeneration
├── lib/                      # mivoImageClient(图像API) + 素材导入/存储/归档/下载 + Markdown
└── types/                    # mivoCanvas(领域核心) / generation(API 类型)
vite.config.ts                # ★ 全部 /api/mivo/* Node 中间层都在这里（无独立生产后端）
scripts/                      # e2e-smoke.mjs / e2e-helpers.mjs（Playwright，route mock 图像 API）
```

### 状态与数据流
- **状态中心**：Zustand `useCanvasStore`（`src/store/canvasStore.ts`），持久化 localStorage `mivo-canvas-demo`（persist v7）。核心数据模型 `CanvasDocument{ nodes, edges, tasks, selection }`；`MivoCanvasNode` 承载图像/文本/批注/AI slot/导入文件 + 生成元信息 `generation` + 工作流 `aiWorkflow` + M5 衍生 `sourceNodeId`。
- **图像生成/编辑主链路**：
  ```
  UI action → useCanvasStore(generateBesideNode/IntoAiSlot/generateImageEdit/commitGenerationResult)
    → src/lib/mivoImageClient.ts (generateMivoImage / editMivoImage)
    → vite.config.ts dev middleware  /api/mivo/generate | /api/mivo/edit
    → 上游 llm-proxy.tapsvc.com/v1/images/{generations|edits}
    → images[].b64 → saveGeneratedAsset → 新 image node + CanvasEdge + 可视衍生箭头
  ```
  `MIVO_IMAGE_API_KEY` 只在 Node 中间层读取，**不暴露给浏览器 client**。
- **素材链路（Eagle / 本地）**：`LibraryWorkspace` → `/api/mivo/eagle/*` 或 `/api/mivo/local-assets` → 规范化为 `AssetItem` → 双击/拖拽/复制 → `importImageUrlToCanvas` / `pasteClipboardAssets` → IndexedDB(`mivo-asset:`) → 画布 image node。

### 运行时依赖 / 环境变量
- `MIVO_IMAGE_API_KEY`（generate/edit 必需）· `MIVO_ASSET_DIR`（默认 `~/Desktop/Images`）· `MIVO_EAGLE_API_URL`（默认 `http://127.0.0.1:41595`）
- 超时：generate 上游 110s；edit 上游 180s / 客户端 185s（P1 放宽）。

---

## 二、各功能代码现状矩阵

> 真实 = 走真实上游 API；mock = 假数据；原型 = 静态占位。闭环：✅通 / ⚠️通但有约束 / ❌未闭环。

| 功能 | 模块 | 代码现状 | 真实/mock | 关键落点 | 闭环 |
|---|---|---|---|---|---|
| 图像代理 | M0 | 完成，key 隔离中间层 | 真实（dev） | `vite.config.ts` | ✅ dev only |
| 文生图（纯 prompt→generate） | M1 | 完成 | **真实** | AIToolPanel→store→`generateMivoImage`→`/api/mivo/generate` | ✅ |
| 图生图（源图/参考图→edit） | M1 | 完成 | **真实** | AIToolPanel(参考图)→store→`editMivoImage`→`/api/mivo/edit` | ✅ |
| **局部重绘（mask 二改）** | M2 | 前端交互**已验证正确**；上游 edit 慢 ~55–98s | 真实，**P1 MITIGATED_NOT_FIXED** | `ImageMaskEditOverlay`+`imageMaskGeometry`→`submitMaskEdit`→`editMivoImage`(180s) | ⚠️ 链路通、上游慢、**无真实进度/取消/重试** |
| 衍生模型（node/edge/sourceNodeId） | M5 | 完成，数据骨架 + 可视箭头闭环 | 真实+mock 并存 | `commitGenerationResult`/`syncDerivationEdgeNodes`+`types/mivoCanvas` | ✅ |
| 变体 variation | M1 周边 | 半成品 | **mock** | `store.generateVariations`→`mockGenerationAdapter` | ⚠️ 非真实模型 |
| 标注生成 annotation | M1 周边 | 半成品 | **mock/demo** | `store.generateFromAnnotation` | ⚠️ 非真实模型 |
| Eagle 素材抽屉（读图/单选·多选复制到画布） | M4 | 完成 | 真实（dev middleware） | `LibraryWorkspace`+`assetLibraryModel`+vite eagle 路由 | ✅ dev only |
| 本地素材目录 | M4 周边 | 完成，含 root 边界校验 | 真实（dev） | `/api/mivo/local-assets(/:id)` | ✅ dev only |
| 素材导入/拖拽/剪贴板粘贴 | — | 完成 | 真实 | `canvasAssetImport`+`canvasAssetDrag`+`assetStorage` | ✅ |
| 多选粘贴排布（P2） | — | 已修（≤3 列网格） | — | `canvasStore.pasteClipboardAssets` | ✅ |
| 底部 AI 操作栏 | M6 | 完成 | — | `CanvasAiActionBar` | ✅ |
| mask 时收起 AI panel（P3） | — | 已修 | — | `MivoCanvas.onMaskEditActiveChange`+`App.tsx` | ✅ |
| 画布工具/选择/连线/文本 | — | 源码闭环，未 UI 复验 | — | `useCanvasInteractionController`+`canvas*` | ✅（未复验） |
| 图像裁剪 crop | — | **显示裁剪**，不产新像素 | — | `ImageCropOverlay`+`store.cropImageNode` | ⚠️ |
| 画布 JSON 归档/导入 | — | 完成 | 真实 | `TopBar`+`canvasArchive`+`snapshotValidation` | ✅ |
| Pinterest | — | 原型占位 | **prototype** | `/api/mivo/pinterest/status` | ❌ |
| Plugins / Skills | — | 静态列表原型 | **静态** | `LibraryWorkspace` | ❌ |

---

## 三、跨层关键风险 / 半成品（去重汇总）

1. **P1：局部重绘 edit 上游本身慢（~55–98s），仅放宽超时窗口（180/185s），非提速**。前端只有 `重绘中...` 文案，无真实进度、取消可见反馈、重试策略 —— 局部重绘"细做"的核心命题。
2. **整个 API 层（generate/edit/eagle/local/pinterest）只活在 `vite.config.ts` dev middleware，无独立生产后端** —— 当前是 demo/dev 形态，生产部署路径未定义。
3. **多处 mock/原型**：variation & annotation 走 mock、Pinterest 是 prototype、Plugins/Skills 静态、AIToolPanel 部分按钮与模型 select 是 UI 占位。
4. **`import` 工具半成品死分支**：`canvasActionModel.importAssetAtContext` 回退 `setTool('import')`，但 `canvasToolRegistry` 未定义 import 工具。
5. **`useCanvasInteractionController.ts` 高耦合热点**：mask/paste/keyboard/text/markup/viewport 全在一个文件，改任一链路易互相影响。
6. **Eagle 原图定位靠 thumbnail 目录 + name/ext 推断**，Eagle 库结构变动可能失效。
7. **crop 是显示裁剪、不产新像素**：若 AI 需按裁剪后像素作输入，需确认 `assetBlobForNode`/`readCanvasImageBlob` 是否按 `imageCrop` 输出。
8. `imageMaskGeometry.buildEditMaskBlob` 有未使用的 `imageCrop` 参数（非 bug，但易误导）。
9. 本轮全部只读盘点，**未重跑 build/e2e**；如需发布验收需重新执行 `npm run build` + `npm run test:e2e`。

---

## 四、分层详情（逐文件清单）

| Part | 覆盖范围 | 文件 |
|---|---|---|
| 架构 + 状态 + 生成/编辑 API 链路 | main/App、store/*、types/*、mivoImageClient、vite 中间层(generate/edit)、构建/e2e 脚本 | `docs/demo/inventory/inv-arch.md` |
| 画布引擎 + 交互 + 工具 + overlays | `src/canvas/**` 全部（含 mask/crop overlay、交互控制器、工具体系、菜单、几何、actions） | `docs/demo/inventory/inv-canvas.md` |
| 应用面板 + 素材库/Eagle + 资源 lib | `src/app/**`、`src/lib/*`（除 mivoImageClient）、vite 中间层(eagle/local/pinterest) | `docs/demo/inventory/inv-app-assets.md` |

---

## 五、局部重绘"细做"专用索引（给拆分分支的同事）

- **edit API 路径（要改这里）**：`src/lib/mivoImageClient.ts`(editMivoImage/超时) · `vite.config.ts`(proxyMivoEdit/超时/契约)
- **mask 前端（已验证 OK，勿轻动）**：`src/canvas/ImageMaskEditOverlay.tsx` · `imageMaskGeometry.ts` · `useCanvasInteractionController.ts`
- **提交/落点/衍生**：`MivoCanvas.submitMaskEdit` · `store.commitGenerationResult`/`syncDerivationEdgeNodes` · `types/mivoCanvas.ts`
- **触发入口**：`CanvasAiActionBar`(M6) · `NodeActionMenu` · `SelectionQuickToolbar`(AI Edit→Select area) · `canvas/actions/canvasActionModel.ts`
- **核心命题**：edit 上游 ~1min 慢的体验（真实进度/可取消/重试），不是继续调超时数字。
