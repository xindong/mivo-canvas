# PR-A 数据安全修复计划 v2（S01 / S02 / S03 / S03b / S04）

> 作者：Claude（主会话）· 2026-07-05 · 基于 TECH_DEBT_AUDIT.md + 本轮代码核查
> **v2 修订**：吸收 GPT-5.5 xhigh 审核（verdict REQUEST_CHANGES）全部 6 条 findings，逐条验证后采纳。修订点在各节以【v2】标出。
> 分支：`fix/data-safety`，worktree `../mivo-data-safety`，基于 origin/main（注意：main 已含 #72 projection 改动与 fix/quickwins-batch 可能先行合入，开工前 `git fetch origin` 用最新 main）
> 五条修复各自独立 commit（S01/S02/S03/S03b/S04 顺序）

## 事实核查结论（v2 修正版）

1. `historyPast` **不在** persist partialize 中（canvasStore.ts:409-417）→ 快照对象引用在单次会话内稳定，S01 可用对象身份判据。
2. 【v2 修正】`rollbackLatestHistoryBaseline` 有 **两个** 生产调用点：`generationSlice.ts:691` 和 **`src/canvas/maskEditGeneration.ts:88`**（v1 计划漏了后者，grep 时只扫了 src/store/）。两处都要接 expectedBaseline。
3. `pushHistory/undoHistory/redoHistory`（historyManager.ts）对栈内既有元素只做 slice/spread，不克隆已有快照对象 → 引用比较可靠。
4. commitGenerationResult 时序：入参校验(throw) → `await` 资产落盘 → 二次校验（只查 document/sourceNodeId，throw）→ `set()` 内 source/lineage/replaceSlot 校验（静默 return {}）。静默缺口 = lineage/replaceSlot 在 await 期间被删。
5. `warnCanvas` 定义于 canvasStore.ts:385，同文件可直接用。
6. `saveReferenceAssets` 是 chatStore.ts:97 模块内函数，sendMessage :239 在任何 try 之前 await 它；**UI 在调用 sendMessage 前已清空输入与参考图（ChatComposer.tsx:105-119）**。
7. 【v2】mask-edit 占位符链路：`prepareMaskEditPlaceholder`（maskEditGeneration.ts:62-77）→ `addAiSlotNode`（nodeCreationSlice.ts:205-209，`{ history: true }` 会 push 基线）→ 失败/取消时 `removeMaskEditPlaceholder`（:82-100）无条件 rollback 栈顶。
8. 【v2】canvasStore migrate 在 per-canvas 循环之后还有 **legacy flat-state 分支**（canvasStore.ts:342-358）：`if (persisted.nodes && persisted.tasks)` 再跑一次 normalizeDocument，同样能让整个 migrate 抛掉。
9. 【v2】S02 的三个 caller 兜接已核实无新增 unhandled rejection 风险：generationSlice.ts:682-705 catch、chatStore.ts:426-457 catch、mask-edit 外层 MivoCanvas.tsx:329-355 + ImageMaskEditOverlay.tsx:430-448。

---

## S01 — 生成失败回滚吞用户编辑（High）

**文件**：`src/store/generationSlice.ts`、`src/store/canvasDocumentModel.ts`(:432)、**【v2】`src/canvas/maskEditGeneration.ts`** 及其调用方、`src/store/canvasDocumentModel.test.ts`、**【v2】`src/store/generation.contract.test.ts`**

**根因**：失败路径无条件 `rollbackLatestHistoryBaseline`——只要栈顶 sceneId 匹配就 pop 并应用。异步期间用户编辑过（pushHistory 推了新快照），栈顶已不是生成基线，回滚吞掉用户编辑并清空 historyFuture。同类缺陷存在于 **两个** 调用点（槽位生成失败路径 + mask-edit 占位符移除路径）。

**修法（对象身份判据，不改 snapshot schema）**：

1. `rollbackLatestHistoryBaseline` 增加选项 `expectedBaseline?: MivoCanvasSnapshot`，入口守卫：
   ```ts
   if (!snapshot || snapshot.sceneId !== sceneId) return undefined
   if (options.expectedBaseline && snapshot !== options.expectedBaseline) return undefined
   ```
2. **槽位路径**（generationSlice.generateToSlot）：
   ```ts
   let baselineSnapshot: MivoCanvasSnapshot | undefined
   if (!skipSlotHistoryBaseline && targetSceneId === state.sceneId) {
     get().captureHistory()
     baselineSnapshot = get().historyPast.at(-1)
   }
   // 失败路径：
   const rollback = baselineSnapshot
     ? rollbackLatestHistoryBaseline(current, targetSceneId, { removeNodeId: slot.id, expectedBaseline: baselineSnapshot })
     : undefined
   if (rollback) return rollback
   // 否则走既有 filter-removal（historyPast/historyFuture 均不动）
   ```
3. **【v2】mask-edit 路径**（maskEditGeneration.ts）：
   - `prepareMaskEditPlaceholder` 改返回 `{ slotId, baselineSnapshot }`：在 `addAiSlotNode`（内部 `{ history: true }` push 基线）返回后立即 `const baselineSnapshot = useCanvasStore.getState().historyPast.at(-1)`。仅当 `sceneId === getState().sceneId` 时基线才真实被 push——若 addAiSlotNode 对非活跃 scene 不 push history（执行者核实 nodeCreationSlice.ts:205-209 的条件），非活跃场景下 baselineSnapshot 取栈顶会拿到无关快照，此时必须置 undefined。
   - `removeMaskEditPlaceholder` 签名加 `baselineSnapshot?: MivoCanvasSnapshot`，rollback 调用传 `expectedBaseline: baselineSnapshot`；baselineSnapshot 为 undefined 时跳过 rollback 直接走既有 filter fallback。
   - 追踪并更新 `prepareMaskEditPlaceholder` / `removeMaskEditPlaceholder` 的**全部**调用点（已知 MivoCanvas.tsx、ImageMaskEditOverlay.tsx、runMaskEditGeneration 内部，执行者 grep 全量），把 baselineSnapshot 从 prepare 一路线程到 remove。
   - 行为说明（写进代码注释）：mismatch 走 filter fallback 时保留用户编辑，但**不还原 reflow 位移**——这是刻意取舍（保编辑 > 还原位移）。

**边界行为（刻意设计）**：
- 生成期间用户编辑过 → 栈顶引用不匹配 → filter-removal：槽位删除、用户编辑保留、redo 栈保留、基线快照留在栈中（可 undo 回生成前）。
- 生成期间用户 undo 过 → 同上。
- `skipSlotHistoryBaseline`（chat 新建槽位）→ baselineSnapshot undefined → filter-removal（顺带修掉现状 skip 时 pop 无关快照的潜伏变体）。

**测试**：
- canvasDocumentModel.test.ts：expectedBaseline 不匹配 → undefined；匹配 → 正常回滚。
- generationSlice 层：基线捕获 → 模拟用户编辑 push → 失败 → 断言用户编辑保留、槽位删除、historyFuture 未清空。
- 【v2】mask-edit 层：prepare → 用户编辑 push → removeMaskEditPlaceholder → 断言编辑保留、占位符删除。
- 【v2】**更新既有断言**：`generation.contract.test.ts:476-492`（chat-created slot failure）现断言 historyPast/historyFuture 均为 0，与新语义冲突。改名为 "failure removes chat-created slot without popping unrelated baseline"，断言：slot 节点删除、`historyPast` 保留 pre-slot 基线（长度 1）、`historyFuture` 不被清空。**同文件全量排查**所有对 historyPast/historyFuture 长度的断言，受语义变化影响的逐条更新并在 commit message 里说明理由（预计还有 :470-474 的 cancel 用例）。

## S02 — 生成"成功"但画布无节点（High）

**文件**：`src/store/documentSlice.ts` commitGenerationResult + 对应测试

**修法（v2 修订：错误信息统一带资产名）**：
1. 把 lineageSource / replacementSlot 的再校验上提到 await 之后、set 之前的既有 throw 校验块。**【v2】这些 throw 的文案必须拼入已落盘资产名**（此时 savedImages 已存在），保证"保存期间被删"场景的孤儿资产可人工找回：
   ```ts
   const savedNames = savedImages.map((s) => s.asset.name).join(', ')
   if (lineageSourceId && !currentLineageSource)
     throw new Error(`源节点已删除，生成结果未落画布。已保存资产：${savedNames}`)
   if (replaceSlotId && !currentReplacementSlot)
     throw new Error(`AI 生成槽位已删除，生成结果未落画布。已保存资产：${savedNames}`)
   ```
   （await 前的入参校验保持原文案不变——那时还没有资产。）
2. set 内静默守卫保留（同 tick 竞态最后防线），set 之后加落地断言（同样带资产名）：
   ```ts
   if (savedImages.length > 0 && createdNodeIds.length === 0) {
     throw new Error(`生成结果未落画布（画布状态在保存期间变化）。已保存资产：${savedNames}`)
   }
   ```
3. 三个 caller 兜接已核实（事实核查 #9），无需额外改动；执行时跑一遍确认错误能显示到用户（errorCanvas / chat error message / mask-edit toast）。

**测试（v2：三条路径分开覆盖）**：
- replacementSlot 在资产落盘期间被删 → reject 且 message 含资产名（走上提校验）。
- lineageSourceId 同场景 → 同断言。
- set 后断言路径：如可行，用注入手段让上提校验通过但 set 内守卫触发（例如 stub set 执行前修改状态）；若单测无法自然触发，允许只对该断言做直接单元覆盖（导出辅助或接受该分支由防御性存在，写明原因），不得静默跳过。

## S03 — hydration 单条损坏全盘丢数据（High）

**文件**：`src/store/canvasStore.ts` migratePersistedState + migrate 测试

**修法（v2 修订：两个防线缺口都补）**：
1. per-canvas 循环 try/catch（同 v1）：
   ```ts
   Object.entries(canvases).forEach(([id, document]) => {
     try {
       const normalizedDocument = normalizeDocument(document)
       canvases[id] = shouldNormalizeLongMarkdown
         ? { ...normalizedDocument, nodes: normalizeLongMarkdownPreviewNodes(normalizedDocument.nodes) }
         : normalizedDocument
     } catch (error) {
       warnCanvas(`hydration 丢弃损坏画布 ${id}，其余画布不受影响：${error instanceof Error ? error.message : String(error)}`)
       const fallback = initialCanvases()[id]
       if (fallback) canvases[id] = fallback
       else delete canvases[id]
     }
   })
   ```
2. **【v2】legacy flat-state 分支（canvasStore.ts:342-358）同样纳入防护**：入口加最小形状校验 `Array.isArray(persisted.nodes) && Array.isArray(persisted.tasks)`（edges 存在时也须 isArray），并把其 normalizeDocument 包 try/catch——失败时 `warnCanvas` 后**跳过整个 legacy overlay**，保留步骤 1 已修复的 canvases。
3. sceneId 回落逻辑已存在，不需要新代码。幂等性保持（canvasGenerationHydration 二次 migrate 安全）。
4. **执行前置校验**：先写失败测试确认 normalizeDocument 对哪类损坏输入真的抛错（候选：条目 null、`{ nodes: 42 }`、node 缺 id）。若对 garbage 全部静默容忍，则在 try 内补最小形状断言（normalize 结果 nodes 非数组即视为损坏走 catch），防线不得是装饰。

**测试**：
- 两好一坏（canvases 条目）→ 保二丢一。
- 坏条目为活跃画布 → sceneId 回落默认。
- 【v2】canvases 两好 + 顶层 legacy `nodes` 损坏（如 `nodes: {}` / `nodes: 42`）→ 两好保留、overlay 跳过、不抛。
- migrate 两次结果一致（幂等）。

## S03b — 用户消息凭空消失（High）

**文件**：`src/store/chatStore.ts` sendMessage + chatStore 测试

**修法（v2 修订：catch 内显式落两条消息，不再依赖后续代码）**：

v1 伪代码只有 log + return，会实现成"有日志但仍丢消息"（userMessage 的构造在 saveReferenceAssets 之后）。v2 明确：**catch 分支内自包含地构造并 set 两条消息**，不依赖函数后续逻辑：

```ts
let referenceAssetUrls: string[] = []
try {
  referenceAssetUrls = await saveReferenceAssets(referenceFiles)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  debugLogger.error('Chat Store', `参考图保存失败，消息以失败态落档：${message}`)
  const failedUserMessage: ChatMessage = { id: createMessageId(), role: 'user', kind: 'text', text, createdAt: Date.now(), ... }
  const failedAssistantMessage: ChatMessage = { id: createMessageId(), role: 'assistant', kind: <既有 error 消息的 kind>, status: 'error', text: `参考图保存失败：${message}`, ... }
  set((s) => ({
    messagesByScene: {
      ...s.messagesByScene,
      [sceneId]: [...(s.messagesByScene[sceneId] || []), failedUserMessage, failedAssistantMessage],
    },
  }))
  return
}
```
- 两条消息的字段形态**逐字段照抄** sendMessage 下游既有失败路径（chatStore.ts:426-457 catch 内 error assistant message 的构造）与既有 userMessage 构造（:255 附近），保持 UI 渲染兼容；不写 generationContext 或写入不含 referenceAssetUrls 的最小 context（对齐既有 error 消息形态）。
- isBusy 在此 catch 时从未置 true，无残留问题（执行时确认 isBusy 置位点在此之后）。
- 不采用"重排到消息先落再存资产"方案：会改变 userMessage 中参考图上下文的生成时序，回归面更大。

**测试（v2）**：stub saveReferenceAssets reject → 断言 `messagesByScene[sceneId]` 末尾为 user text 消息 + assistant `status:'error'` 消息（断言消息内容而非仅 resolve/isBusy）、isBusy === false。

## S04 — chat migrate 裸断言（Medium）

**文件**：`src/store/chatStore.ts` migrateChatPersistedState + chatStoreMigrate.test.ts

**修法（v2 修订：v1 与 v>=2 分支共用 sanitize helper）**：
1. 抽 helper：
   ```ts
   const sanitizeMessagesByScene = (raw: unknown): Record<string, ChatMessage[]> => {
     const result: Record<string, ChatMessage[]> = {}
     for (const [sceneId, messages] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
       if (Array.isArray(messages)) result[sceneId] = messages as ChatMessage[]
       else debugLogger.warn('Chat Store', `migrate 丢弃损坏会话 ${sceneId}（非数组）`)
     }
     return result
   }
   ```
2. `v>=2` 分支：`sanitizeMessagesByScene(state.messagesByScene)` + selectedModel/paramOverrides 形状回落（同 v1 计划）。
3. **【v2】v1 分支**：`.map` 前先过 `sanitizeMessagesByScene`，对合法数组再做 `clampChatGenerationContext` 收敛；非数组条目 warn + drop。

**测试**：v>=2 非数组条目丢弃；缺 selectedModel 回默认；合法输入原样通过；【v2】v1 分支非数组条目丢弃且合法条目仍被 clamp。

---

## 验收门（全绿，附证据）

- `npm run lint` / `npm run build`
- `npx vitest run`（当前 main 基线约 431 passed / 12 skipped + 本 PR 新增全绿；既有断言更新仅限 S01 语义变化涉及的 generation.contract.test.ts 用例，逐条在 commit message 说明）
- `npm run verify:logging`
- `npm run test:e2e` 冒烟（双进程拓扑，起不来需说明并给替代证据）
- diff 范围自查：generationSlice.ts / canvasDocumentModel.ts / documentSlice.ts / canvasStore.ts / chatStore.ts / **maskEditGeneration.ts 及其调用点文件（MivoCanvas.tsx、ImageMaskEditOverlay.tsx，仅限线程 baselineSnapshot 的最小改动）** + 各自测试文件

## 风险与回滚

- S01：判据依赖快照引用稳定（事实核查 #1/#3）；若未来失稳，退化为"永远 filter-removal"（安全侧失败）。mask-edit 的 filter fallback 不还原 reflow 位移，属刻意取舍。
- S02：静默假成功 → 显式失败，即审计意图；孤儿资产仍产生（错误信息带名字），本 PR 不做资产回收。
- S03：全盘回默认 → 只丢坏条目；新增 fallback/delete 与 legacy-skip 分支均有测试。
- S03b/S04：纯加固。
- 与 fix/quickwins-batch 的交集：S07 已在该分支正式声明 payload 三字段、S10 改了 generationSlice:61/chatStore:128——若该分支先合入，本 PR rebase 后 documentSlice/generationSlice/chatStore 的上下文行号会漂移，逻辑无冲突。
