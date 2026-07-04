# AI Slot 占位符功能 — 修复方案 + 成功验收条件（SC）

> 版本：**rev3**（回应 opus4.8-max 二轮复核）｜ 生成/修订：2026-07-04
> 来源：4 份代码级只读排查（含 file:line）+ 用户决策 D1–D4 + opus4.8-max 评审 + 上下文目标
> 本文件是跨 agent 共享真相源：gpt5.5-xhigh 修复、e2e 验收均以此为准。

## rev2 变更摘要（相对 rev1）
- **[修]** 原地替换触发判据：由 `operation` 字符串 → **显式 `replaceSlotId` payload**（阻断项 2）。
- **[修]** 局部重绘血缘：payload 分离 **`lineageSourceId`(原图) + `replaceSlotId`(预建槽)**（阻断项 3）。
- **[修]** SC1.3 undo：生成开始处捕获 history 基线，undo 回到"生成前空槽"（阻断项 4）。
- **[采纳]** 56 抽成命名常量 `AI_SLOT_GAP`；P3 保留 selectedNode 贴右子路径；reflow 处理 section 成员 + 触顶 fail visibly；SC1.2 基线时点标注。
- **[待用户]** e2e 工具 cypress vs 现有 Playwright（阻断项 1，见 §4/§7）。

### rev3 变更（相对 rev2，复核二轮）
- **[修]** 血缘自环防护：`replaceSlotId` 命中且源=槽自身时，结果节点不带自身 `parentIds`/`sourceNodeId`/派生边（§2 + 新增 SC1.6）。
- **[修]** undo 基线精确化：`replaceSlotId` 分支 commit 改 `history:false`，生成起点恰一次 history 基线（P1.3）。
- **[定]** e2e harness = **选项 A：Playwright**（用户 2026-07-04 确认；2 排查 + opus4.8-max 评审 + 专项评估四方一致）。

## 0. 背景与总目标

占位符（`ai-slot` 节点）当前**孤立**：生成中无进度反馈、出图后不替换、首次位置随机、局部重绘不走占位符。

**总目标**：让占位符成为**所有生图入口统一的「进度容器 + 结果载体」**。统一生命周期：

> 任一生成（聊天首次 / ai-slot / 局部重绘）都：**定位或预建 ai-slot 占位符 → generating 态显示 loading 动画 + 居中 mivo logo → 成功后【原地】替换为结果图（沿用 id/位置）→ 失败/取消显示对应态。**

## 1. 用户决策（已锁定）

| 决策 | 选择 | 含义 |
|------|------|------|
| D1 | **a** | 结果原地替换 slot：结果 image 沿用 slot 的 id 与位置，不再"新建图放右侧 + 保留空槽" |
| D2 | **沿用 56px** | ⚠️ 覆盖早前"80px"表述。首次下方间距 & 局部重绘右侧间距都用 56，抽成常量 `AI_SLOT_GAP` |
| D3 | **a** | 仅**局部重绘**走"挤开右侧图"；其余生成保持"新图自己避让" |
| D4 | **a** | 局部重绘**也预建**带 loading 动画的占位符 |

> D2=56 已经评审确认"尊重用户锁定值，不驳回"；`AI_SLOT_GAP` 常量化后若改 80 = 改 1 行 + 对应 SC 期望值。

## 2. 关键机制：payload 契约（本次核心改动，rev2）

`commitGenerationResult` 的 payload 扩展两个可选字段，替换/血缘解耦：

- **`replaceSlotId?: string`**：存在时→结果**原地替换**该 ai-slot（沿用其 id + x/y，`type` 由 `ai-slot`→`image`，清理 `aiWorkflow`），**不另建节点、不套 `chooseAdjacentPlacement`**；不存在时→维持现状（新建 image + placement 摆放）。
- **`lineageSourceId?: string`**：派生边 `from` 与 `parentIds` 用它（=真实血缘源，如局部重绘的原图 A）；缺省回落到旧的 `sourceNodeId` 语义。

**血缘自环防护（rev3，复核#1）**：当解析出的 lineage/source 节点 id === `replaceSlotId`（被替换的槽本身就是源——纯聊天/ai-slot 生成、无上游图），结果节点**不得携带指向自身复用 id 的 `parentIds` / `sourceNodeId` / 派生边，一律置空**。注意 `nodeFactory.ts:224,239-241` 当前**无条件**写 `parentIds:[source]`/`sourceNodeId`（不受 `createDerivationEdge` 控制），须显式拦截，否则 `buildAiContextSnapshot`（`aiCanvasWorkflow.ts:110-113`）会生成 self→self 血缘链。

各入口如何填：

| 入口 | replaceSlotId | lineageSourceId | 说明 |
|------|---------------|-----------------|------|
| 聊天首次 / ai-slot 生成 | = 该 slot.id | = 选中的源图（若有，否则空） | 触发原地替换 |
| 局部重绘 | = 右侧预建 slot.id | = 原图 A.id | 替换预建槽 + 血缘挂原图 A |
| 旁边生成 / 批注修图 / 变体 | 不传 | 现状 | 行为完全不变（source 是 image，天然不替换）→ 满足 SC1.5/SC4.5 |

## 3. 问题 → 正确修法 → SC

### P1 — 出图后原地替换占位符（D1=a）

- **根因**：`commitGenerationResult`（`src/store/documentSlice.ts:213-339`，set 块 250-336）永远新建 image（`createGenerationResultNode` @ `src/store/nodeFactory.ts:193-246`）；`generateIntoAiSlot`（`src/store/generationSlice.ts:556-705`）传 `placement:'right'`（:648），成功后只翻 `aiWorkflow.status='ready'`（652-670）留空槽。
- **修法**：
  1. `commitGenerationResult` 按 §2 的 `replaceSlotId` 分支：命中则结果节点复用该 slot 的 id + 位置、`type→image`、清 `aiWorkflow`，跳过新建与 placement。
  2. slot-generation 路径把 `replaceSlotId=slotId` 传入（取代原 `placement:'right'`+保留槽）。
  3. **undo 机制（阻断项 4 + 复核#2）**：保证"生成前"恰好一次 history 基线、且替换 commit 不再二次入史：
     - (a) `replaceSlotId` 分支的 `commitGenerationResult` 必须 **`history:false`**（把 `documentSlice.ts:335` 的 `{history:true}` 改成条件式：命中 replaceSlotId 时 false）。
     - (b) 生成起点恰好一次 `history:true` 基线：**聊天首次**由 `addAiSlotNode`（`nodeCreationSlice.ts:47` 已 history:true）承担；**手动 ai-slot 生成**（无 addAiSlotNode）须在翻 generating 前（`generationSlice.ts:605` 那次 patch 之前）显式补一次 history 基线快照。
     - 结果：generating 中间态不入史，成功后 undo 一次稳定回到"生成前空槽/无槽"。
  4. 兼容 `chatStore.pendingSlotId`：slot 被替换后旧 id 变 image，`prepareChatSlot` 的 existing 查找（带 `type==='ai-slot'` 判据 @ generationFacade.ts:55）查不到→回落建新槽，不崩（评审已确认安全）。
- **SC**：
  - **SC1.1** [e2e] 聊天首次生图成功后无残留空 `ai-slot`；结果 image 在**原占位符位置**（x/y 误差 ≤2px）。
  - **SC1.2** [unit/e2e] 基线时点 = **预建/定位 slot 之后、出图之前**（此刻 image=N、ai-slot=S）；成功后 image=N+1、ai-slot=S−1。
  - **SC1.3** [unit] 成功后 undo 一次回到"生成前空槽/无槽"，无 generating 中间态残留。
  - **SC1.4** [regression] `createFailedVariationSlot`（`generationSlice.ts:75-104`，`operation:'variation'`）的持久失败红槽不被误删（不传 replaceSlotId → 天然不动）。
  - **SC1.5** [regression] 旁边生成 / 批注修图仍新建 image 于右侧，行为不变。
  - **SC1.6** [regression/unit] 原地替换后的结果 image 节点 `parentIds` **不含自身 id**、`sourceNodeId` 不指向自身复用 id（纯聊天/ai-slot 生成无自环血缘）。

### P2 — 生图 loading 动画（左上→右下渐变）+ 居中 mivo logo

- **根因**：generating 仅静态 `"Generating..."`（`CanvasNodeView.tsx:521-531,668-675`）；`.dom-ai-slot-node`（`App.css:4160-4218`）5 态外观几乎无区分（仅 ai-canceled 变灰 @4173）；`::before` 已占内层边框 @4179。`.dom-node.ai-generating` 选择器真实存在（class 拼装 @ CanvasNodeView.tsx:589）。
- **修法**（纯 CSS 为主）：
  1. `.dom-node.ai-generating .dom-ai-slot-node` 加渐变扫描层（用未占用的 `::after` 或新增 `<span class="ai-slot-shimmer">`）：`linear-gradient(135deg,...)` + `background-size:200% 200%` + `@keyframes` 让 **百分比** `background-position` 从 `0% 0%`(左上)→`100% 100%`(右下) `infinite`。
  2. generating 分支插居中 `<span class="mivo-logo" aria-hidden="true"/>`，复用 `.mivo-logo` mask（`App.css:669-676`，资产 `public/mivo-logo.svg` 已存在）；容器已 `place-items:center`。
  3. 加 `will-change` 兜底性能。
- **SC**：
  - **SC2.1** [visual/e2e] generating 态：135° 左上→右下渐变扫描（循环）+ 居中 mivo logo。
  - **SC2.2** [e2e] empty/generating/ready 外观可区分。
  - **SC2.3** [unit/e2e] logo 引用 `public/mivo-logo.svg`（DOM 存在 `.mivo-logo` 或等价）。
  - **SC2.4** [manual] 缩放 0.5×/2× 动画方向与居中不错乱。

### P3 — 首次生图定位不再随机（D2=56）

- **根因**：`prepareChatSlot`（`src/store/generationFacade.ts:40-71`）**else（未选中）分支** `slotX/slotY = -160 + doc.nodes.length*18`（:62-63）——只按节点数递增的对角线；size 硬编码 320×320（:65）。
- **修法**（只改 else 那条对角线，**保留 selectedNode 贴右 +56 子路径**）：
  1. 新增 store 内纯函数 `firstAnchorImageFor(nodes)`：过滤 `type==='image' && !hidden`，用 `visualRowOrder`（`canvasDocumentModel.ts:460`）+ **行容差带**（y 差 < 半个中位高度视为同行）取最上一行最左；无图片返回 `undefined`。
  2. 有 anchor → `chooseAdjacentPlacement({ nodes, anchor, width, height, placement:'below', margin: AI_SLOT_GAP })`（`aiCanvasWorkflow.ts:43-86`；`'below'` = x 左对齐、y=anchor 底+margin、自动避让）。
  3. 无 anchor → 兜底（视口中心/旧默认），不崩。
  4. size 改用 `defaultSizeForNodeType('ai-slot')`（320×320），去硬编码。
  5. `AI_SLOT_GAP=56` 定义在 `aiCanvasWorkflow.ts`，P3/P4 共用。
- **SC**：
  - **SC3.1** [e2e] 已有图片时占位符落在"首行首列图"正下方、左对齐（x 相等）、`y=anchor.y+anchor.height+56`（≤2px）。
  - **SC3.2** [unit] `firstAnchorImageFor`：只挑 image+可见；行容差取最上行最左；无图返回 undefined。
  - **SC3.3** [e2e] 空画布/无 image 走兜底不崩、不落对角线。
  - **SC3.4** [unit] 旧 `-160+nodes.length*18` 已移除；selectedNode 贴右子路径保留。

### P4 — 局部重绘：右侧 56px + 挤开 + 预建带动画占位符（D2/D3/D4）

- **根因**：局部重绘链（`CanvasToolDock.tsx:101`→`MivoCanvas.tsx:318-382` submitMaskEdit→`commitGenerationResult{kind:'edit',placement:'right'}`@341-351）不预建占位符；结果用默认 margin=56 但"新图自己避让"（`aiCanvasWorkflow.ts:76-83`）；全仓无 reflow。
- **修法**：
  1. **D4**：`submitMaskEdit` 生成前，在源图 **右侧 `AI_SLOT_GAP`(56)** 预建 ai-slot（status→generating，走 P2 动画），并 `reflowRightObstacles` 挤开。
  2. **D3**：新增纯函数 `reflowRightObstacles(nodes, placedRect, gap=AI_SLOT_GAP)`（放 `aiCanvasWorkflow.ts`，复用 `rectsOverlap` @:19）：对与 placedRect **y 轴投影相交**的右侧障碍，按 x 升序右移让位、**连锁**（while + 已处理集 + 迭代上限，参考现有 60 次）。**只推 x 轴**；**跳过/整体移动 section 成员**（勿把成员推出 frame，参考 chooseAdjacentPlacement 忽略 anchor.sectionId @:70）；不动 locked。**迭代触顶要 debugLogger 告警（fail visibly），不静默留重叠**。仅在 `commitGenerationResult` 的 set 块接入（唯一能改 `nextNodes` 处）。
  3. 局部重绘 payload：`replaceSlotId=预建slot`、`lineageSourceId=原图A`、`reflow:true`；**仅此路径触发挤开**（D3=a）。
  4. 多图结果 `savedImages.forEach` 时 reflow 逐张增量生效。
- **SC**：
  - **SC4.1** [e2e] 对图 A 局部重绘：A 右侧 56px 处出现带 loading 动画+logo 的占位符。
  - **SC4.2** [e2e] A 右侧 56px 内原有图 B：B 自动右移、与占位符不重叠；连锁（B 右还有 C）也不重叠。
  - **SC4.3** [e2e] 出图后占位符原地替换为结果图（位置=A 右侧 56px）。
  - **SC4.4** [unit] `reflowRightObstacles`：只推 y 投影相交的右侧节点、连锁、有上限、跳过 section 成员/locked、触顶告警；纯函数可单测。
  - **SC4.5** [regression] 非局部重绘生成不触发挤开。

## 4. 全局验收（交付门槛）

- **G1** [build] `npm run build`（tsc -b + vite build）0 error。
- **G2** [unit] `npm run test:unit`（vitest）全绿，含 `firstAnchorImageFor` / `reflowRightObstacles` / 原地替换 单测。
- **G3** [logging] `npm run verify:logging` 通过（新用户可见行为按 `docs/development-logging.md` 补 `debugLogger`/`toastFeedback`）。
- **G4** [e2e] 所有 [e2e] SC 在 **Playwright harness**（harness 已定=选项 A）上全绿：扩展 `scripts/e2e-smoke.mjs` + `scripts/e2e/scenarios/*`，复用 `nearlyEqual(±2px)`/`rectsOverlap`/`waitForCount` + 双层 mock（浏览器 `page.route` + Node `upstream-mock-server.mjs`）。**e2e 必须走 mock 后端**（in-app mock 生成已禁用、真实 BFF 非确定性）。
- **G5** [regression] 现有 Playwright 冒烟既有断言不回归（注：该脚本 stamp 光标断言为 PR#13 遗留过时项，与本次无关）。

## 5. SC 分类索引

| 类型 | SC |
|------|----|
| unit | SC1.2(部分) SC1.3 SC3.2 SC3.4 SC4.4 |
| e2e | SC1.1 SC1.2 SC2.1 SC2.2 SC2.3 SC3.1 SC3.3 SC4.1 SC4.2 SC4.3 SC4.5 |
| visual/manual | SC2.1 SC2.4 |
| regression | SC1.4 SC1.5 SC1.6 SC4.5 G5 |

## 6. 相关文件（修改面）

- `src/store/generationFacade.ts`（P3）｜`src/store/generationSlice.ts`（P1/P4 payload、变体保护）
- `src/store/documentSlice.ts`（P1 replaceSlotId 分支 + P4 reflow 接入 + lineageSourceId）
- `src/store/aiCanvasWorkflow.ts`（`AI_SLOT_GAP` 常量 + `chooseAdjacentPlacement` 复用 + 新增 `reflowRightObstacles`）
- `src/store/canvasDocumentModel.ts`（新增 `firstAnchorImageFor`）｜`src/store/nodeFactory.ts`（P1 复用 slot id/位置）
- `src/canvas/MivoCanvas.tsx`（P4 submitMaskEdit 预建槽 + payload）
- `src/canvas/CanvasNodeView.tsx` + `src/App.css`（P2 动画+logo）｜`public/mivo-logo.svg`（已存在）

## 7. e2e 工具 — 已定：选项 A（Playwright）

**决策（2026-07-04，用户确认）**：[e2e] SC 全部扩展进现有 Playwright harness，**不引入 cypress**。
- 依据：cypress 在本仓零基础（无依赖/配置/脚本）；现有 Playwright harness ≈7400 行，已有 `nearlyEqual(±2px)` / `rectsOverlap` / `waitForCount` 断言原语 + 双层 mock（浏览器 `page.route` + Node `upstream-mock-server.mjs`）+ 画布指针拖拽（`mask.mjs`），已覆盖 ai-slot/chat/mask/anchor。新 SC 是既有断言的增量扩展。
- 落地位置：`scripts/e2e-smoke.mjs`（主编排）+ `scripts/e2e/scenarios/*`（新增/扩展 ai-slot 占位符场景）+ `scripts/e2e/api-mocks.mjs`（复用渐进进度 mock）。
- 必要时沿用既有"store hook 驱动"手法（`window.__anchorGenerate` 等）规避画布 hit-test 不稳。

## 8. rev4 精修（2026-07-04，UX 眼验后追加）

### 锁定决策（用户默认未改 → 采用推荐）
- **①a**：生图失败/取消卡直接消失，**无重试按钮**；重试=回聊天框重发。
- **①b**：失败时被 reflow 挤开的图**恢复原位**（回退到 rev3「生成前」history 基线，一并撤销预建槽 + reflow 位移）。
- **②**：点选圆形重绘区默认半径 = **源图短边 8%**（可调常量）。

### 变更 5：生图失败/取消 → 占位符自动消失
现状：失败/取消把 `aiWorkflow.status` 置 failed/canceled 并**保留槽**（generationSlice 失败分支 + submitMaskEdit）。
修法：**本次生成的临时占位符**（chat 首次 / 局部重绘预建 / 生成进空槽）失败或取消 → **移除**；机制 = 回退到 rev3「生成前」history 基线（复用 P1.3，自动撤销预建槽 + reflow 位移）。**`createFailedVariationSlot` 变体失败红槽除外，保留**。

| SC | 类型 | 通过判据 |
|----|------|---------|
| SC5.1 | e2e | 聊天首次生图失败 → 占位符 ai-slot 移除；ai-slot 计数回生成前；无 "Generation failed" 卡 |
| SC5.2 | e2e | 生成取消 → 同样移除占位符 |
| SC5.3 | e2e | 局部重绘预建槽失败/取消 → 槽移除，**且被挤开的图恢复原位**（①b） |
| SC5.4 | regression/unit | `generateVariations` 持久失败红槽不受影响，失败后仍保留 |
| SC5.5 | regression | 成功路径不回归（成功仍原地替换，SC1.1 成立） |
| SC5.6 | unit | 失败移除走"回退生成前 history 基线"，undo 语义自洽、无中间态残留 |

### 变更 6：局部重绘只留点选（圆形区 + 修文案）
现状：点选是死路——submit 只从 region(框选/涂抹) 建蒙版，point 被 `isPointOnlyMaskEdit`（imageMaskGeometry.ts:34）拦截，弹 `请框选或涂抹要重绘的区域`。
修法：`ImageMaskEditOverlay` 删 box/brush 工具项、默认 `tool='point'`；点选点击 → 落 `{type:'brush', points:[点], radius=短边8%}` 圆形 region（复用现有单点=圆蒙版管线 imageMaskGeometry.ts:173）；**移除** `isPointOnlyMaskEdit` 守卫 + `pointOnlyMaskEditMessage`；文案 `'先在图片上点选、框选或涂抹要修改的区域。'` → `'先在图片上点选要修改的区域。'`。

| SC | 类型 | 通过判据 |
|----|------|---------|
| SC6.1 | e2e/visual | 局部重绘工具条只有"点选"，无框选/涂抹；默认 tool=point |
| SC6.2 | e2e | 点一下 → 生成圆形 region（半径=短边8%）；不再被拦截、无"请框选或涂抹"提示 |
| SC6.3 | e2e | 点选后正常提交，走通 生成→占位符→(成功)原地替换 /(失败)消失（衔接①） |
| SC6.4 | unit | 移除 isPointOnlyMaskEdit 守卫；点选 region 被 buildEditMaskBlob/boundsForRegions 正确转圆形蒙版 |
| SC6.5 | visual | 文案改为"先在图片上点选要修改的区域。"，无"框选/涂抹"残留 |
| SC6.6 | e2e | 多次点选叠加多个圆形区；clear/undo 正常 |
| SC6.7 | regression | 现有 e2e mask 场景改点选驱动后仍绿；mask-reflow 仍绿 |

### 文件面（rev4）
① `src/store/generationSlice.ts`（失败/取消分支→回退基线移除槽）、`src/store/documentSlice.ts`、`src/canvas/MivoCanvas.tsx`（submitMaskEdit 失败清理）；② `src/canvas/ImageMaskEditOverlay.tsx`、`src/canvas/imageMaskGeometry.ts`(+`imageMaskGeometry.test.ts`)；e2e：`scripts/e2e/scenarios/mask*.mjs`（改点选 + 新增失败消失断言）。
全局门槛同 §4（build/unit/logging/e2e 全绿；rev3 全部 SC 不回归）。
