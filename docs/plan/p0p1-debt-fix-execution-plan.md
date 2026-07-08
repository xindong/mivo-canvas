# P0-P1 技术债修复执行计划（rev2，gpt-5.5 xhigh 已 APPROVED）

> 来源：`TECH_DEBT_AUDIT.md`（2026-07-06 增量审计，anchor c557c4c）+ 三方评审共识（Fable + 2× GPT-5.5 xhigh）。
> 约束真相源：`docs/plan/productization-roadmap.md`（rev4.4，D2/D7/§10 非目标不得违反）。
> 定位：本文件是「P3 leafer 迁移收尾债 + 执行期新增项」的落地计划，挂在 roadmap 之下，非独立第二真相源。

## Review 对齐

- REVIEW_DOMAIN: 应用代码
- REVIEW_FOCUS: 可落地性 / 验收可证伪性 / roadmap 非目标不越界 / lane 与合并冲突
- PLAN_SOURCE: current_user_request（loop-engineering 编排）+ TECH_DEBT_AUDIT.md

## 全局门禁（每个 PR 合并前必须全绿，任何 PR 不得让基线倒退）

**每 PR（本地/CI，快）**：
```
npm run build            # tsc -b，0 错
npm run lint             # eslint，0 告警
npx vitest run           # 全绿（当前 948 passed / 12 skipped 基线不降）
npm run verify:logging
npm run test:e2e:dev -- --renderer=both --scenario=<该 PR 相关场景>   # 该 PR 触及的场景，双渲染模式
```
**G3 统一（合并前批量，慢）**：
```
node scripts/e2e-runner.mjs --topology=dev  --renderer=both          # 全量双模式
node scripts/e2e-runner.mjs --topology=prod --renderer=both --scenario=debug,canvas-interactions,chat-generation,mask,variations-annotation   # 生产拓扑子集，显式双模式
```
**依赖门禁**：`npm audit` — 区分「本 PR 引入/改动依赖」（必须 0 新增 CVE，硬门禁）与「生态突发 advisory」（记录 + 单独 triage，不阻断无关 PR）。

**cast 门禁（修正，对齐 audit 结论）**：目标不是全仓 `as never`=0，而是——
```
rg -n "as never|as any|@ts-ignore" src server scripts -g '!**/*.test.ts' -g '!**/*.test.tsx'
```
结果只允许**白名单 2 处**：`server/lib/image.ts:16`、`server/lib/response.ts:16`（Hono 契约保留 cast，audit「看着糟其实没事 #2」，有 `__captures__` 快照锁定，本轮不动）。其余（含 `src/store/chatMaskEditFlow.ts` 的 3 处）必须清零，由 PR-T1 负责。`as any` / `@ts-ignore` 保持 0。

## Lane 与 PR 依赖（跨 lane 并行，lane 内串行）

### Lane R（渲染，串行，均触 useLeaferSpikeRenderer / paint / App.css）

**PR-R1 — Leafer 默认轨兜底（R-01/R-02/R-06/R-14）**
- 改：`src/render/useLeaferSpikeRenderer.ts`（init try/catch + 探针 DEV 门控 + window 钩子 DEV 门控）、`useEngineSpikeRenderers.ts`（接 fallbackToDom 降级）、`rendererMode.ts`（默认轨日志）。
- SC：
  - 单测：mock `new Leafer` 抛错 → 自动降级 dom、`data-renderer-mode=dom`、toast 一条、debugLogger.error 一条、画布仍渲染节点（非白屏）。
  - 生产构建产物中 `sampleNonEmptyCanvasPixels` 不被调用（运行时 getImageData 计数=0，DEV 才启用）。
  - 生产构建 `window.__MIVO_LEAFER_SPIKE__ === undefined`；DEV 下仍在。
  - 默认 leafer 启动 Debug Log 有且仅一条渲染器身份记录。
- 参考实现：`usePixiSpikeRenderer.ts:313` failToDom 范式。

**PR-R2 — R-03b per-node 签名下沉**
- 改：`leaferShapePaint.ts` / `leaferLinePaint.ts` / `leaferImagePaint.ts` / `leaferBrushStampPaint.ts`（各加 signature 字段跳过未变节点）+ `useLeaferSpikeRenderer.ts`（下沉 inline loop 已有签名逻辑）。
- SC：
  - 拖动单节点时未变节点 `projectNode`+`set` 调用次数=0（spy 断言，仅被拖节点 +1）。
  - §12.1 协议：1000 节点拖 1 节点，`store-to-renderer-sync` trace p95 ≤ 4ms；leafer p95 不劣于 PR 前基线。附 before/after 数字。

**R3-decision（人工拍板产物，非代码 PR）**：双轨定位选 (a) 保真双轨 还是 (b) 冻结视觉 parity 投入。
**PR-R3 — 双轨视觉常量收敛（R-10）实现** ← 前置：R3-decision
- 选 (a) 保真双轨：App.css 与 paint 模块视觉常量收敛单一 token 源 + parity 守卫。SC：token 单一来源测试 + 截图 diff ≤ 冻结阈值 + **负例**「改 token 不同步会红」；命令如 Playwright screenshot diff / `test:e2e:dev -- --renderer=both --scenario=<固定清单>` 通过。
- 选 (b) 冻结视觉 parity 投入：只停止继续手工对齐视觉常量，**不得删除或削弱 `?renderer=dom`**。SC：`?renderer=dom` 仍能完整渲染 D2 DOM-only 类型与关键场景（e2e 断言）；**不删 DomRenderer/flag**（roadmap D2 回滚阀，P4-g 验收前保留）；仅在 roadmap 记「视觉 parity 冻结」决策，不写删除动作。

### Lane S（服务端，独立并行）

**PR-S1 — proxy-image SSRF + abort（V-18/V-21/V-20）**
- 改：`server/routes/proxy-image.ts`（pin 已解析 IP 直连 + 相对 Location 修复）、`server/platform/job.ts:266`（裸 setTimeout → waitForPollInterval abort-aware）。
- SC：
  - 单测：DNS rebinding（首解析公网、fetch 时内网）→ 请求被拒；正常公网图源通；相对 Location 重定向跟随不误拒。
  - 补 proxy-image **路由层**测试（当前只有纯函数 proxyImageSecurity 有测试）。
  - V-20：poll pending 轮询能在 abort 后一个 tick 内响应取消（单测）。

### Lane T（状态，串行，共享 chatStore）

**PR-T1 — chat 快赢（S-01/S-02）**
- 改：`src/store/chatStore.ts:228,494`（isBusy 第二道 return 补 debugLogger.warn + 不丢输入/落失败态消息）、`src/store/chatMaskEditFlow.ts`（删 as never，收窄类型）。
- SC：isBusy 时发消息有 warn/toast 且输入不丢、无孤儿参考图；`grep 'as never' src/store/chatMaskEditFlow.ts`=0；tsc 0 错。

**PR-T2 — 循环依赖打断（A01）**
- 改：抽 `src/store/canvasLog.ts`（logCanvas/warnCanvas/errorCanvas 等中立模块），canvasStore re-export 保 API；打断 chatStore↔chatMaskEditFlow 值级环（值导入改从中立模块）。
- SC：值级环检测脚本对 chatStore↔chatMaskEditFlow、canvasStore↔slice 报 0；`vitest` 全绿；组件侧 selector 零改动。

**PR-T3a — persist 写放大（S-14）**
- 改：`src/store/canvasPersistConfig.ts` / `src/lib/persistIdbStorage.ts`（按 bench 结论决定是否 trailing debounce）。
- SC：出 bench 数字（单次序列化耗时 vs 帧预算），超 4ms/阻塞帧则加 debounce 后复测达标，否则诚实标观察项；**若加 debounce 必须补测**：连续 20 次 write → debounce flush 后 IDB 只存最终状态、定时 flush 生效、unload/teardown 时最后一次写入不丢。

**PR-T3b — 删画布跨 store GC（S-10）**
- 改：deleteCanvas 后回收 chat scene，**必须走中立 facade / 应用层 orchestrator，禁止 documentSlice 直接 import useChatStore**（否则重建 PR-T2 刚打断的值级环）。
- SC：先定义「无残留」= 删除 scene key（非留空数组）；删画布后 rehydrate，`messagesByScene[targetSceneId]` 与消息内 `referenceAssetUrls` 彻底消失（测试断言）；**合入前复跑 PR-T2 值级环检测，仍报 0**。

### Lane L（库，独立小 PR）

**PR-L1 — asset lease 中毒缓存（N-02）**
- 改：`src/lib/assetUrlLease.ts:81-98`（两条 await 包 try/catch，拒绝时 leaseMap.delete 再 rethrow）。
- SC：模拟 resolveAssetUrl reject → 该 entry 被删（test-only count=0），下次 acquire 重新解析而非命中中毒缓存。

### Lane B（构建，独立）

**PR-B1 — 循环依赖 CI 守卫（A01 守卫，依赖 PR-T2 先打断真环）**
- 改：新增值级环检测脚本 + 白名单（type-only 假环不报）+ 接入 CI。
- SC：故意加新值环 → CI 红；删掉 → 绿；现有 type-only 假环在白名单不报；不追求 madge --circular 归零。

### Lane S 扩项 / 独立处置（补 R-11、V-19，二值口径：修或显式延期）

**PR-S2 — proxy-image 开放代理口径（V-19）**：在 PR-S1 基础上，要么补出站域名 allowlist + 审计日志 + 响应大小限制（已有 30MB），要么**显式 defer**并写明条件（仅 localhost demo、`MIVO_PUBLIC` 未开时不修），二选一写进计划，不留解释缺口。
**R-11 决策项（Leafer 绕过 culling / image lease 全量常驻）**：轻量二值——(a) 加验证（heap/blob lease/object count 基准，长会话增删图片收支平衡），或 (b) 记「leafer 靠引擎自身裁剪，culling attr 仅描述 DOM 轨」决策 + 修正误导性遥测。R-11 由 audit open question 绑定「20k 生产目标是否真实」，若你确认 20k 非近期目标 → 走 (b)。

> **注意**：T01 从 Lane B 移出，独立成 **Lane T01**（因 PR-B3 会跨 types/model/projection/render/canvas/store/app，非纯构建类型 lane）。

**PR-T01a — 节点通道契约（type-only / 向后兼容）** ← 前置：契约拍板（人工，半天）
- 改：`docs/` 一页「新增节点类型单一路径」文档 + `src/types/mivoCanvas.ts` 引入**编译期判别字段/导出 NormalizedCanvasNode 交叉类型**。
- **红线（不得越 roadmap D6/P4-a schema 边界）**：不 bump persist version、不改 persist key、不要求旧节点新增必填字段、compact/persist 输出不新增 schema 字段——除非另做迁移设计（那属 P4-a）。
- SC：tsc 0 错、现有测试不回归、契约文档落地；**新增测试**：固定一个现有 v2 snapshot fixture,跑 `parseCanvasSnapshot → normalizeCanvasSnapshotV2 → compact/persist` 后 **JSON key 集不新增 schema 字段**（persisted shape 断言）+ legacy snapshot roundtrip 通过。

**PR-T01b — 试点（依赖 PR-T01a，真正的目标验收）**
- 改：用新通道实现一个真实新节点类型。**先声明该类型属 D2 矩阵哪一类**：DOM-only（markdown/pdf/video/卡片类）→ 不得强行要求 Leafer 双轨渲染；Leafer-painted（图形/图片/线/静态文本类）→ 必须复用 PR-R3 后的视觉/投影契约（故 T01b 排在 R3 之后或显式复用其策略）。
- SC：**用测试证明新增类型只经 T01a 定义的单一路径扩展**（不是手写 touched-files 记录）；touched files ≤4 处；试点节点能创建 / 按 D2 归类渲染 / 命中 / 持久化 roundtrip，全链单测 + e2e。

## 合并顺序（merge queue，一次合一个）

优先低风险先合，减少 rebase 冲突面（已修正 B1 依赖矛盾：T2 必在 B1 前）：
1. PR-L1（lib 独立）
2. PR-S1（server SSRF/abort）
3. PR-S2（V-19 口径，独立）
4. PR-T1（chat 快赢，清 chatMaskEditFlow as never）
5. PR-R1（leafer 兜底）
6. PR-T2（打断值级环）
7. **PR-B1（CI 守卫，依赖 T2 已合）**
8. PR-R2（per-node 签名）
9. PR-T3a（persist bench/debounce）
10. PR-T3b（删画布 GC，依赖 T2；合入前复跑值级环检测）
11. R3-decision（人工）→ PR-R3（双轨实现）
12. PR-T01a（节点契约）
13. PR-T01b（试点，依赖 T01a + R3）
R-11 决策项穿插在 R2/R3 之间处理。每合入一个，其余 lane 的 worktree `git rebase origin/main`。

## 编排（模型分工 + 看门狗）

- **实现**：`z-ai/glm-5.2`（用户口径 glm5.2max，实际无 max 档），每 lane 一个 worker，独立 worktree，effort high。
- **实现双审（G2）**：Fable(lead 读 diff) + `gpt-5.5` xhigh，每 PR 合并前双通过。
- **e2e（G3）**：`gpt-5.4` high 跑 `test:e2e` 双模式。
- **PR/合并/清理（G4）**：`z-ai/glm-5.2`，走 submit-pr / cleanup-branch 既有 skill 口径；**main 有分支保护（PR + 6 CI 必绿），合并须 CI 全绿 + 双审通过**。
- **看门狗**：lead 用 ScheduleWakeup 长间隔心跳轮询各 worker idle_ms，>15min 无输出则 idle/重派；worker 完成自动通知为主信号。**例外**：worker 正在跑长 e2e/bench 时不得仅凭 idle_ms 重派——要求 worker final 附关键命令输出 + artifacts 路径，由 lead/G2 独立验收（worker 汇报不算完成证据）。

## 偏航检测（每轮）

1. 动作是否仍服务"修 P0-P1 达 SC"；2. 验证标准是否仍来自 SC/命令而非 worker 自证；3. 是否为了让实现过而改 SC/文档；4. 是否与 roadmap D2/D7/§10 非目标冲突（如误把 undo 改成 command-based=违反 D7，立即停）。
任一成立 → 停 loop 输出偏航报告，不局部修补。

## 人工升级点（必须停下问用户）

- PR-R3 双轨定位（保真 vs 逃生通道）；PR-T01a T01 契约形态；V-19 公网口径（PR-S2）；R-11 20k 目标口径；merge 冲突无法自动解；CI 反复红 ≥3 次。
