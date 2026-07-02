# M7 对话式 AI 面板 — Loop 状态源（lead 每轮先读本文件）

> 建立：2026-07-02 | 分支 `demo/improve-hud`（base=demo/canvas-ai）
> 计划真相源：`/Users/praise/.claude/plans/synchronous-giggling-lamport.md`（rev2，已消化 Codex 双审）
> 探针真相源：`docs/demo/plan/chat-panel/probe-results.md`（P0 实测）

## Loop 7 要素

- **目标**：右侧 AIToolPanel → 带记忆对话面板（agent 增强 prompt → 生图双回流对话+画布），兼容 mask 锚点二改，enhance 响应快（kimi 实测 3.5s）；rev2 计划验收标准 8 条全过 + Codex 交叉审通过 + 双 worker e2e 绿。
- **状态来源**：本文件阶段表 + `git log demo/improve-hud` + worker 汇报消息 + rev2 计划 + probe-results.md。
- **单轮动作**：推进阶段表当前未完成的**一个**阶段（派发 / 验收 / 审查 / 修复派回）。
- **验证方式**：每阶段 `npm run build`+`npm run lint`；C3 起 lead 实跑 UI 把关（交互丝滑度+样式沿用现有体系）；最终 = 验收 8 条浏览器实跑 + Codex gpt-5.5 xhigh 交叉审（lead 为主、gpt 为辅）+ 双 worker e2e。
- **停止条件**：验收 8 条全过 && 交叉审无阻塞项 && 双 e2e 绿；或触发升级条件。
- **工期（用户 2026-07-03 00:25 最终定）**：**不设截止，质量优先**。以最好效果为目标：验收 8 条全过、交互丝滑度全项达标、交叉审无阻塞、双 e2e 绿。不因工期缩范围；缩范围条款作废。
- **预算限制**：每阶段修复循环 ≤2 轮；worker 卡死判定 = idle 30min 无汇报即催告（看门狗 **15min** 心跳）；worker 重试上限 1。
- **人工升级条件**：① enhance/生图上游失效 ② 视频端点缺口（已确认，需用户从网关方拿文档）③ 某阶段 2 轮修复仍不过 ④ 验收口径与用户预期冲突 ⑤ 共享文件冲突无法自动解。

## Worker 编排（用户指令 2026-07-02 下午更新）

| 角色 | agent/model/effort | 方式 |
|---|---|---|
| 执行（C3/C4/C5） | claude-code `claude-sonnet-5` high | **用 /goal skill** 执行指定阶段，向成功验收条件收敛 |
| 交叉审查 | codex `gpt-5.5` xhigh | lead 验收后交叉审；lead 为主、gpt 为辅 |
| 最终 e2e ×2 | codex `gpt-5.5` xhigh + claude-code `claude-sonnet-5` high | 并行同跑端到端 |
| 探针/搜文件杂活 | lead 自动派（haiku explore 或临时 worker） | 随需 |
| 看门狗 | lead ScheduleWakeup 30min 心跳 | 每次派发后挂；醒来查 worker_status，卡死→催告/重派（重试 ≤1） |

注：C1+C2 在本指令下达前已派 codex gpt-5.5 xhigh（`dev-chatpanel-backend`）执行中，不中途换马；其产出同样过 lead 验收 + 交叉审。C3 起执行 worker 切换为 sonnet-5 high + /goal。

## 阶段表（状态：⬜未开始 / 🟡进行中 / ✅done / ❌blocked）

| 阶段 | 内容 | 执行者 | 验收 | 状态 |
|---|---|---|---|---|
| P0 | 探针（chat/kimi/qwen/gemini/seedance） | lead | probe-results.md | ✅ done |
| C1 | /api/mivo/enhance 路由（kimi→qwen 降级链） | sonnet-5 high + /goal（dev-chatpanel-backend-v2） | build + curl 三路径 + 延迟<8s | ✅ done（a3ba39b，lead 复验：build 193ms + 实测 5.0s 合法 JSON） |
| C2 | 类型贯穿 + modelCapabilities + chatStore + store action 返回 ids | 同上 | build + lint | ✅ done（6cf51df，lead 复验：lint 仅剩 5 条边界外预存项） |
| C3 | chat/ 五组件 + App 接线（新旧并存） | sonnet-5 high + /goal（dev-chatpanel-ui） | build + lint + lead 实跑 UI 把关 | 🟡 进行中 |
| C4 | 删旧件 + mask 回流 appendNotice | 同 C3 worker（串行） | build + grep 零残留 + mask 回归 | 🟡（同批派发） |
| C5 | e2e 更新（enhance mock + 选择器重指 + 对话断言） | 同 C3 worker（串行） | test:e2e 全绿 | 🟡（同批派发） |
| A1 | lead 验收：rev2 验收标准 8 条浏览器实跑 + UI/交互严格把关 | lead | 逐条 pass | ✅ 8/10 pass + 2 必修已修复复验；mask/console 为已知上游/噪音不阻塞 |
| A1-fix | 修复 2 项（参考图接线 + slot 落点） | dev-chatpanel-ui | build+lint+参考图图生图实跑 | ✅ done（124e3c4，lead 复验：editCalled=true/generateCalled=false、slot{-106,-106}非零、build 196ms） |
| A2 | Codex gpt-5.5 xhigh 交叉审（代码+实跑） | xreview-chatpanel | 无阻塞项（lead 终裁） | ✅ 完成：REQUIRES_CHANGES，3 blocking+3 nb，lead 逐条核实全属实、全采纳 |
| A2-fix | 修 3 blocking（gemini比例分流/跨scene归属/retry上下文）+3 nb | dev-chatpanel-ui | build+lint+gemini比例实跑 | ✅ done（ed774f5，lead 端到端复验：gemini 21:9→1408×768 宽幅=aspect_ratio 生效、gpt 16:9→2048×1152=size 正确） |
| A3 | 双 worker 并行 e2e（gpt-5.5 xhigh + sonnet-5 high） | 2 workers（端口 5200/5300 隔离） | 双绿 | ❌ NO-GO：e2e-sonnet(mock) GO，e2e-gpt(真机) 揪出对话流结果图破图（chat-result-image src=mivo-asset: 未解析→ERR_UNKNOWN_URL_SCHEME×9）。真机vs mock 交叉抓到盲区（lead A1 亦漏：只验元素 count 未验渲染）。采纳为阻塞项。 |
| A3-fix+M8 | 修破图（ChatResultImage 走 useResolvedAssetUrl）+ M8 工具条布局 | dev-chatpanel-ui（2 commit） | 真机对话流图渲染 + 工具条布局 + e2e | ✅ done（41fbe58+bcd07a2）。lead 复验：破图三重印证（ChatResultImage 走解析 hook + gpt 真机 blob/loaded + 我 assetErrors 归零 0，修复前 9）；M8 真机 flexDir:row/bottom63/局部重绘第2位/无选禁用 + 截图。生图上游本轮偶发超时=独立已知问题非破图。lead 复跑 e2e ✅ passed（MIVO_E2E_PORT=5178）。 |
| M10 | 衍生边连接点动态选最近边 + persist v8 迁移 | dev-chatpanel-ui | 真机拖拽连接点跟随+不遮挡 + build/lint/e2e | 🟡 已派 |
| M10 | 衍生边连接点动态选最近边 + persist v8 迁移 | dev-chatpanel-ui | 真机拖拽连接点跟随+不遮挡 | ✅ commit 9f215a4，代码链路复核（syncDerivationEdgeNodes:560 map createDerivationEdgeNode→动态 helper）；单元4方向 PASS；端到端真机拖拽待 A3-rerun 验 |
| A3-rerun | 修后双 e2e 重跑（含 M10 连线拖拽端到端 + 破图真渲染） | 2 workers（5200/5300） | 双 GO | ✅ 主体达标：破图彻底修复(mivo-asset 0/canvas 0-4/chat blob)、M8 工具条(452×52底部第2位)、8条主体、M10连接点逻辑(动态helper+单测4方向+v8)、console 0、分支防护生效。gpt 崩在M10前(破图已视觉确认)，sonnet全覆盖。M10横穿=独立避障功能,用户接受现状不做(YAGNI)。gpt僵尸已 archive。 |
| M9 | 全链路交互状态梳理 + 补齐缺失态（用户要的收尾） | codex gpt-5.5 xhigh | 矩阵+补齐+build/lint+不回归+真机 | ✅ 主体通过（3 commit 9584178/41acd30/271a322）：矩阵产出+补齐P0生成取消(AbortController)/P1(禁用原因/focus-visible ring/结果图错误态/空画布引导)；N/A判断克制。lead 复验：build绿、lint5预存未新增、mask零改、enhance契约安全(signal不进payload)、真机截图取消+空态生效。e2e 复核 ✅ passed（MIVO_E2E_PORT=5182）。M9 通过。 |

## UI 验收返工（用户实测 2026-07-03，lead 验收盲区）
用户浏览器实测发现 lead 验收漏掉的 UI 形态问题 + 1 功能 bug。诚实记录：lead 前面验收偏功能/e2e/数据契约，UI 只审"沿用 token/尺寸"，**未对照参考产品(lovart/线上Mivo)审交互布局形态**=盲区。
用户指出（对照参考图）：① 输入框应上下顶满(大输入区) ② 模型选择应移到输入框左下角 icon+Image/Video 两 tab（现藏在参数弹层、GPT chip 是死的）③ 比例选择应模型 icon 右边独立 icon ④ 上下文应可上下滚动 ⑤ EnhanceParamCard 不该有比例/质量操作控件(应只读展示) ⑥ **Source node not found** 功能 bug（regenerate/retry 找不到 source node）。
处置：派 3×gpt-5.5 xhigh 只读盘查——audit-ui-layout(UI形态/布局)、audit-func-bugs(功能完整性+Source node not found 根因)、audit-mask-anchor(局部重绘锚点圆圈印黑点根因)。看门狗 resume。
用户定的返工流程（2026-07-03）：① 3 worker 回来 → lead 汇总问题+定优先级 ② 修复派 gpt-5.5 xhigh 执行 ③ lead 最终 review 效果（对照参考图逐条真机验收视觉结果，不只验流程）。
额外用户反馈（局部重绘 bug）：点选锚点圆圈标记被合成进 mask/原图，二次生成结果图上留黑色实心圆。mask 三件套"零改"边界因此解除（bug 在其中）。

## LOOP 收口 2026-07-03（M7 主体，UI 返工前）
停止条件达成：验收主体全过 + A2 交叉审全采纳 + A3-rerun/M9 e2e 绿。看门狗已 schedule_pause。
M7 全链路：C1-C5(对话面板)→A1/A2/A3 三轮验收+交叉审→A1-fix(参考图+落点)/A2-fix(gemini比例+跨scene+retry)/A3-fix(破图)→M8(工具条横排)→M10(衍生边动态连线)→M9(交互态补齐)。全部 commit 在本地 demo/improve-hud（ahead origin，未 push，符合硬边界）。
收尾待用户决策：① push + 更新 PR#8 ② worktrees/p0-foundation(repo内worktree,外部残留,用户资产,已加eslint ignore) ③ scripts/m10-*、manual-verify-sonnet.mjs 临时脚本残留清理 ④ _tmp/ + Project%20MivoCanvas 垃圾清理 ⑤ 冗余 stash(hud-WIP=M10)可drop ⑥ GitLab版 create-mr worktree 改造 ⑦ /simplify 未对本轮文件跑。
| V | 视频链路 | — | — | ❌ blocked（网关无视频端点，等用户拿文档） |

## M8 后续增量（用户 2026-07-03 追加，A3 收口后执行，避免与 e2e 并行冲突）
主工具条 CanvasToolDock 布局调整：
1. CanvasAiActionBar 已删（C4），无需再动。
2. 在 CanvasToolDock 序列第 2 位（select 之后）新增「局部重绘」按钮：非工具模式而是上下文动作，复用 beginMaskEdit；未选中 image 时 disabled+提示"先选择图片"；保留 SelectionQuickToolbar 的 AI Edit>Select area 入口不动（V7 依赖）。
3. CanvasToolDock 从左侧竖排（left:18 top:70 竖 grid 54px）改为居中底部横排（left:50% bottom:18 translateX(-50%) flex row）。
时序：等 A3 收口后派 dev-chatpanel-ui 执行，改完针对新布局单独验证（含 e2e 工具条选择器可能要同步）。已向用户报方案，等其确认插队与否。

## M10 衍生边连线连接点 bug（用户 2026-07-03 追加）
现象：局部重绘生成图与原图的衍生边（M5 自动连线），同事机连接点随拖拽方向动态改边，用户本机固定一侧 → 连线遮挡图片。"同代码不同表现"疑点：持久化旧边数据 / 拖拽不重算连接点 / 代码固定 anchor。
标准（lead 定）：衍生边连接点动态跟随两节点相对位置（选最近边/最短路径），拖拽实时更新，本机与同事一致，连线不遮挡图片；真机拖拽验证 + 旧持久化数据兼容（迁移或运行时重算）。
时序：先只读根因调查（现派 codex gpt-5.5 xhigh，不改码不冲突）→ 诊断清楚后修复并入下一开发轮。
【M10 调查完成 2026-07-03】根因=C 代码本就固定：createDerivationEdgeNode(canvasStore.ts:461-462) 硬编码 connectorStart.anchor='right'/connectorEnd.anchor='left'（M5 0e5e597 起就固定）；拖拽经 patchActiveCanvas→normalizeCanvasGraph 会重投影但仍固定 right/left，不选最近边。动态选边逻辑 connectorSideBindingForPoint(connectorGeometry.ts:35-58) 仅用于手动 connector（useCanvasInteractionController），衍生边未复用。诚实点：同代码不该有"同事动态/本机固定"差异——同事看到的动态更可能是手动 connector snap / 未提交改动 / 旧缓存视觉误判；但修复照做（用户要动态连接点这个结果）。
【lead 定修复标准】① connectorGeometry 新增/导出 helper：给 source+target 两节点枚举四边选距离最短 anchor 组合（含 offset）；② createDerivationEdgeNode 用 helper 替固定 right/left + 初始化 markupPoints；③ 拖拽已走 normalizeCanvasGraph 自然重算；④ 旧数据兼容 = persist v7→v8 migrate 触发重建投影（轻方案，不做"不持久化投影节点"大重构 YAGNI）。改动面 canvasStore.ts（高危共享）+ connectorGeometry.ts。时序：等 A3-fix+M8 完成后串行派（避免 canvasStore 并发写冲突）。真机拖拽验证连接点跟随+不遮挡。

## M9 全链路交互状态梳理（用户 2026-07-03 追加，最后一步）
触发：loop 主体（对话面板+M8+M10）全绿收口后。
执行：gpt-5.5 xhigh 遍历所有已有功能链路（文生图/图生图/mask/参考图/Eagle/画布交互/生成任务），逐链路梳理交互状态覆盖（default/hover/active/focus/loading/disabled/error/empty/success/取消），补齐缺失状态让体验丝滑。
标准（lead 定）：产出「链路×状态」矩阵（标现有/缺失）→ 补齐缺失 → 前后对比 + 真机验证 + 不回归已验收功能；样式沿用现有 token 体系。

## 外部 agent stash 事故（用户 2026-07-03 报告，已查清=零损害）
现象：用户在另一 agent 处操作，在 demo/improve-hud 同一 repo 做了 git stash（stash@{0}: hud-WIP-before-roadmap-switch-20260703-022314），担心把 M10/HUD WIP 弄丢。
lead 只读诊断结论：
- HEAD=9f215a4（M10）完整，工作树干净，C3→M10 所有 commit 都在。
- stash 内容 = M10 改动本身（derivationConnectorBindingsFor + createDerivationEdgeNode 动态 + persist v8）+ 一个无关 PIPELINE.md 文档更新。
- **stash 的 connectorGeometry.ts 与 HEAD 9f215a4 IDENTICAL**；canvasStore.ts 也都含动态 helper + version:8 → stash 代码已 100% 被 HEAD 包含，冗余中间快照，零损害。
- 处置：lead 不动 stash（避免与外部 agent 抢 git），可安全 drop 留待用户/那边 agent；M10 是否真生效由 A3-rerun 真机拖拽验证兜底（用户要求"最后一起验收有无修复"）。
最终验收清单：① A3-rerun 真机验 M10 连线动态跟随 ② 确认无 stash 残留干扰 ③ 冗余 stash 可清理。

## 外部 agent checkout 事故 #2（用户 2026-07-03，已恢复=零损害）
现象：外部 agent 在同一工作树 `git checkout feature/docs-productization-roadmap`，工作树 HEAD 变 dbc1d9d、磁盘回退到无 M7 版本（derivationConnectorBindingsFor 0 匹配）、大量 docs 显示 D。
真相（reflog）：只是 checkout 切分支，**demo/improve-hud 指针没动，仍指 9f215a4**，M7 全部 commit 完好。
恢复（用户停掉外部 agent 后）：`git checkout demo/improve-hud`（切回，exit0，ahead origin 10 commits）+ `git restore docs/`（恢复误删 tracked docs）→ 源码 M10 恢复（canvasStore 2 + connectorGeometry 1 处 helper）、build 绿 240ms、工作树回正常态。零损害。
根因=多 agent 抢同一 git 工作树（本会话第 2 次）。教训：并行 agent 必须用独立 worktree 隔离。stash@{0} + feature/docs-productization-roadmap 分支为外部 agent 产物，lead 不动（用户资产）。

## 偏航检测基线（每轮对照）

- 原目标不变：对话式面板 + agent 增强 + 双回流 + mask 兼容 + 响应快。
- 验证标准只来自 rev2 计划验收 8 条 + probe-results 实测，不接受实现自证。
- 出现"为让实现成立而改验收口径"→ 停，出偏航报告。

## 轮次日志（lead 追加）

- R1 2026-07-02：P0 完成（probe-results.md）；C1+C2 曾派 dev-chatpanel-backend(codex)；loop 文件建立；看门狗已挂（30min 定时任务）。
- R2 2026-07-02：用户停掉 codex worker（刚派即停，无半成品，git 树干净）；C1+C2 重派 sonnet-5 high + /goal（dev-chatpanel-backend-v2）。
- 心跳 2026-07-02：dev-chatpanel-backend-v2 status=running（C1/C2 进行中），正常，本轮静默。
- 心跳 2026-07-02（+15min）：dev-chatpanel-backend-v2 仍 running，正常，本轮静默。
- 心跳 2026-07-02：dev-chatpanel-ui running（C3-C5 进行中），backend-v2 done 已收口，正常，本轮静默。
- 心跳 2026-07-03 00:00：dev-chatpanel-ui running（C3-C5），正常；距截止 8h（>6h 不触发风险提醒），本轮静默。
- 心跳 2026-07-03 00:15：dev-chatpanel-ui running（C3-C5），正常，本轮静默。
- R4 2026-07-03 00:44：C3-C5 汇报到达，lead A1 走查（真实 API 10 步，8 pass）。2 必修派回 dev-chatpanel-ui（参考图接线 + slot{0,0}落点），并行启动 A2 Codex gpt-5.5 xhigh 交叉审。mask S9 失败=已知 P1 edit 上游>200s 超时（非新代码，notice 路径已验证正确）；console 4× 为 Eagle 缩略图已知噪音。均不阻塞。
- 心跳 2026-07-03 00:44：A1-fix 与 A2 刚派，正常，本轮静默。
- R5 2026-07-03：A1-fix 复验通过（124e3c4，editCalled=true、slot{-106,-106}）。A2 交叉审完成 REQUIRES_CHANGES，3 blocking（gemini比例/跨scene归属/retry上下文）+3nb，lead 逐条核实全属实全采纳，派 A2-fix。
- 心跳 2026-07-03：dev-chatpanel-ui running（A2-fix），正常，本轮静默。
- 心跳 2026-07-03：dev-chatpanel-ui done（A2-fix 完成），汇报消息未达属正常兜底中间态，本轮静默；下一心跳若仍无汇报则诊断。
- R6 2026-07-03：A2-fix 汇报到达，lead 端到端复验通过（ed774f5，gemini 21:9→1408×768 aspect_ratio 生效、gpt 16:9→2048×1152 size 正确）。A1+A2 收口。派 A3 双 e2e（e2e-gpt 5200 / e2e-sonnet 5300 并行）。
- 心跳 2026-07-03：e2e-gpt + e2e-sonnet 均 running（A3），正常，本轮静默。
- R8 2026-07-03：A3 e2e-gpt(真机) 报告 NO-GO，揪出对话流结果图破图（chat-result-image 直接用 mivo-asset: 未解析）。lead 采纳，派 A3-fix（ChatResultImage 走 useResolvedAssetUrl）+ M8 工具条布局（用户追加）给 dev-chatpanel-ui。用户再追加 M9（全链路交互状态梳理，全绿后做）+ M10（衍生边连线连接点 bug）；派 investigate-derivation-edge 只读调查 M10 根因。
- 心跳 2026-07-03：dev-chatpanel-ui（A3-fix+M8）+ investigate-derivation-edge（M10 调查）均 running，正常，本轮静默。
- R9 2026-07-03：M10 调查完成（根因=代码固定 right/left）。A3-fix+M8 汇报+lead 复验通过（破图三重印证、M8 布局真机+截图、e2e 复跑 passed）。派 M10 修复给 dev-chatpanel-ui（动态选最近边+persist v8）。
- 心跳 2026-07-03：dev-chatpanel-ui 跑 M10 修复，正常，本轮静默。
- R10 2026-07-03：M10 汇报（9f215a4 单元4方向PASS，端到端待验）。lead 复核代码链路发现磁盘 canvasStore 是旧固定版→查出外部 agent checkout 事故#2→用户停 agent 后 git checkout demo/improve-hud + restore docs 完整恢复（M7 零丢失，build 绿）。派 A3-rerun 双 worker（e2e-rerun-gpt 5200 / e2e-rerun-sonnet 5300），加开工验分支硬防护，重点验破图+M10连线端到端。
- 心跳 2026-07-03：e2e-rerun-gpt + e2e-rerun-sonnet 均 running，正常，本轮静默。
- 心跳 2026-07-03（A3-rerun 进行中）：两 tester 仍 running，正常，本轮静默。期间与用户讨论 create-pr/cleanup-branch 加 worktree 隔离方案（防多 agent 抢工作树），待用户答复 maker 能否会话内切目录 + 是否改 skill。
- R11 2026-07-03：A3-rerun 判定通过（破图铁证修复/M8/8条主体/M10逻辑，横穿接受现状，gpt僵尸archive）。期间完成 skill 改造（create-pr+cleanup-branch 方案A worktree 隔离，用户选A；EnterWorktree 分支命名未实测有兜底；GitLab版 create-mr 待用户定）。派最后一步 M9（interaction-states，codex gpt-5.5 xhigh）。
- 心跳 2026-07-03：m9-interaction-states running（刚派），正常，本轮静默。
- 心跳 2026-07-03：m9-interaction-states 仍 running（多链路梳理+补齐，耗时正常），本轮静默。
- R7 2026-07-03：A3 Worker B（e2e-sonnet）报告到达 → GO。e2e smoke passed；V1-V6+V8 PASS，V7 PARTIAL(mask 前端入口 OK+已知P1上游慢)；UI 样式合规（.ai-panel 340/58px、token 全对、无新设计语言）；丝滑度 1 处轻量建议（panel transition:all 可收窄，不阻）。等 Worker A（e2e-gpt）报告合并裁定。
- R3 2026-07-02：C1/C2 汇报到达，lead 独立复验通过（commit a3ba39b/6cf51df、build 193ms、lint 边界内清洁、enhance 实测 5.0s）→ C1/C2 ✅。派 C3+C4+C5 给 dev-chatpanel-ui（sonnet-5 high + /goal）。工期决策：受明早 08:00 硬截止约束，D13 的 skill 调用改为 lead 直接把蒸馏后的交互硬约束写入任务书（省 token/时间，UX 把关移到 A1 lead 实跑），偏离已记录。
- [看门狗心跳 2026-07-03 ~04:2x] audit-ui-layout ✅ done（9 条问题已收录 ui-audit-round2.md）；audit-func-bugs 🟡 running(idle 3.2m)；audit-mask-anchor 🟡 running(idle 10.3m)。均正常，本轮静默。
- [返工 Round2 2026-07-03] 三份盘查全齐（ui-layout 9 条 / func-bugs 7 条 / mask-anchor 根因=点选锚点即 mask 圆洞）。Lead 已定稿优先级清单（见 review/ui-audit-round2.md）：P0×3（scene-scoping / mask 锚点 / 弹层裁剪）、P1×5（UI 目标形态+retry 上下文）、P2×2、A7 窄屏 deferred。修复派 audit-func-bugs 转执行（gpt-5.5 xhigh），S1 UI→S2 功能→S3 mask 三阶段串行，每阶段 commit+build/lint+截图，最后全量 e2e。Lead 最终对照参考图真机验收。
- [流程升级 2026-07-03] 用户追加要求：fixer 回报后，lead **亲自**对所有功能 UI 的位置布局/样式/流程状态做一次兜底审查，并 invoke 设计类 skill（frontend-design / ui-ux-pro-max / 中文排版规范 / frontend-patterns）**亲自动手修正**打磨到足够美观——不再只是验收打分，发现不美观直接改。审查范围=全部功能链路：chat 面板（composer/弹层/消息流/参数卡）、主工具条、mask 局部重绘、画布节点/连线/选择态、加载/错误/空态。
- [看门狗心跳] fixer（audit-func-bugs 转修复）running，idle 2.9m，正常执行 Round2 三阶段修复中。本轮静默。
- [收口流程定稿 2026-07-03] 用户确认最终链路：① fixer S1-S3 修复完 → ② lead 兜底设计审查+invoke 设计 skill 亲自修到美观 → ③ 最终代码派 2 个 gpt-5.5 worker 交叉确认无误 → ④ 执行「提交 PR」skill（submit-pr：push + 10 维度深度审查 + PR 评论）。注：此步含 push 到 origin（kirozeng 私有仓）更新 PR #8，为用户本轮显式授权。
- [看门狗心跳] fixer running，idle 10.8m（<30m 阈值），Round2 修复继续。本轮静默。
- [看门狗心跳] fixer idle 25.9m 但 git 证实实质进展：S1 已 commit（484c1c3 fix(demo-r2): S1 chat panel shape），工作区正改 chatStore/canvasStore/MivoCanvas/generation.ts = S2 scene-scoping 进行中。正常，本轮静默。
- [看门狗心跳] fixer idle_ms 40.9m 超阈值，但文件 mtime 证实 59 秒前刚改过 canvasStore.ts（S2 进行中）——idle 指标只算消息输出不算编辑活动，实际活跃。判定正常，不催告，本轮静默。
- [看门狗心跳] S2 已 commit（a27806e scene-scoped generation）；ImageMaskEditOverlay.tsx 3.5 分钟前刚改 = S3 mask 锚点阶段进行中。fixer 活跃正常，本轮静默。
- [Round2 修复完成 2026-07-03] fixer 交付三 commit：S1 484c1c3（UI 形态）/ S2 a27806e（scene-scoped）/ S3 2a420f4（mask 点选锚点 UI-only）。A1-A9(除A7 deferred)/B1-B7/C 全部报修复，build+lint+e2e 绿，证据 _tmp/fix-round2-out/。残余风险：point-only 无 mask 提交仅 mock 验证，未打真实上游。→ 进入 lead 兜底设计审查（真机+设计 skill+亲自修正），其中含真实上游 point-only 验证。
- [看门狗心跳 + lead 审查进展] fixer 已交付并归位（无活跃 worker，无需催告）。Lead 兜底审查进行中：已亲修 4 处打磨（气泡 pre-wrap / 弹层入场动画 / 控件 140ms 过渡 / 质量 chip 中文化），build+lint 绿；真上游文生图双落验证通过；Phase C point-only mask 真上游验证第三次运行中（前两次为脚本自身选择器问题，非产品 bug）。
- [Lead 兜底审查结论 2026-07-03] 全部通过：① 真上游文生图双落 ✓ ② 真上游 point-only 局部重绘（粉发→蓝发）结果零黑点，P0-2 修复真机确认 ✓ ③ UI 形态对照参考图逐项达标（composer 顶满/模型 tabs/比例弹层/参数卡只读/思考态取消/错误态重试）④ lead 亲修 4 处打磨：气泡 pre-wrap、弹层 140ms 入场动画、控件统一过渡、质量 chip 中文化（HMR 真机验证生效）。e2e 复跑中，绿后 commit → 派 2 gpt-5.5 worker 终审 → submit-pr。
- [勘误 2026-07-03] 上条"e2e 复跑中，绿后 commit"随后的一次 e2e 实际 FAIL（gemini 21:9 断言 got null），当时被 `| tail` 管道掩盖了退出码、误判为绿——lead 已在 f3a07e6 提交打磨后发现并如实回溯。根因=测试竞态（.dom-node 计数在 slot 创建即增长，断言先于 generate 请求捕获），非产品回归、与打磨 CSS 无关。已加固断言（轮询等待请求捕获），全量 e2e 复跑中（本次直接读退出码）。
- [看门狗心跳] 双终审 worker 均 running（ui 视角 idle 5.1m / func 视角 idle 4.9m），刚派不久，正常。本轮静默。
- [终审 1/2 2026-07-03] func 视角（audit-mask-anchor）：APPROVED 零阻塞。实跑 build/lint/e2e 全 exit 0；核验 scene-scoped 写回链路、跨 scene notice/删除降级、retry 上下文（含 asset 失效禁用重试）、mask point/regions 彻底分离、regenerateWithParams 无悬空引用。非阻塞建议 1 条（补 asset 缺失分支 e2e）→ 记入 deferred。等 UI 视角终审。
- [终审 2/2 2026-07-03] UI 视角（audit-ui-layout）：APPROVED 零阻塞。A1-A9 逐条复核达标，lead 打磨 4 项无副作用，e2e 竞态修复判定合理；实跑 build/lint/e2e 全 exit 0 + 1024px 视口真机度量。非阻塞建议 2 条（Escape 后焦点还给触发按钮 / 清理 App.css 旧选择器残留）→ 记入 deferred。
- [双终审通过 → 进入 submit-pr] deferred 汇总：① asset 缺失分支 e2e ② Escape 焦点归还 ③ App.css 旧选择器清理 ④ A7 窄屏响应式。
