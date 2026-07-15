# Undo/Redo 同步缺口预检与整治计划

> **日期**:2026-07-16
> **基线 SHA**:`origin/main` = `81f7889`(#257,生产已 live server 模式)
> **调查基线**:本地 `3892b3d`(#250)→ `81f7889` 之间 undo/redo 同步路径无逻辑变更;#256(persist cutover + D3)/#257(BFF origin 守卫)不触及 undo/redo 路径,结论在 `81f7889` 上仍成立。
> **前置关系**:**U0 = T2.2 Block 3**(deferred-kinds server-wire lane)。U1/U2/U3 均排 T2.2 后实施;U4 绑 A4b 实时协作。
> **性质**:只读预检 + 设计储备,零代码。本文档不引入任何源码改动。

---

## 0. 前提修正(重要)

任务包原始背景含两个**已过时**的前提,预检 ground-truth 纠正如下:

1. **「undo/redo 是裸 set(applySnapshot),无第二条同步路径」已过时。**
   #246 的 wrap 在现 main **完整存活**:`src/canvas/useGlobalCanvasEvents.ts:169-170` 里
   `wrapMutation(store.redo)()` / `wrapMutation(store.undo)()`,带 A2 SC 注释(167-168)。
   undo 的 inverse-diff **已经**经 `wrapMutation` → `enqueueCanvasSyncChanges` 落 server。

2. **「generation-cancel 的 rollback 是裸的」已过时。**
   `src/canvas/maskEditGeneration.ts:160` 与 `src/store/generationSlice.ts:719`
   (经 `wrapCanvasActionRuntimeWithSync.generateIntoAiSlot` 注入的 `onSceneMutation` →
   `wrapMutationForScene`)都已包同步。

**结论:undo/redo 在「入口覆盖」层已基本闭合,残余工作在正确性/原子性,不在补 wrap。**

---

## 1. 现状全量盘点(入口)

| 入口 | 位置 | 是否经 wrap | 备注 |
|---|---|---|---|
| 主画布 undo 快捷键 Cmd/Ctrl+Z | `useGlobalCanvasEvents.ts:170` | ✅ `wrapMutation(store.undo)` | 唯一主入口 |
| 主画布 redo 快捷键 Cmd+Shift+Z | `useGlobalCanvasEvents.ts:169` | ✅ `wrapMutation(store.redo)` | — |
| 菜单/工具栏 undo/redo 按钮 | (无) | n/a | 全仓 grep 无 Undo/Redo UI(主画布侧) |
| documentSlice.undo/redo 内部 | `documentSlice.ts:339-360` | 内部裸 `applySnapshot`+栈交换;wrap 在**外部 call-site** | 与设计一致,非缺陷 |
| MaskEdit 涂层 undo/redo(独立) | `ImageMaskEditOverlay.tsx:443-465, 661-665, 597-598` | ❌ 不同步(正确) | 独立 React-state 历史,历史对象=mask region(非 document),属提交前笔触历史;结果图走 generation deferred 路径同步。**非缺口** |
| generation-cancel rollback | `maskEditGeneration.ts:160` / `generationSlice.ts:719` | ✅ `wrapMutationForScene` | 已同步 |

---

## 2. inverse-diff 正确性边界(server 语义已核实)

### Server revision 语义

来源:`src/lib/canvasSyncPort.ts` 头注 + `server/routes/canvas.route.test.ts:173-220`。

- **edit-node:If-Match,但 edit stale 永不 409(§14.1)** — last-writer-wins,200 + revision bump,overwrite 仅 debug 层。⇒ **inverse edit 永远能 apply**。
- **create-node**:POST 无 If-Match。可 400 bad-body → terminal rejected;422 reuse-conflict。
- **delete-node**:If-Match。204/404 + recordPresent → conflict(delete-race 全封)。
- 若 base 缺失:`src/lib/canvasSyncPortClient.ts:269/297/311` 返 `rejected: terminal, missing bundle base`。

### 场景枚举

| # | 场景 | inverse 行为 | 结局 | 风险 |
|---|---|---|---|---|
| a | undo 一个 **in-flight/pending-create** mutation | inverse=delete;`queueByCanvas` per-canvas 串行队列 + `canvasSyncPortClient` FIFO hold(pending create ack 前 hold 同 record edit/delete)→ delete 等 create ack 后才发 | create accepted→delete 带正确 rev 成功;create rejected→delete 走 dependency-failed rejected→warn | **低**(串行队列是承重墙;bypass 队列则崩) |
| b | undo 一个 **server-rejected** forward mutation | local 仍持有该 node(rejection 不回滚 local!)→ undo 本地移除,inverse delete 一棵 server 未知的 node | server 404/conflict→warn;local 已撤 | 自洽,但暴露**潜在 bug:rejected forward 的 local 乐观态从不回滚**(见 U3) |
| b' | undo 一个 **delete-race 被拒** 的 forward delete | inverse=create-node(POST) | server 若留 tombstone→reuse-conflict 422 rejected;否则 accepted | 边缘:recreate 可能失败 |
| c | undo 一个 **deferred 节点**(import/generate,Block 3 前) | inverse=delete server 未知 node→conflict warn | local 撤、server 不动,**自洽** | **真危害在别处**:若 deferred 节点日后经 Block 3 deferred-kinds server-wire lane 补落 server,而用户已 undo 删本地 → **server 补建一个本地已删的节点 → 分叉**。Block 3 落地后此分叉消失(deferred→同步经 wrap,node 即时落 server,inverse 干净)。**确认 Block 3 是 undo-of-generate 正确性的硬前置** |

### Block 3 后残余类

a(队列兜底,保留)、b/b'(rejected-forward + reuse-conflict 边缘)、多 change 原子性(§3)、多用户(§5)。

---

## 3. history 快照 vs server revision 对齐

- **applySnapshot 是整树本地回滚**(`src/store/canvasDocumentModel.ts:445`),本地 re-render 成本是本地事,与同步无关。
- **提交的 diff 是 per-record 字段级**(`buildCanvasSyncChanges` 只发变更的 record/intents + reorder),不是整树。⇒ undo 的网络 payload ≈ 一条 forward mutation 的足迹,**有界,非大批**。性能无忧。
- **原子性缺口(真实)**:`submitChanges`(`src/canvas/actions/canvasSyncRuntime.ts:337-375`)对 changes 数组逐条 `submitChange`,任一条 conflict/rejected 即 `return` → **#1..#k-1 已落 server,#k+1.. 跳过 → server 半撤、local 全撤 → 分叉**。edit 永不 409 降低了 edit-heavy inverse 的风险,但 group/ungroup、paste-multiple、ai-slot create+reflow 这类 create/delete 交错的 inverse 仍会触发。需服务端事务提交或客户端补偿。
- **tasks/meta 不在 diff**:`buildCanvasSyncChanges` 只 diff nodes/edges/anchors + reorder。但 `shared/persist-contract.ts:701-702` DP-8/9 **显式拒收 tasks/status** → tasks 是客户端 generation 编排态,**非同步缺口**。`update-meta`(title)不在 diff,但 rename 有独立同步路径,低优。
- **跨 scene undo**:history 栈是全局的、快照带 sceneId;undo 可切活跃 scene → `wrapMutation` 的 `before.canvasId≠after.canvasId` 守卫(`canvasSyncRuntime.ts:410-413`)→ **skip submit**。窄缺口。

---

## 4. 方案空间与推荐

| 方案 | 描述 | 工作量 | 评价 |
|---|---|---|---|
| (i) snapshot-diff inverse(现状)+ 补齐入口 | wrap 已在且正确;残余=硬化原子性 + 等 Block 3 | 小-中 | **推荐**。最小爆炸半径,与 T1.2 per-record revision 复用 |
| (ii) undo 栈带 op 级记录(重构) | per-op op-log,真·per-op undo + 可 scope 自有 op | 大(与 T1.2 kernel revision 重叠) | 冗余于单用户;**留作 A4b 多用户时的升级路径** |
| (iii) server 模式禁 undo 跨同步边界(产品阉割) | 断 undo | 小 | 仅作应急熔断,不推荐 |

**推荐:(i) + 定点硬化,且 hard-gate 在 Block 3 之后。**

---

## 5. 分块计划 + 工作量级(设计储备,排 T2.2 后)

| 块 | 内容 | 前置 | 工作量 |
|---|---|---|---|
| **U0(非 undo 工作,硬前置)** | Block 3 deferred-kinds server-wire lane:import/generate 经 wrapMutation 同步落 server | — | 已在 T2.2 规划,undo 正确性离不开它 |
| **U1** | submitChanges 多 change 原子性:mid-batch conflict/reject 不再裸 `return`;走 (a) 服务端事务端点(优先)或 (b) 客户端补偿:re-hydrate + re-diff + 重试剩余 | U0 | (a) 2-3 PR;(b) 1-2 PR |
| **U2** | 跨 scene undo 守卫:**不能只改提交路由**——`wrapMutation` 的 before/after 快照必须来自同一目标 scene(scene-mismatch 时以 `after.canvasId` 的 scene 基线重新采集 before,或 undo 入口按 scene 分别取快照后逐 scene diff);若仅把提交 route 到 `after.canvasId`,diff 会把原画布记录当删除、目标画布已有记录当创建,造成重复创建/误删/服务端分叉。现状 skip 保持为安全兜底,直至同 scene 采集方案落地 | — | 1 PR + 测试(含跨 scene 用例) |
| **U3** | rejected-forward local 乐观态回滚:`submitChange` terminal-reject 时回滚本地乐观改动(或标 stale)——本调查暴露的独立潜在 bug | — | 1 PR |
| **U4(defer 到 A4b)** | per-user scoped undo / OT — 仅当实时协作落地 | A4b | 大,独立 epic |

---

## 6. A4b 实时协作前瞻兼容(选型约束)

- LWW edit(edit 永不 409)⇒ undo 的 inverse 把**本端旧值**写回,会**静默覆盖同字段的并发远端编辑**。单用户无忧;多用户下 undo 变成"撤我的改动 + 顺带撤别人同字段改动"。
- **约束:snapshot-diff inverse(方案 i)无法 scope 到「只撤我的 op」**(它 diff 整个本地态)。⇒ **pre-A4b 单用户用 (i);A4b 落地时升级到 (ii) op 级 + ownership**。选型序列:(i) 现在 → (ii) A4b。

---

## 残余风险与建议优先级

- **生产 live** 意味着 deferred-node undo 路径(c 类)是**现网可见 hazard**:用户 undo 一个 generate/import 结果 → 本地撤、server 旧态保留 → hydrate 后图回来。U0(Block 3)是唯一根治。
- 次优先:U1(原子性)与 U3(rejected 乐观态回滚)是单用户下也会触发的真实分叉,建议紧跟 U0。
- U2(跨 scene)窄,U4 绑 A4b。

---

## 参考文件锚点

- 入口 wrap:`src/canvas/useGlobalCanvasEvents.ts:165-172`
- wrapMutation / wrapMutationForScene:`src/canvas/actions/canvasSyncRuntime.ts:400-443`
- submitChanges(原子性缺口):`src/canvas/actions/canvasSyncRuntime.ts:331-376`
- undo/redo action:`src/store/documentSlice.ts:339-360`
- 历史栈:`src/store/historyManager.ts`(HISTORY_LIMIT=60,全快照模型)
- applySnapshot:`src/store/canvasDocumentModel.ts:445`
- server revision 语义:`src/lib/canvasSyncPort.ts` + `server/routes/canvas.route.test.ts:173-220`
- base cursor / FIFO hold:`src/lib/canvasSyncPortClient.ts:397-419`
- tasks 拒收(DP-8/9):`shared/persist-contract.ts:701-702`
