GD_REVIEW_DECISION: APPROVED

# UI 保真 + 状态完整性审计

审计证据：
- 使用现有 dev server：`curl -I http://127.0.0.1:5173/` 返回 200，未启动第二个 dev。
- 截图证据：`/tmp/mivo-ui-audit-initial.png`、`/tmp/mivo-ui-audit-mask.png`、`/tmp/mivo-ui-audit-eagle.png`、`/tmp/mivo-ui-audit-lightbox.png`。
- 代码范围：`src/App.tsx`、`src/App.css`、`src/app/AIToolPanel.tsx`、`src/app/LibraryWorkspace.tsx`、`src/canvas/*`、`src/store/canvasStore.ts`、`src/lib/mivoImageClient.ts`、`vite.config.ts`。

## A. 视觉一致性 Findings

### A-1 [P2] Eagle 瀑布流抽屉与画布主操作层叠，破坏现有 MivoCanvas 单主操作层级

- 组件：Eagle 瀑布流面板 + M2 mask overlay + 右侧 AI panel + 底部 `CanvasAiActionBar`
- 证据：`src/App.tsx:159-179` 在 `workspaceView === 'assets'` 时仍同时渲染 `MivoCanvas`、`AIToolPanel`、`LibraryWorkspace variant="canvas-drawer"`；`src/App.css:755-765` 只给 `.asset-library-drawer` 一个绝对定位浮层，没有遮罩、焦点边界、底层 UI 禁用或关闭关系。截图 `/tmp/mivo-ui-audit-eagle.png` 显示素材抽屉打开时，mask toolbar、mask prompt、右侧 AI panel、底部 AI 条仍同时露出。
- 影响：新素材库不像现有 `details-dialog-backdrop` / 面板式交互那样有明确层级，用户会误以为可以同时执行局部重绘、素材复制、立即生成；视觉上也比现有 `.work-surface` + `.ai-panel` 的“一个主面板”模型更杂乱。
- 建议：打开素材抽屉时执行一个明确的 mode transition：取消 `maskEditNodeId`、收起或遮罩 `AIToolPanel`、禁用底层 `CanvasAiActionBar`；若保留抽屉形态，补 `.asset-library-drawer-backdrop` 或同等 scrim，Esc/关闭按钮只关闭最高层。视觉 token 继续用 `var(--panel)`、`var(--line)`、`var(--shadow)`，但层级要和现有 modal/drawer 合同一致。

### A-2 [P3] M2 mask overlay 工具控件自成一套，和 `CanvasToolDock` / AI panel 控件语言不统一

- 组件：`ImageMaskEditOverlay`
- 证据：`src/canvas/ImageMaskEditOverlay.tsx:31-35` 工具标签为英文 `Point` / `Box` / `Brush`；`src/canvas/ImageMaskEditOverlay.tsx:307-320` 使用 icon + text button；`src/App.css:4012-4063` 使用 `rgba(255, 253, 248, 0.96)`、自定义 `box-shadow: 0 10px 28px ...`、独立按钮尺寸。现有工具 dock 是 icon-first、小方按钮、`var(--shadow)`、active 为 `var(--charcoal)`：`src/App.css:2192-2276`；AI panel 控件使用 `var(--radius-md)` / `--text-sm` / panel token：`src/App.css:4340-4712`。
- 影响：mask 工具能用，但不像同一个产品系统里的工具；英文标签在中文 UI 内也显得突兀。
- 建议：把 mask 工具改成沿用 `canvas-tool-dock`/`ai-run-options` 的 segmented tool style：图标为主、中文 tooltip/aria-label，active/hover 使用 `var(--charcoal)`，panel 阴影改 `var(--shadow)` 或 AI panel 同级阴影，颜色只使用 `--panel` / `--panel-2` / `--line` / `--moss`。

### A-3 [P3] M2 mask 错误样式没有复用现有 AI 失败状态

- 组件：`ImageMaskEditOverlay`
- 证据：mask 错误只是一行红字：`src/App.css:4114-4119`；右下 AI panel 已有带背景和边框的错误块 `.ai-generation-error`：`src/App.css:4713-4722`。
- 影响：同类“AI 生成/编辑失败”在两个入口视觉重量不同；mask 失败在小浮层里不够醒目。
- 建议：新增 `.image-mask-edit-error` 时复用 `.ai-generation-error` 的结构和色值，至少保留 `background: rgba(185, 71, 58, 0.1)`、`border: 1px solid rgba(185, 71, 58, 0.22)`、`border-radius: 8px`。

### A-4 [P3] 派生 edge 使用硬编码色值和简单包围盒，和 token 化视觉系统不一致

- 组件：派生 edge 连线
- 证据：`src/store/canvasStore.ts:441-459` 创建 markup arrow；`markupStrokeColor: '#3f6f64'` 写死在 `src/store/canvasStore.ts:450`，不是 `--moss` 对应色 `#497466` 或集中 palette 常量；`width` / `height` / `markupPoints` 只按 source 右侧到 target 左侧估算。
- 影响：edge 当前能表达派生关系，但颜色和几何不在设计 token 管理下；当目标节点不在源节点右侧或有重叠时，线段可能变成短箭头或方向不直观。
- 建议：把派生 edge 颜色收敛到 canvas palette 常量，值与 `var(--moss)` 一致；几何层至少处理 target-left / overlap / vertical-only 三种分支，或改由已有 connector/markup 路径算法生成点位。

A 计数：P1=0，P2=1，P3=3。

## B. UI 状态完整性 Findings

### B-1 [P2] 生成/局部重绘只有 loading/error，没有 timeout/cancel/retry 状态

- 组件：右下首图对话框 `AIToolPanel`、M2 mask overlay、Mivo image client、中间件
- 证据：`src/lib/mivoImageClient.ts:27-64` 的 `fetch` 没有 `AbortController` 或超时参数；`vite.config.ts:301-314`、`vite.config.ts:369-375` 代理上游也没有超时；`src/app/AIToolPanel.tsx:123-154` 只有 `isGenerating` 和 `generationError`；`src/canvas/ImageMaskEditOverlay.tsx:227-240` 只有 `submitting` 和 catch 后 `statusError`。
- 影响：上游卡住时 UI 会长时间停在“生成中...”/“重绘中...”，用户无法判断是慢、失败还是可取消；这不满足本次要求的 timeout 状态。
- 建议：在 `generateMivoImage` / `editMivoImage` 和 Vite middleware 统一加超时策略；UI 增加 `status: idle | running | timeout | error | success`，timeout 展示明确文案和“重试/取消”。参照 loveart 同类生成/局部重绘：running、failed、timeout 都要在同一个状态条里闭环，而不是只靠按钮文字变化。

### B-2 [P2] 素材面板打开时没有结束或冻结 M2 mask 状态，导致两个主交互同时 active

- 组件：Eagle 瀑布流面板、M2 mask overlay、`CanvasAiActionBar`
- 证据：`src/App.tsx:173-178` 打开素材抽屉只是叠加 `LibraryWorkspace`；`src/canvas/MivoCanvas.tsx:512-518` 仍渲染底部 AI 条并保持 `maskEditActive`；`src/canvas/CanvasAiActionBar.tsx:60-70` 局部重绘按钮仍能表达 active/disabled；截图 `/tmp/mivo-ui-audit-eagle.png` 中素材抽屉与局部重绘工具同时可见。
- 影响：状态机没有保证“素材管理”和“局部重绘”互斥，容易发生复制素材、切 tag、局部重绘提交状态交叉；用户也无法判断 Esc/点击空白会关闭哪一层。
- 建议：进入 `workspaceView='assets'` 前调用 mask cancel，或在 App 层维护 `activeCanvasMode` 并让资产抽屉成为最高优先级 mode；底层 canvas 控件加 `inert`/pointer block。验收点：打开素材库时 mask toolbar 消失，关闭素材库后不会恢复半编辑状态。

### B-3 [P2] Eagle 卡片和 lightbox 缺少图片加载失败的终态 UI

- 组件：Eagle 瀑布流卡片、lightbox 大图
- 证据：Eagle 卡片 `<img>` 只做一次 fallback：`src/app/LibraryWorkspace.tsx:861-866`；lightbox `<img>` 没有 `onLoad` / `onError`：`src/app/LibraryWorkspace.tsx:1073-1075`。截图过程中控制台出现多条 Eagle thumbnail/file 404，当前 UI 没有 broken thumbnail 占位、重试或禁用大图按钮。
- 影响：Eagle 本地 API 或文件路径失效时，瀑布流会出现空白/破图；lightbox 可能打开一个无内容大图，用户无法知道是加载中、文件丢失还是格式不支持。
- 建议：维护 `imageLoadStateByAssetId`，卡片显示 skeleton / failed tile / retry；fallback 原图也失败时显示“图片不可用”；lightbox 增加 loading/error 面板，并禁用 `Add to canvas` / `Copy` 或给出失败原因。

### B-4 [P3] Eagle 加载态只在局部文案里显示，缺少瀑布流级 skeleton 和按钮 disabled

- 组件：Eagle 瀑布流面板、tag 目录
- 证据：加载状态存在：`src/app/LibraryWorkspace.tsx:183-185`；但 UI 只在 source row/status 和按钮文字显示 `Syncing` / `Loading`：`src/app/LibraryWorkspace.tsx:268-273`、`src/app/LibraryWorkspace.tsx:728-732`、`src/app/LibraryWorkspace.tsx:814-825`；瀑布流区域 `src/app/LibraryWorkspace.tsx:829-934` 没有 loading skeleton，`Syncing` 按钮也没有 `disabled`。
- 影响：慢加载时用户只看到旧列表或空区域，不知道 tag/资产正在刷新；重复点击 source/tag 会叠加请求和状态抖动。
- 建议：`eagleLoadState === 'loading'` 时在 `.asset-masonry` 渲染 6-8 个 skeleton card，tag directory 渲染 skeleton row；刷新/切换类按钮 disabled，并保持 active tag 的 pending 样式。

### B-5 [P3] 复制素材没有 success/error 可见反馈，OS 剪贴板失败只写 console

- 组件：Eagle 单图右键复制、多选批量复制、lightbox copy
- 证据：内部剪贴板写入后没有状态提示：`src/app/LibraryWorkspace.tsx:457-463`；单图 OS 剪贴板失败只 `console.warn`：`src/app/LibraryWorkspace.tsx:490-495`；多选复制按钮在 `src/app/LibraryWorkspace.tsx:790-806`，复制后没有 toast/status chip。
- 影响：用户右键 Copy 或 Copy selected 后不知道是否已经可到画布 Cmd+V；OS 剪贴板失败时也不会知道“内部复制仍成功、外部 app 粘贴不可用”。
- 建议：新增 `copyStatus`，显示 “已复制 1/N 张，可在画布粘贴”；OS 写失败时显示次级提示 “已写入 MivoCanvas 内部剪贴板，系统剪贴板写入失败”。批量复制清晰显示 N，并在画布 paste 后清除或保留状态。

### B-6 [P3] M2 mask 空 prompt / 无选区只禁用提交按钮，缺少 inline disabled reason

- 组件：`ImageMaskEditOverlay`
- 证据：提交保护在 `src/canvas/ImageMaskEditOverlay.tsx:227-229`；按钮 disabled 条件在 `src/canvas/ImageMaskEditOverlay.tsx:358-360`；UI 没有“先框选区域”或“请输入提示词”的辅助状态。
- 影响：用户进入局部重绘后，按钮置灰但不知道缺 prompt 还是缺 mask 区域；特别是点工具/框选很小区域未提交时没有反馈。
- 建议：在 prompt 面板内增加 `maskEditHint`：无 region 显示“先在图片上点选/框选/涂抹要修改的区域”，有 region 无 prompt 显示“输入修改描述后提交”；过小 box 被丢弃时短暂提示“选区太小”。

### B-7 [P3] 底部 AI 条 disabled 状态只靠英文 title，缺少可见空状态

- 组件：`CanvasAiActionBar`
- 证据：局部重绘按钮 disabled 仅由 `disabled={!canStartMaskEdit}` 和 `title={canStartMaskEdit ? '局部重绘' : 'Select an image first'}` 表达：`src/canvas/CanvasAiActionBar.tsx:58-70`；样式只有置灰：`src/App.css:2339-2344`。
- 影响：没有选中图片时，用户无法从界面直接知道为什么局部重绘不可用；title 还是英文，和中文 UI 不一致。
- 建议：改成中文 tooltip/status bubble，如“先选择一张图片”；或在 hover/focus disabled 周边显示轻量说明。保持按钮禁用，但不要只依赖浏览器 title。

### B-8 [P3] 右下首图对话框的参考图上传缺少拒绝态/单图缩略图错误态

- 组件：`AIToolPanel` 参考图上传
- 证据：`src/app/AIToolPanel.tsx:77-90` 只过滤 `file.type.startsWith('image/')`，非图片会静默丢弃；`src/app/AIToolPanel.tsx:280-296` 参考图 chip 的 `<img>` 没有加载失败状态；`src/app/AIToolPanel.tsx:395-403` 只有主生成错误，没有上传级错误。
- 影响：拖入非图片、损坏图片、超大图时没有明确提示；用户会以为已经上传但没有进入 reference list。
- 建议：增加 `referenceError`：非图片、无法读取缩略图、尺寸/体积过大分别提示；chip 图片加载失败时显示文件图标和错误 badge。该提示可以复用 `.ai-generation-error` 的轻量版本。

B 计数：P1=0，P2=3，P3=5。

## Round 2

GD_REVIEW_DECISION: APPROVED

复审对象：当前分支 `demo/canvas-ai`，HEAD=`c4d9ac5`。本轮读码并执行 `npm run build` / dist 安全 grep；未启动 dev server，未修改源码。

### A. 视觉一致性复核

| 上轮项 | Round 2 结论 | 证据 |
|--------|--------------|------|
| A-1 [P2] Eagle 抽屉与 mask/AI panel/底栏层叠 | 已修复 | 打开素材库时 `openAssetsWorkspace` 会递增 `maskCancelRequestId` 并收起 AI panel：`src/App.tsx:53-57`；`MivoCanvas` 监听该 request 并 `cancelMaskEdit()`：`src/canvas/MivoCanvas.tsx:441-445`；素材库现在包在 `.asset-library-drawer-backdrop` 内：`src/App.tsx:182-196`，backdrop z-index=72 覆盖 mask overlay z-index=35、AI panel z-index=8、底栏 z-index=7：`src/App.css:755-772`、`src/App.css:4070-4075`、`src/App.css:4457`、`src/App.css:2391-2396`。 |
| A-2 [P3] M2 mask 工具控件不统一 | 大部分修复，残留 P3 | 工具文案已改中文：`src/canvas/ImageMaskEditOverlay.tsx:32-35`；panel 阴影已改 `var(--shadow)`：`src/App.css:4113-4122`；active/disabled 继续使用 `var(--charcoal)` / `var(--line)`：`src/App.css:4141-4170`。仍保留 icon+文字按钮，不是完全对齐 `CanvasToolDock` 的 icon-first 形态，但已非 P1/P2。 |
| A-3 [P3] M2 mask 错误样式未复用 AI 失败态 | 已修复 | `.image-mask-edit-error` 已补齐 padding、背景、border、radius，和 `.ai-generation-error` 同一视觉模式：`src/App.css:4215-4224`、`src/App.css:4825-4836`。 |
| A-4 [P3] 派生 edge 硬编码色值/几何 | 部分修复，残留 P3 | 颜色已改成 `#497466`，与 `--moss` 一致：`src/store/canvasStore.ts:451`、`src/App.css:11`。几何仍按 source 右侧到 target 左侧简单估算：`src/store/canvasStore.ts:446-459`，复杂摆放下仍可能不如 connector 路径稳定；保留为非阻塞 P3。 |

A Round 2 计数：P1=0，P2=0，P3=2。

### B. UI 状态完整性复核

| 上轮项 | Round 2 结论 | 证据 |
|--------|--------------|------|
| B-1 [P2] 生成/局部重绘缺 timeout/cancel/retry | 已修复 | 前端 client timeout：`src/lib/mivoImageClient.ts:6-40`；中间件 timeout + 504：`vite.config.ts:15-80`、`vite.config.ts:328-353`、`vite.config.ts:396-414`；AI panel 有 cancel/retry：`src/app/AIToolPanel.tsx:131-178`、`src/app/AIToolPanel.tsx:423-448`；M2 submit 传 abort signal 且取消按钮可 abort：`src/canvas/MivoCanvas.tsx:155-160`、`src/canvas/MivoCanvas.tsx:313-348`、`src/canvas/ImageMaskEditOverlay.tsx:388-390`。 |
| B-2 [P2] 打开素材面板不退出 mask active 态 | 已修复 | 同 A-1：`openAssetsWorkspace` 触发 mask cancel request 并收起 AI panel：`src/App.tsx:53-57`；`MivoCanvas` 收到后取消 `maskEditNodeId` 和提交 abort controller：`src/canvas/MivoCanvas.tsx:155-160`、`src/canvas/MivoCanvas.tsx:441-445`。 |
| B-3 [P2] Eagle 卡片/lightbox 缺图片失败终态 | 已修复 | 卡片维护 `imageLoadStateByAssetId`：`src/app/LibraryWorkspace.tsx:190`、`src/app/LibraryWorkspace.tsx:673-690`；卡片 error 占位：`src/app/LibraryWorkspace.tsx:944-958`、`src/app/LibraryWorkspace.tsx:979-993`；lightbox 维护 loading/error 并禁用 Add/Copy：`src/app/LibraryWorkspace.tsx:450-453`、`src/app/LibraryWorkspace.tsx:1174-1214`；样式有 loading/error placeholder：`src/App.css:1190-1245`、`src/App.css:1690-1692`、`src/App.css:1744-1749`。 |
| B-4 [P3] Eagle loading 缺 skeleton/disabled | 已修复 | source/action 按钮 loading disabled：`src/app/LibraryWorkspace.tsx:700-707`、`src/app/LibraryWorkspace.tsx:731-735`、`src/app/LibraryWorkspace.tsx:881-885`；瀑布流 skeleton：`src/app/LibraryWorkspace.tsx:899-912`。 |
| B-5 [P3] 复制素材缺 success/error 可见反馈 | 已修复 | 内部剪贴板成功后设置 copy status：`src/app/LibraryWorkspace.tsx:494-500`；OS clipboard 失败写可见文案而不是只 console：`src/app/LibraryWorkspace.tsx:528-539`；面板展示状态 chip：`src/app/LibraryWorkspace.tsx:872-874`、`src/App.css:878-886`。 |
| B-6 [P3] M2 mask 空 prompt/无选区缺提示 | 已修复 | `maskEditHint` 根据无 region / 无 prompt 输出说明：`src/canvas/ImageMaskEditOverlay.tsx:116-121`，渲染在 prompt 面板：`src/canvas/ImageMaskEditOverlay.tsx:401`；小框选也有错误提示：`src/canvas/ImageMaskEditOverlay.tsx:223-227`。 |
| B-7 [P3] 底部 AI 条 disabled 只靠英文 title | 已修复 | title 已改中文，且无可用图片时显示可见 hint：`src/canvas/CanvasAiActionBar.tsx:67-74`。 |
| B-8 [P3] 首图对话框参考图上传缺拒绝/缩略图错误态 | 已修复 | 非图片文件会设置 `referenceError`：`src/app/AIToolPanel.tsx:81-97`；参考图缩略图 `onError` 给错误提示：`src/app/AIToolPanel.tsx:303-326`；错误视觉复用 `.ai-generation-error.subtle`：`src/App.css:4838-4842`。 |
| Eagle 空 tag 处理 | 通过 | `activeEagleTags` 会按当前加载素材计数过滤 0 资产 tag，避免展示空分类：`src/app/LibraryWorkspace.tsx:223-249`；若没有可用 tag，显示空态：`src/app/LibraryWorkspace.tsx:787-826`。选中的 tag 若不再存在，会自动清除：`src/app/LibraryWorkspace.tsx:443-448`。 |

B Round 2 计数：P1=0，P2=0，P3=0。

### 安全与构建佐证

- `npm run build` 通过；仅有 Vite chunk >500 kB 提示。
- `rg -n -o "MIVO_IMAGE_API_KEY|VITE_MIVO|llm-proxy|MIVO_IMAGE|image-key|Bearer" dist` 无输出。
- `git ls-files | grep -iE '\.env|secret|image-key'` 无输出。

### Round 2 总计数

- 残留 P1: 0
- 残留 P2: 0
