# MivoCanvas Demo — 现状与关键文件地图

> 快照日期：2026-07-02 | 分支 `demo/canvas-ai` @ `8fa20b9` | 交接文件：`docs/demo/review/context-handoff-2026-07-02.md`
> 本文件是 demo 的常驻索引（现状 + 文件位置）。模块→文件映射据 commit + 目录结构整理，未逐一开文件核对每个归属。

---

## 一、现状（Current Status）

### 分支 / 提交 / PR
- 本地 & 远端分支：`demo/canvas-ai` @ `8fa20b9`（本地 = `origin/demo/canvas-ai`，已推送）。
- PR：**#8 OPEN / draft / base=main / head=demo/canvas-ai** → https://github.com/kirozeng/MivoCanvas/pull/8（**未合并，main 未动**）。
- remote `origin` = `github.com/kirozeng/MivoCanvas`（私有仓，owner=kirozeng，PraiseZhu 有 push 权限）。

### 模块完成度（M0–M6，均已 commit）
| 模块 | 内容 | commit | 状态 |
|---|---|---|---|
| M0 | 图像代理（/api/mivo/*） | `4e174c2` | ✅ 已交付 |
| M1 | 主生成对话（文生图 / 图生图） | `a687e4f` | ✅ 闭环 |
| M2 | mask 编辑 overlay（点选/框选/涂抹） | `e3c479e` | ✅ 前端闭环（见 P1） |
| M4 | Eagle 标签素材抽屉（单/多选复制到画布） | `72c8047` | ✅ 闭环 |
| M5 | 衍生图模型（节点 + 派生 edge） | `0e5e597` | ✅ 已交付 |
| M6 | 底部 AI 操作栏 | `9a75216` | ✅ 已交付 |
| — | 4 个后续修复（生成/资源/mask 拖拽/e2e） | `c4d9ac5`/`5e6b8bf`/`6160c38`/`b97249b` | ✅ |
| — | 本轮 P1/P2/P3 修复 | `8fa20b9` | ✅ 已修+自验 |

> 提交历史**无独立 M3 commit**（疑编号合并，未确认）。

### 本轮验证 + 修复结论
- 两个 Orca worker 真实环境走查 → 合并出 3 个 finding → 已修复（`npm run build` + `npm run test:e2e` 均通过）。
- **P1（局部重绘 edit 超时）= MITIGATED_NOT_FIXED**：只把超时窗口放宽（代理 180s / 客户端 185s），**edit 上游本身仍慢 ~55–98s**，非提速。深做是下一步重点。
- P2（Eagle 多选粘贴重叠）、P3（mask 编辑时 AI panel 拥挤）= 已修。

### 未提交项（不影响功能完整性，不在分支 commit 内）
- `docs/demo/PIPELINE.md`（会话前已改，未提交）
- 未跟踪：`_tmp/`（调试截图，`.gitignore` **未覆盖**，勿 `git add .`）、`docs/demo/review/*.md`（部分验证报告）

### 运行时
- dev server（本会话）：`http://127.0.0.1:5175/`（可能仍在跑，孤儿进程；停用 `lsof -nP -iTCP:5175 -sTCP:LISTEN` 找 PID kill）
- 命令：`npm run dev` / `npm run build`（tsc -b && vite build）/ `npm run lint` / `npm run preview` / `npm run test:e2e`

---

## 二、关键文件地图

### 入口 / 应用外壳
| 文件 | 作用 |
|---|---|
| `src/main.tsx` | React 入口 |
| `src/App.tsx` | 应用根组件（含 P3：进 mask 编辑收起 AI panel 的逻辑） |
| `src/App.css` | 全局样式 / 设计 token（`--charcoal`/`--moss`/`--line` 等） |
| `src/index.css` | 基础样式 |

### 画布层 `src/canvas/`
| 文件 | 作用 |
|---|---|
| `MivoCanvas.tsx` | 画布主组件（LeaferJS 挂载、编排；含 P3 `onMaskEditActiveChange`） |
| `ImageMaskEditOverlay.tsx` | **局部重绘 mask overlay**（点选/框选/涂抹，regionCount/draftRef）— 已验证 OK，勿轻动 |
| `imageMaskGeometry.ts` | mask 选区几何计算 |
| `useCanvasInteractionController.ts` | 画布交互控制器 |
| `canvasInteraction.ts` / `canvasGeometry.ts` / `connectorGeometry.ts` / `textGeometry.ts` | 交互 / 几何 / 连线 / 文本几何 |
| `CanvasAiActionBar.tsx` | **M6 底部 AI 操作栏** |
| `CanvasNodeView.tsx` | 节点渲染视图 |
| `CanvasContextMenu.tsx` / `NodeActionMenu.tsx` / `SelectionQuickToolbar.tsx` / `CanvasToolDock.tsx` / `TextFormatToolbar.tsx` | 各类菜单 / 工具条（局部重绘触发入口在这几处） |
| `ImageCropOverlay.tsx` | 图像裁剪 overlay |
| `canvasToolHandlers.ts` / `canvasToolRegistry.ts` | 工具处理器 / 注册表 |
| `actions/canvasActionModel.ts` / `canvasActionTypes.ts` / `canvasSelectionModel.ts` / `useCanvasActionRuntime.ts` | 画布动作模型 / 类型 / 选择模型 / 运行时 |
| `nodeTypes/canvasNodeRegistry.ts` / `nodeCapabilities.ts` | 节点类型注册 / 能力 |

### 状态 `src/store/`
| 文件 | 作用 |
|---|---|
| `canvasStore.ts` | **Zustand 主 store**（节点/edge、M5 衍生 sourceNodeId、P2 `pasteClipboardAssets` 网格排布）— 高危共享文件 |
| `aiCanvasWorkflow.ts` | **M1 AI 生成工作流**编排 |
| `demoScenes.ts` | demo 预设场景 |
| `mockGeneration.ts` | 生成 mock（测试/降级用） |

### 应用面板 `src/app/`
| 文件 | 作用 |
|---|---|
| `AIToolPanel.tsx` | **M1 右侧 AI 生成面板**（主输入框、文生图/图生图入口） |
| `TaskQueue.tsx` | 生成任务队列 |
| `LibraryWorkspace.tsx` | **M4 素材库工作区**（Eagle 抽屉宿主） |
| `assetLibraryModel.ts` | **M4 素材库数据模型** |
| `InspectorPanel.tsx` / `TopBar.tsx` / `ProjectSidebar.tsx` / `ProjectSidebarControls.tsx` | 检查器 / 顶栏 / 侧栏 |

### 库 `src/lib/`
| 文件 | 作用 |
|---|---|
| `mivoImageClient.ts` | **图像 API 客户端**：`generateMivoImage`（文生图/图生图）、`editMivoImage`（局部重绘，超时 185s）、`assetBlobForNode` |
| `canvasImageSource.ts` / `useResolvedAssetUrl.ts` | 图像源解析 / 资源 URL hook |
| `canvasAssetImport.ts` / `canvasAssetDrag.ts` | **M4 素材导入 / 拖拽** |
| `assetStorage.ts` / `assetDownload.ts` | 资源存储 / 下载 |
| `canvasArchive.ts` / `snapshotValidation.ts` | 画布存档 / 快照校验 |
| `demoImages.ts` / `imageSizing.ts` / `MarkdownPreview.tsx` | demo 图 / 尺寸计算 / Markdown 渲染 |

### 类型 `src/types/`
| 文件 | 作用 |
|---|---|
| `mivoCanvas.ts` | 画布/节点/edge 核心类型（M5 衍生模型） |
| `generation.ts` | 生成请求/响应类型 |

### 运行时 / 配置（`vite.config.ts` 内含 Node 中间层）
- **API 路由**（均在 `vite.config.ts` 的 dev middleware）：
  - `POST /api/mivo/generate` — 文生图/图生图（超时 `mivoUpstreamTimeoutMs`≈110s）
  - `POST /api/mivo/edit` — **局部重绘 mask 编辑**（超时 `mivoEditUpstreamTimeoutMs`=180s，本轮 P1 放宽）
  - `/api/mivo/local-assets` `/api/mivo/local-assets/:id` — 本地素材目录
  - `/api/mivo/eagle/status|folders|tags|assets` + `/eagle/assets/:id/thumbnail|file` — **M4 Eagle 接入**
  - `/api/mivo/pinterest/status` — Pinterest 状态（占位）
- **环境变量**：
  - `MIVO_EAGLE_API_URL`（默认 `http://127.0.0.1:41595`）
  - `MIVO_ASSET_DIR`（本地素材目录，默认 `~/Desktop/Images`）
  - `MIVO_IMAGE_API_KEY`（generate/edit 必需；**仅在 Node 中间层读取，隔离于 Vite client**）
- **脚本**：`scripts/e2e-smoke.mjs`（Playwright e2e，`npm run test:e2e`）、`scripts/e2e-helpers.mjs`

### 文档 `docs/demo/`
| 路径 | 作用 |
|---|---|
| `PIPELINE.md` | 交付流水线（P1–P7） |
| `plan/master-plan.md` + `plan/step-M0/M1/M2/M4/M5/M6.md` | 主计划 + 各模块步骤计划 |
| `research-mivoserver.md` / `research-open-design.md` / `research-toolbar.md` / `research-toolbox.md` | 前期调研 |
| `reuse-inventory.md` | 复用清单 |
| `review/context-handoff-2026-07-02.md` | **本会话交接文件** |
| `review/full-chain-ui-walkthrough.md` | 广度 M1–M6 走查（APPROVED，22 截图） |
| `review/code-review-run.md` / `code-review-quality.md` / `ui-audit.md` / `plan-review-*.md` / `e2e-smoke-report.md` | 各轮 review / 审计产物 |
| `DEMO-STATUS.md` | 本文件（现状 + 文件地图索引） |

### 验证证据（未跟踪，`_tmp/`，勿入 git）
| 路径 | 内容 |
|---|---|
| `_tmp/core-demo-validation-2026-07-02_03-23-00/` | 核心 4 功能验证（含 P1 超时截图 + result.json） |
| `_tmp/fix-validation-2026-07-02T04-34-37/` + `_tmp/fix-validation-p2-2026-07-02T04-39-01/` | 修复轮验证证据 |
| `_tmp/edit-repro-2026-07-02T04-17-40-same-size/` + `_tmp/edit-repro-...-generated-source/` | P1 根因：edit 上游耗时 54.6s/98s/69.1s |

### 静态资源
- `public/demo-assets/courage-1.jpg` / `courage-2.jpg` / `courage-3.jpg` — demo 参考图（图生图可用）

---

## 三、下一步 / 待办
- **局部重绘深做**：在独立分支（base=`demo/canvas-ai`）细做，核心解决 edit 上游 ~1min 慢的体验（进度反馈/加速/重试），**别只调超时数字**；勿动已验证的 mask 前端交互。
- `/simplify` 未对本轮 5 个修复文件跑过（`NOT_RUN`）。
- CLAUDE.md 有条过时的"origin 不可 push"约定，与现状（私有仓+有写权限+已 push）矛盾，待授权修正。
- `_tmp/` 建议加入 `.gitignore`。
