# 三组双轨删轨决议（renderer / kernel / persist）

日期：2026-07-12
来源任务：`docs/plan/remaining-tasks-cutover-plan.md` §7 D-4
作者：D-4 worker（分支 `docs/d4-dual-track-removal`）

> **文档性质**：决策**建议**文档。最终拍板权在用户/lead。每组给「推荐 + 备选」，
> 不写死。所有判据必须是可观测的数字/事件（不允许"稳定后""观察一段时间"这类不可判定表述）。
> 事实依据全部实查于 origin/main（HEAD `2606601`，2026-07-12 fetch 后实值；源码自 `1b9c92c`
> 至 `2606601` 仅 #215 纯文档变更，源码零差异，故 file:line 在两 SHA 等价可验），引用带 file:line。

> **r2 返修记录（2026-07-12）**：lead + gpt-5.6-sol 双审 REQUIRES_CHANGES，6 条 finding
> （3 P1 + 3 P2）逐条核证源码后修复——①persist memory 重定位为"切换前兼容/测试轨"非回滚通道；
> ②MemoryDocKernel 误列 legacy 移除，改列真正 legacy 项；③删 required CI job 补两阶段
> 分支保护迁移；④观察窗数字门槛补可采集查询命令 + 删倒算日期 + 标 label/telemetry 前置；
> ⑤删除范围补 rendererFallback/package.json pixi/app.ts 双 backend/permissions memory 半/
> persistTestApp；⑥kernel C 门控补一次性 checkpoint + 契约测试，D 门控改 machine-readable 事件 +
> CI 矩阵改动入 C-switch 范围。基线 SHA 同步刷新 `1b9c92c`→`2606601`。

---

## 0. 背景与共性问题

三组双轨并行让每次画布/内核/持久层改动都背 2×2×2 验证成本（renderer × kernel × persist
笛卡尔积在 CI 里实跑，见 §1.4）。原计划对删轨条件只有一句"P4 验收后删"，不可执行。本文件
为每组钉死五个要素：

1. **默认切换条件**——把默认从 A 轨切到 B 轨的可判定指标（数字/事件）
2. **观察窗指标与时长**——切默认后观察多久、看哪些可观测指标
3. **删除 PR 范围清单**——删哪些文件/旗标/CI 维度（精确到路径）
4. **回滚终止日**——回滚通道保留到哪天，之后只能 git revert
5. **owner**——谁拍板执行

**通用回滚语义**：删轨前，旧轨=回滚通道——但**只有"无状态切换"轨的 flag 回退是真回滚**：
`?renderer=dom` / `?kernel=legacy` 切回旧轨不丢数据（渲染层、内核层是无状态投影层，真相源在
PG persist / IDB canonical，flag 只切投影路径，legacy kernel 回退经契约 §4.3 checkpointed
rollback 仪式，ckpt 保险）。**persist 的 `MIVO_PERSIST_BACKEND=memory` 不是回滚通道**——
`backend.ts:276` 明写 InMemory「非 PG——重启清空」，cutover S7 不可逆点后数据已迁 PG，
re-point 工厂回 memory 读到的是**空库 = 数据消失**，不是回滚（与 `remaining-tasks-cutover-plan.md:102`
「S1-S7 序列一字不改；回滚=冻结窗；S7 不可逆点」直接冲突）。故 persist 回滚语义单独定义见 §2.3 ④。
删轨 PR 合并=对应 flag 回退通道物理消失，之后回滚只能靠 git revert 删轨 PR（且越往后
revert 越痛）。故「回滚终止日」=删轨 PR 合并日，其本身被观察窗指标门控。

---

## 1. 事实依据实查表（origin/main `2606601`）

### 1.1 renderer 现状

| 事实 | 证据 |
|---|---|
| 默认渲染器已是 `leafer` | `src/render/rendererMode.ts:20` `const DEFAULT_MODE: RendererMode = 'leafer'` |
| 默认切换 PR 已合入 | git log `c557c4c feat: 默认渲染器切换 dom → leafer(双轨保留,?renderer=dom 应急回退) (#131)`（2026-07-06） |
| `?renderer=dom` 是保留应急回退通道 | `src/render/rendererMode.ts:11-12,47-50`（dom 分支 + 日志"应急回退通道，默认已是 leafer"） |
| `?renderer=pixi` 是 0g spike 遗留（NO-GO，工装专用） | `src/render/rendererMode.ts:13,51-54`；判决见 `docs/reports/phase-0g-engine-combo-outcome` |
| 渲染器适配器契约区分两轨 | `src/render/rendererAdapter.ts:29` `readonly mode: 'dom' \| 'leafer'`；`src/render/rendererAdapter.ts:23-26` 注明 DOM 走 `<DomRenderer>` 声明式 |
| dom 轨主文件 | `src/render/DomRenderer.tsx`；引用方 `src/render/rendererAdapter.ts`、`src/render/textPaintMode.ts`、`src/render/useEngineSpikeRenderers.ts`、`src/canvas/MivoCanvas.tsx` |
| **永久 DOM overlay（不属 dom 轨，不删）** | FU-11 markup 文字层 `#124`（`c7f84d6`）、FU-12 frame 标题 `#125`（`e5bd9ad`）、选中壳 `#132`（`bddfad6`）——leafer 模式下仍用 DOM overlay 渲染，是 leafer 轨组件 |

### 1.2 kernel 现状

| 事实 | 证据 |
|---|---|
| 默认内核仍是 `legacy` | `src/app/kernelMode.ts:24` `const DEFAULT_MODE: KernelMode = 'legacy'` |
| 双轨契约阶段表 A→B→C→D | `docs/decisions/kernel-dualtrack-contract.md` §4 表（A=默认 legacy 当前 T0.3；B=shadow 读；C=单写切换 new；D=删 legacy） |
| 契约明写切默认 new 的硬前置 | `docs/decisions/kernel-dualtrack-contract.md` §8：FX-6（缓存 per-user 化）+ T1.2a（record schema）+ 阶段 B shadow 读契约测试全绿 |
| 契约 §9 验收里 e2e 透传标 `[ ]`（T0.7/PR #166 落地）——**契约文档陈旧** | `docs/decisions/kernel-dualtrack-contract.md:280`（`[ ] e2e --kernel= 透传与 CI 门禁`） |
| 实际：T1.2 S1-S6d 已合入 main，new 路径接活，e2e-kernel-gate 翻 required（2026-07-10） | `.github/workflows/ci.yml:142-146,212-217`（注释明写"T1.2 S1-S6d 已合入 main,kernel=new 路径已接活;e2e-kernel-gate 自 2026-07-10 起翻 required"） |
| 结论：kernel 实际处于 **阶段 B**（shadow compare 已做、new 藏身开关后、默认未切），**C/D 未走完** | `src/app/kernelMode.ts:24` 默认 legacy + ci.yml new 接活但默认未切 |
| 删轨必须挂在契约阶段上，不许跳阶段 | `docs/decisions/kernel-dualtrack-contract.md` §4 D 行："legacy 代码与开关一起删"——D 的前置是 C 完成 |

### 1.3 persist 现状

| 事实 | 证据 |
|---|---|
| 默认后端是 `memory` | `server/persist/pgConfig.ts:40` `const kind = env.MIVO_PERSIST_BACKEND === 'pg' ? 'pg' : 'memory'` |
| 工厂默认注入 InMemoryPersistBackend | `server/persist/backend.ts:1225` `export const createPersistBackend = (): PersistBackend => new InMemoryPersistBackend()` |
| InMemoryPersistBackend 类（重启清空，过渡实现） | `server/persist/backend.ts:281`；注释 `:274` "默认内存实现(T1.3 过渡;PG 落地前用)" |
| PG backend 已实现 | `server/persist/pgBackend.ts`、`server/persist/pgPermissionBackend.ts`、`server/persist/pgConfig.ts`、`server/persist/migrations/001_permissions.sql` |
| swap 注入点已钉（不改路由/契约） | `server/persist/backend.ts:6-11` TODO："server/app.ts 注入点从 InMemoryPersistBackend 换 PgPersistBackend,路由 handler 零改动" |
| 双后端契约测试（memory + pg 同一接口） | `server/persist/backend.contract.dual.test.ts`、`server/persist/permissionBackend.contract.dual.test.ts`（`.dual` = 双后端） |
| cutover 切默认 pg 走 §6 Gate3 S1-S7 | `docs/plan/remaining-tasks-cutover-plan.md` §0 阶段 A "服务端底座接入生产" + §6 S1-S7 |

### 1.4 CI 双轨成本（`.github/workflows/ci.yml` 实际维度）

| CI job | 双轨维度 | 删轨后变化 |
|---|---|---|
| `e2e-prod-subset`（`:136`） | `--renderer=both`（dom+leafer，5 场景 × 2）+ 默认 legacy kernel | dom 删→只跑 leafer；kernel 删→legacy 不再跑 |
| `e2e-kernel-gate`（`:217`） | `--renderer=both --kernel=new`（dom+new / leafer+new） | dom 删→只 leafer+new；kernel 删→整 job 并入 e2e-prod-subset |
| `visual-diff`（`:283`） | dom baseline vs leafer candidate，3 fixture（rotation/brush-stamp/markup-text） | dom 删→**整 job 删除**（无 dom baseline 可对照） |
| `pg-suite`（`:412`） | postgres:16 service container + 4 PG-gated 文件（`backend.contract.dual` / `backend.pg` / `permissionBackend.contract.dual` / `persist.route.dual`），32 契约场景 + 并发回归 | persist 删轨→`.dual` 文件改 PG-only，job 保留（PG 仍需测） |
| `build-and-test`（`:34`） | lint + tsc + unit + logging | 删轨后 unit 覆盖面缩小，需同步删旧轨单测 |

> 笛卡尔积：`e2e-prod-subset`（legacy × dom/leafer）+ `e2e-kernel-gate`（new × dom/leafer）
> = (renderer × kernel) 全覆盖（contract §7）。任一维删轨，矩阵降一阶。

### 1.5 CI required job 两阶段迁移（删轨前置）

main 分支保护 `required_status_checks.contexts`（repo 级，`enforce_admins=true` 实测 2026-07-12
fetch）含 9 个 required context，其中两个直接绑双轨删轨：

| required context（exact 名） | 绑定 job | 删轨触发 | 删除后后果 |
|---|---|---|---|
| `visual diff (dom vs leafer)` | ci.yml `visual-diff`（`:283`） | renderer 删轨 | job 删 → context 永不上报 → 所有 PR 永卡 Expected |
| `e2e kernel gate (new)` | ci.yml `e2e-kernel-gate`（`:217`） | kernel 删轨 | 同上 |

直接删 job = main 分支保护拒合所有 PR（context 永远 Expected，`enforce_admins=true`
连管理员都不豁免——`enforce_admins` 禁的是**绕过**规则，admin 仍可**编辑**规则本身）。
故每个 required job 必须两阶段迁移，**顺序写死**：

**阶段 1（admin 改分支保护，settings 动作非代码 PR）**：repo admin（`permissions.admin=true`
实测，PraiseZhu）从 `required_status_checks.contexts` 移除旧 context 名（PUT 全量 contexts
数组，去掉目标项）。这是 settings 级原子更新，不走 PR、即时生效。

```bash
# 取当前 9 个 required contexts（确认目标在列）
gh api repos/xindong/mivo-canvas/branches/main/protection \
  --jq '.required_status_checks.contexts'
# 移除旧 context：PUT 全量数组，保留其余项、不列目标项 = 移除它
gh api -X PUT repos/xindong/mivo-canvas/branches/main/protection/required_status_checks \
  -F strict=false -F contexts='["lint + tsc + unit + logging","structure guard (anti-regression)","e2e prod subset (mock upstream)","e2e token gate (authorized)","e2e token gate (unauthorized)","secret scan (gitleaks)","pg suite (PG16)"]'
# ↑ 例：移除 "visual diff (dom vs leafer)" 与 "e2e kernel gate (new)" 两者；renderer 删轨只移前者，kernel 删轨只移后者
```

**阶段 2（代码 PR 删 job）**：context 移出 required 后，开 PR 删除 ci.yml 中对应 job 段。
此时 PR 不再被旧 context 卡（已非 required）→ CI 绿 → 合并。

**验收命令**（合并后确认 context 已消失 + job 已删）：

```bash
# 期望 0（context 已从 required 移除）
gh api repos/xindong/mivo-canvas/branches/main/protection \
  --jq '.required_status_checks.contexts' | grep -c 'visual diff (dom vs leafer)'
# 期望 0（job 已从 ci.yml 删除）
grep -c '^  visual-diff:' .github/workflows/ci.yml
```

**trunk-guard org ruleset（id `18006872`，member 无权改）边界**：该 org 级 ruleset 实测只管
`deletion` / `non_fast_forward` / `pull_request`（`required_review_thread_resolution=true`）
/ `code_scanning` / `code_quality` / `copilot_code_review`，**不含 required_status_checks**——
故 CI context 迁移**不触 trunk-guard**，repo admin 改 repo 级分支保护即可，无需 org owner。
唯一与 trunk-guard 相关的卡点：删轨 PR 本身的 Greptile review 线程必须 resolve
（`required_review_thread_resolution=true`）——member 无法强 resolve 他人线程，需 org owner
出手。这是 **per-PR 审查卡点**，不是 CI context 卡点，与两阶段迁移正交。

**回滚**：阶段 1 后若阶段 2 PR 出问题，admin 重新 PUT 旧 context 回 required contexts（即时
恢复 required），job 段还在（PR 未合并前 ci.yml 未变）。合并后回滚 = git revert 删 job 的 PR
+ admin 把 context 加回 required。

---

## 2. 三组删轨决议

### 2.1 renderer（dom → leafer）——最接近删轨

**当前阶段**：默认切换**已完成**（#131, 2026-07-06，`rendererMode.ts:20` DEFAULT_MODE='leafer'）；观察窗须待 telemetry 上线才起算（当前 telemetry 未上线，窗口未起算，无"第 N 天"可计——见 ② 前置）。

#### ① 默认切换条件
切换已发生（`rendererMode.ts:20` DEFAULT_MODE='leafer'）。无待办切换动作；
本组实际是「删轨条件」，即观察窗指标全部满足后才能删 dom 轨。

#### ② 观察窗指标与时长
**观察起点 = telemetry 上线日**（见下「前置：观测能力」），**不是** #131 合并日 2026-07-06——
r1 把起点倒算回 #131 是错的：`rendererMode.ts:48/52/37` 全是 `debugLogger.log`（level='log'），
`remoteDebugReporter.ts:3`（`ReportableDebugLogLevel = 'warning'|'error'`）、`:70-71`、`:125-127`、
`:161-162` 三道过滤后**永不到达服务端**，只在浏览器 240 条 ring buffer（`debugLogStore.ts:20,50`），
页面关/刷新即清——故 dom/pixi 请求计数在 telemetry 上线前**不可采集**。推荐时长 **30 天**
（= telemetry 上线日 + 30 天，覆盖 2 轮周使用模式；不数 cron 部署——cron 拉的是 main 重启 pm2，
不产生 `?renderer=dom` 用户流量，不是观察密度代理）。所有指标须在删轨 PR 开工前连续满足：

**前置：观测能力（删轨前必须先上线，否则 dom/pixi 计数指标不可判定）**：

| 前置 | 动作 | 验收命令 |
|---|---|---|
| dom/pixi 请求计数 telemetry | 把 `rendererMode.ts:48/52` 的 `debugLogger.log` 升级为 `debugLogger.warn`（则 remoteDebugReporter 远传），或 BFF 加 `?renderer=` 命中计数器（生产 `?renderer=dom`/`pixi` 命中时 POST `/api/mivo/renderer-mode`） | telemetry 上线后连续 30 天可在 BFF/PG 查到 dom/pixi 计数 |
| GitHub labels | 创建 `renderer`、`leafer` label（repo 现只有 9 个默认 label，无此二者） | `gh api repos/xindong/mivo-canvas/labels --jq '.[].name' \| grep -E 'renderer\|leafer'` 期望非空 |

| 指标 | 阈值 | 数据源 + 可运行查询命令（样例输出） |
|---|---|---|
| 生产 `?renderer=dom` 请求计数 | = 0（连续 30 天） | telemetry 上线后查 BFF/PG 计数器，样例：`SELECT count(*) FROM renderer_mode_hits WHERE mode='dom' AND ts > now()-interval '30 days'` → `0`。telemetry 未上线时**不可判定**，窗口不得开始 |
| `?renderer=pixi` 工装外访问 | = 0 | 同计数器 `WHERE mode='pixi'`（排除工装 IP 白名单）；telemetry 未上线不可判定 |
| e2e `--renderer=both` 连续绿 merge 数 | ≥ 20 个 PR 合并 | `gh pr list -R xindong/mivo-canvas --state merged --limit 25` + 每个 PR 的 `e2e prod subset (mock upstream)` 与 `e2e kernel gate (new)` check 绿：`gh pr checks <PR#> --required \| grep -c 'success'` 期望含 2 |
| visual-diff dom vs leafer diff% 连续 PASS | ≥ 20 个 PR（DIFF_THRESHOLD_PERCENT 默认 5%，`scripts/visual-diff.mjs`） | PR 的 `visual diff (dom vs leafer)` check 绿：`gh pr checks <PR#> --required \| grep 'visual diff'`；job summary 表 PASS 行 ≥ 20 |
| leafer 渲染回归 bug（P0/P1） | = 0 件（30 天内） | `gh issue list -R xindong/mivo-canvas --label renderer --label leafer --state open --search "P0 OR P1"` 期望空（**前置：先建 label，见上**） |
| leaferPaintSignature bench dragP95 | < 8ms 且 < allP95（连续 20 PR，非阻断但监控） | `bench` job summary（`leaferPaintSignature.bench.test.ts`）；**已知 flaky**（issue #172，共享 runner 毫秒级阈值抖动），单 PR 超阈不阻断，看 20 PR 中位数趋势 |

#### ③ 删除 PR 范围清单
**只删 dom 渲染器轨**，不删永久 DOM overlay（text/markup/frame-title/选中壳是 leafer 模式组件）。

| 类别 | 路径 | 动作 |
|---|---|---|
| 渲染器轨主文件 | `src/render/DomRenderer.tsx` | 删除 |
| 渲染器模式开关 | `src/render/rendererMode.ts:18,22,47-50` | `RendererMode` 去掉 `'dom'`；`VALID_MODES` 去 `dom`；删 dom 分支（`:47-50`） |
| pixi spike 遗留（同步清，NO-GO） | `src/render/rendererMode.ts:13,51-54`；`src/render/usePixiSpikeRenderer.ts`；`src/render/useEngineSpikeRenderers.ts` pixi 分支 | 删除（pixi 非本组双轨，但同为渲染器维冗余，建议同 PR 清） |
| 适配器契约 | `src/render/rendererAdapter.ts:29` | `mode` 收为 `'leafer'`；删 `:23-26` DOM 声明式注释 |
| 消费方 dom 分支 | `src/canvas/MivoCanvas.tsx`、`src/render/textPaintMode.ts` | 删 dom 分支，只留 leafer |
| 降级管道（fallback 语义重定义） | `src/render/rendererFallback.ts:3-18`（`computeEffectiveRendererMode`：pixi 或 leafer init 失败（`fallbackToDom=true`）→ effectiveRendererMode 降到 `'dom'`，DOM 接管） | 迁移：删 dom 后此 fallback 到 dom 无意义（dom 轨已删）。**必须先重定义失败语义**——leafer init 失败时改为"leafer retry + 错误 toast + `debugLogger.warn`（不上报 blank dom，避免白屏）"。与上一行 `rendererMode.ts` 去 `'dom'` union 耦合（fallback 返回类型不再含 `'dom'`）。保留文件改逻辑；`rendererFallback.test.ts` 的 dom-fallback case 改新语义 |
| pixi.js 依赖 | `package.json:42`（`"pixi.js": "^8.19.0"`） | 删除（随 pixi spike 遗留清理，:115 行已列 pixi 源文件；dep 同 PR 清，避免孤儿依赖——r1 漏列） |
| e2e 旗标 | `scripts/e2e-runner.mjs`、`scripts/e2e-smoke.mjs`（`parseRenderer` / `--renderer`） | 删 `both`/`dom`，leafer-only（或整体去 `--renderer` 旗标） |
| visual-diff harness | `scripts/visual-diff.mjs`、`scripts/visual-shell-baselines.mjs` | 删除（无 dom baseline） |
| CI job | `e2e-prod-subset`（ci.yml `:136` job / `:182` run）：去 `--renderer=both` → leafer-only；`e2e-kernel-gate`（`:217`/`:252`）：去 `--renderer=both`；`visual-diff`（`:283`）：整段删（无 dom baseline 可对照） | 见 §1.5「CI required job 两阶段迁移」——`visual diff (dom vs leafer)` 是 required context，直接删 job 会让所有 PR 永卡 Expected |
| 单测 | `src/render/rendererMode.test.ts`、`src/render/rendererFallback.test.ts`、`src/render/useEngineSpikeRenderers.failsafe.test.ts`、`src/render/usePixiSpikeRenderer.ts` 关联测 | 删 dom/pixi case |
| 文档 | `CLAUDE.md`（"默认渲染器"段 + "?renderer=dom 应急回退"）、`src/render/README.md` | 删 dom 回退段，改 leafer-only |

**注意（防误删）**：`src/render/EditOverlayLayer.tsx`、text/markup/frame-title 的 DOM overlay
渲染路径**保留**——它们是 leafer 模式下仍生效的组件（PR #124/#125/#132），不属于 dom 渲染器轨。
删轨 PR 的 import-graph 守卫须验证这些 overlay 仍被 leafer 路径消费。

#### ④ 回滚终止日
- **回滚通道**：`?renderer=dom`（应急回退，生产可即时切回——渲染层无状态投影，flag 切回不丢数据，真相源在 IDB canonical / PG persist）。
- **终止日**：删轨 PR 合并日（= telemetry 上线日 + 30 天观察窗 6 指标全绿后，**不倒算日历日 2026-08-06**——telemetry 未上线则窗口不起算）。
- 终止后回滚 = git revert 删轨 PR + 重新部署（依赖 9:00/17:00 cron 或手动 `deploy.sh`）。

#### ⑤ owner
**推荐**：渲染层 maintainer（建议曾主导 Leafer 接入 #98/#110-#131 系列者）。
**待 lead 指派具体人选**。

#### 推荐 / 备选
- **推荐**：telemetry 上线后 + 30 天观察窗 + 6 指标全绿 → 开删轨 PR。**不倒算日历日**
  （telemetry 未上线则窗口不起算）。平衡稳妥性与成本——dom 轨每天在 CI 里跑两份 e2e +
  一份 visual-diff，30 天 ≥ 20 PR 验证密度足够。
- **备选**：14 天短窗，仅当 14 天时 6 指标已全绿且 leaferPaintSignature bench 连续 10 PR
  dragP95<8ms（中位数）。风险：周末/特定用户工作流未覆盖；且 telemetry 上线日 + 14 天
  仍需满足。

---

### 2.2 kernel（legacy → new）——最远离删轨，受契约阶段门控

**当前阶段**：阶段 B（shadow compare 已做、new 藏身开关后、默认 legacy）。C/D 未走完。

#### ① 默认切换条件（C 阶段入场）
切默认 new 的 PR 可合并，当且仅当以下**全部**满足（契约 §8 硬前置）：

| 前置 | 可判定证据 | 来源 |
|---|---|---|
| FX-6 缓存 per-user 化已合入 | persist name 含 userId；`src/main.tsx:33-36` auth hydrate 不再 fire-and-forget；`src/app/useStoreHydration.ts:28-33` 改为 auth barrier 前置 | 契约 §5.5 `:211-229` |
| T1.2a record schema 已合入 | new 记录格式（三域拆分 + per-record revision）PR 在 main | 契约 §8 `:269` |
| 阶段 B shadow 读契约测试全绿 | 契约 §4.7 场景 1（new shadow 读 legacy canonical、不读空派生缓存）测试文件存在且通过 | 契约 §4.7 `:160-170` |
| new-only 字段可重建（无契约违例） | CI 拒绝"不可从 legacy 重建"的新字段 | 契约 §4.5 `:133-148` |
| e2e `--kernel=new` 连续绿 | `e2e-kernel-gate` job ≥ 20 PR 全绿（2026-07-10 起已 required） | ci.yml `:217` |
| **一次性 legacy→new checkpoint**（r1 漏列） | B→C 切轨 PR 含把 canonical blob 从 legacy 格式迁移为 new 记录格式（扁平化 / 三域拆分）+ `version` bump 的 checkpoint 动作；此后 new 原生读 canonical，legacy 降为 shadow reader | 契约 §4.2 `:77-83`（"切轨 PR（B→C）必须含一次性 legacy→new checkpoint"） |
| **C 阶段契约测试全绿**（r1 漏列） | 契约 §4.7 场景 2-4 测试存在且通过：场景 2（C 阶段 legacy shadow 经 raw read+projection 读 canonical，**不触发 zustand `setItem()` 写回**）；场景 3（灰度回退 checkpointed rollback：ckpt 幂等写入 `${BASE}:${userId}:ckpt-v<N>` + down-migrate 写回 + 不静默读旧 key）；场景 4（`new→legacy→new` roundtrip 用户数据无损 + 元数据按 §4.5 重建） | 契约 §4.7 `:160-170`（场景 2-4）；测试文件 `src/kernel/shadowCompare.test.ts`、`src/kernel/rollbackTrigger.test.ts` |

#### ② 观察窗指标与时长（C 阶段，切默认 new 之后）
观察起点 = C 阶段切默认 PR 合并日（`kernelMode.ts:24` DEFAULT_MODE 改 `'new'`）。推荐 **30 天**。

| 指标 | 阈值 | 数据源 + 可运行查询命令 |
|---|---|---|
| 生产 kernel 身份 | 切默认后缺省 = new（`?kernel=` 缺省解析 new）；`?kernel=legacy` 显式命中计数 | telemetry（同 renderer 前置：`kernelMode.ts:47/51/72` 全是 `debugLogger.log` level='log'，**不远传**，须升级 warn 或加 BFF 计数器）。telemetry 上线后查计数；未上线不可判定 |
| shadow compare 不一致 warn | = 0 条（连续 30 天） | `debugLogger.warn('Kernel', ...mismatch)` **会远传**（warn level 过 `remoteDebugReporter` 过滤）——查 BFF/PG 远传 debug 记录 30 天内 source='Kernel' 且含 mismatch 的 warn 数：`SELECT count(*) FROM remote_debug WHERE source='Kernel' AND message LIKE '%mismatch%' AND ts > now()-interval '30 days'` 期望 0 |
| checkpointed rollback drill | 执行 1 次成功：new→legacy→new roundtrip，用户数据（画布/聊天/资产）无损；revision/CRDT clock/记忆接缝/三域元数据按 §4.5 重建 | 契约 §4.7 场景 3-4 测试（`src/kernel/shadowCompare.test.ts`、`src/kernel/rollbackTrigger.test.ts`）绿 + drill 报告路径写入 D PR 的 machine-readable 事件（见 ④ D 门控） |
| e2e `--kernel=both` 连续绿（C 后） | ≥ 20 PR | **C-switch PR 必先把 CI 矩阵改成跑 both**（见 §2.2 ② P2-6 修复）；现状 e2e-kernel-gate 固定 `--kernel=new`（ci.yml `:252`）、e2e-prod-subset 不带 `--kernel`（`:182`，跑默认 kernel），"both" 不发生 |
| 内核回归 bug（P0/P1） | = 0 件（30 天内） | `gh issue list -R xindong/mivo-canvas --label kernel --state open --search "P0 OR P1"` 期望空（**前置：先建 label `kernel`**） |
| 账号切换 canonical 不撞 | A→B→A→logout→B 全场景 storage key 全属当前 userId | 契约 §5.5 验收（FX-6 实施 PR 的契约测试，**一次性 gate 非 30 天指标**）：`src/kernel/useKernelRead.contract.test.ts` + FX-6 账号切换 e2e 绿 |

> **C-switch PR 必含 CI 矩阵改动（r1 漏列，P2-6 修复）**：C 观察窗要求"e2e `--kernel=both`
> 连续绿"，但现状 ci.yml 不跑 both——`e2e-kernel-gate`（`:252`）固定 `--kernel=new`，
> `e2e-prod-subset`（`:182`）不带 `--kernel`（跑默认 kernel，C 切默认 new 后 = 只跑 new）。
> **两 job 都不跑 legacy**，C 后 legacy 回退路径零 e2e 覆盖。故 C-switch PR 范围必须含：
> 把 `e2e-prod-subset` 改 `--kernel=both`（或给 `e2e-kernel-gate` 加 legacy leg），使 C 观察窗内
> new+legacy 都在 required CI 跑。此改动在 C-switch PR 内与默认切换同提，不另开 PR——否则
> "both 观察不会发生"让 ② 的 e2e both 指标不可判定。

#### ③ 删除 PR 范围清单（D 阶段）
**前置硬约束**：D 阶段删轨 PR 不得早于 C 阶段切默认 PR 合并 + 30 天观察窗 + rollback drill 通过。

| 类别 | 路径 | 动作 |
|---|---|---|
| 内核模式开关 | `src/app/kernelMode.ts:22`（`KernelMode` union）、`:24`（`DEFAULT_MODE='legacy'`）、`:40-53`（`resolveKernel` legacy 分支）、`:79-87`（`getKernelMode`/`isLegacyKernel`/`isNewKernel`） | 迁移：收为 new-only 常量（`KernelMode='new'`、`getKernelMode()→'new'`、删 `isLegacyKernel`/`resolveKernel` legacy 路径）；开关文件或留为常量或删 |
| **new 内核实现（保留，不在删除清单）** | `src/kernel/docKernel.ts:55`（`MemoryDocKernel` 类）、`:148`（`createDocKernel` 工厂）；`src/kernel/docKernelPersistAdapter.ts`、`src/kernel/persistMigration.ts`、`src/kernel/useKernelRead.ts`、`src/kernel/records.ts`、`src/kernel/mapping.ts` | **保留**：`docKernel.ts:3` 明写「?kernel=new 才消费，legacy 不读」——`MemoryDocKernel` 是 new 内核实现（D 后成唯一轨），**不是 legacy**，r1 误列已纠正。`persistMigration.ts` 的 legacy 格式半可在 D 后裁，迁移工具本体保留 |
| legacy command dispatch 出口 | `src/canvas/actions/canvasActionModel.ts`（契约 §6 `:239-241`：UI closure 不可序列化；new 出口 = `CanvasCommand` JSON union T2.3 新增） | 迁移：new 出口 `CanvasCommand` 接管后，legacy dispatch 路径 + characterization 测试（`canvasActionModel.characterization.*.test.ts`）在 D 删 |
| legacy persist adapter / 兼容桥 | `src/store/canvasPersistConfig.ts`（zustand persist 的 `migrate` hook = 契约 §4.2-4.4 legacy↔new 兼容桥，C→rollback 仪式依赖它）；消费方 `src/app/useStoreHydration.ts`、`src/lib/assetServiceMode.ts`（均 import `isLegacyKernel`） | 保留至 D：`migrate` hook 是 C 阶段 rollback 保险，D 删 legacy 格式半后 migrate hook 退场；`useStoreHydration`/`assetServiceMode` 的 `isLegacyKernel` 分支随开关收敛 |
| legacy 缓存 namespace | 扁平 key `mivo-canvas-demo` / `mivo-chat-demo` / `mivo-canvas-assets`（契约 §5.1 `:184-185`，pre-FX-6） | 迁移：FX-6 per-user 化（`${BASE}:${userId}`）后消亡；FX-6 是 C 前置（见 ① FX-6 行），D 时 legacy 扁平 key 已无消费方 |
| e2e 旗标 | `scripts/e2e-runner.mjs`、`scripts/e2e-smoke.mjs`（`parseKernel` / `--kernel`） | 删 `both`/`legacy`，new-only（或整体去 `--kernel` 旗标） |
| CI job | ci.yml `e2e-kernel-gate`（`:217`） | 并入 `e2e-prod-subset`（不再有 kernel 维笛卡尔积）；但 `e2e kernel gate (new)` 是 required context——见 §1.5「CI required job 两阶段迁移」，直接删 job 会让所有 PR 永卡 Expected |
| 契约文档 | `docs/decisions/kernel-dualtrack-contract.md` | 标 RESOLVED 归档；ckpt key（§5.2 `:194-196`）清理脚本随 D PR 落 |
| 单测 | `src/app/kernelMode.test.ts` | 删 legacy/both case |
| VITE_MIVO_KERNEL env | 构建配置 | 删（new-only，无切换） |

**注意（防跳阶段，machine-readable 门控；r1 "PR 描述声明"不够）**：D PR 不得仅靠"PR 描述
显式声明"——描述与事实可脱节。C-switch PR 落盘一个 machine-readable 事件文件
`docs/decisions/kernel-c-switch-event.json`，字段：`cSwitchSha`（C-switch PR 合并 SHA）、
`cSwitchDate`（ISO 8601 合并日）、`drillReportPath`（rollback drill 报告相对路径，如
`docs/reports/kernel-rollback-drill-<date>.md`）、`drillPassed`（bool）、`ciBothGreenRuns`
（C 后 e2e `--kernel=both` 连续绿 PR 数，≥20）。D PR 的 `scripts/ci/structure-guard.mjs` 加机械检查：
- `kernel-c-switch-event.json` 存在且 `drillPassed === true`；
- `cSwitchDate` 距 D PR 开工日 ≥ 30 天；
- `ciBothGreenRuns >= 20`；
- `src/app/kernelMode.ts` 不含 `'legacy'` 字面量（new-only 收敛）。
任一不满足 → structure-guard 红 → D PR 挡合并。**回滚保护**：structure-guard 历史断言会挡
"移除该检查"的倒退 PR（与 trunk-guard `non_fast_forward` 叠加）。

#### ④ 回滚终止日
- **回滚通道**：`?kernel=legacy`（C→legacy 走契约 §4.3 checkpointed rollback，ckpt 保险）。
- **终止日**：D 阶段删轨 PR 合并日 = C-switch 合并日 + 30 天 + rollback drill 通过日（取后者）。
- 终止后 ckpt 保险（`${BASE}:${userId}:ckpt-v<N>`）一并清；回滚只能 git revert D PR。

#### ⑤ owner
**推荐**：内核迁移 maintainer（T0.3/T1.2 S1-S6d 系列主导者）。
**待 lead 指派具体人选**。

#### 推荐 / 备选
- **推荐**：C 阶段切默认 PR 排在 FX-6 + T1.2a 之后（cutover 阶段 A 内），30 天观察窗 + rollback drill
  通过后开 D PR。kernel 是三组里最不能急的——split-brain 风险高，契约阶段是安全网，跳阶段=数据丢失。
- **备选**：若 FX-6/T1.2a 推迟到 cutover 后，kernel 删轨整体后移至协作阶段 B 之后；
  但 legacy 轨**必须保留到 C+30 天**，不允许为减 CI 成本提前删。

---

### 2.3 persist（memory → pg）——受 cutover S1-S7 门控

**当前阶段**：默认 memory，PG backend 已实现但 opt-in（`MIVO_PERSIST_BACKEND=pg`）；
pg-suite 翻 required（2026-07-12，今天）。cutover 未执行。

#### ① 默认切换条件（cutover S1-S7 入场）
切默认 pg（`pgConfig.ts:40` 默认改 `pg` + `backend.ts:1225` 工厂换 `PgPersistBackend`）当且仅当：

| 前置 | 可判定证据 | 来源 |
|---|---|---|
| Gate2 启用（SSO + owner/asset 对齐） | member/share 路由生效；DP-6R chat per-user 重拆完成 | cutover plan §3/§5 |
| P0.1 PG 网段 | PR #212 合并 + 服务器 compose up（subnet 192.168.228.0/24） | cutover plan §2 P0.1；ci.yml `:399` |
| P0.2 真实备份成功 | 一次真实 PG backup + restore drill 通过（业务行 + asset） | cutover plan §2 P0.2 |
| P0.3 运行加固 | pm2 看护 / readiness / 连接预算 / restore 含业务行+asset / 固定 asset dir | cutover plan §2 P0.3 |
| pg-suite 连续绿 | `pg-suite` job ≥ 20 PR 全绿（2026-07-12 起已 required） | ci.yml `:412` |
| cutover S1-S7 执行 | export/ingest/verify 含 chat per-actor 迁移（DP-6R）通过；S7 不可逆点过 | cutover plan §6 |

#### ② 观察窗指标与时长（cutover 切默认 pg 之后）
观察起点 = cutover S7 不可逆点。推荐 **30 天**。

| 指标 | 阈值（采样周期 30 天） | 数据源 + 可运行查询命令 |
|---|---|---|
| 生产 persist 后端身份 | `MIVO_PERSIST_BACKEND=pg`，无 memory 回退（全 30 天） | 生产 env + `pgConfig.ts:40` kind=pg：`ssh prod 'printenv MIVO_PERSIST_BACKEND'` 期望 `pg` |
| 生产 PG 读写命中 | PG row counts > 0 且日增长；无"重启清空"假象（每 3 天采样，30 天 ≥ 10 次单调增长） | PG 查询：`PGPASSWORD=… psql -h … -c "SELECT count(*) FROM canvas_meta; SELECT count(*) FROM chat_messages;"` 增长曲线 |
| PG 连接池稳定 | 无连接耗尽（`pgConfig.ts:57-58` maxConnections=10）、无异常 idle timeout（30 天内 0 次 `ECONNRESET`/pool exhaust） | pm2 日志：`pm2 logs mivo-canvas --lines 1000 \| grep -iE 'ECONNRESET\|pool.*exhaust\|idle.*timeout'` 期望空 |
| backup+restore drill | 窗口内 ≥ 1 次成功（业务行 + asset 可恢复） | P0.2 drill 报告路径入删轨 PR（machine-readable 事件，见 ④） |
| 数据丢失事故 | = 0 件（30 天） | **无系统化自动源**——靠 GitHub issue + 人工登记：`gh issue list -R xindong/mivo-canvas --search "data loss\|数据丢失" --state all` 期望空；**新发现 gap：当前无事故登记表**，建议删轨前置补 |
| `backend.contract.dual` 测试 | 连续绿（双后端契约守 memory 兼容，直到 D PR 删 memory 半） | ci.yml `pg-suite` required：`gh pr checks <PR#> --required \| grep 'pg suite (PG16)'` 绿 |

#### ③ 删除 PR 范围清单
**前置硬约束**：删 memory backend 的 PR 不得早于 cutover S7 + 30 天 + backup drill 通过。

| 类别 | 路径 | 动作 |
|---|---|---|
| 内存后端类 | `server/persist/backend.ts:281-1219`（InMemoryPersistBackend 整类） | 删除（保留 `PersistBackend` interface `:106-251`） |
| 工厂默认 | `server/persist/backend.ts:1221-1225` | `createPersistBackend` 直接返 `PgPersistBackend`（或删工厂，app.ts 直接 new） |
| 后端选择开关 | `server/persist/pgConfig.ts:11,40-41` | `PersistBackendKind` 去 `'memory'`；`resolvePersistBackendConfig` 只返 pg |
| `MIVO_PERSIST_BACKEND` env | env 配置 + `.env.example` | 删（pg-only，无切换） |
| 双后端契约测试 | `server/persist/backend.contract.dual.test.ts`、`server/persist/permissionBackend.contract.dual.test.ts` | 改 PG-only contract（去 memory 半）；或并入 `backend.pg.test.ts` |
| memory 单测 | `server/persist/backend.test.ts`（若测 InMemory） | 删或转 PG |
| CI job | ci.yml `pg-suite`（`:412`） | 保留（PG 仍需测），去 "dual" 框架；`backend.test.ts` 移出 |
| 文档 | `backend.ts:6-11` TODO、`:274` 注释 | 删 TODO，改 pg-only |
| app.ts 双 backend 选择注入点 | `server/app.ts:42-68`（`:48-56` persist backend `if pg ... else memory`；`:59-69` permission backend 同构 if/else） | 迁移：删 memory `else` 分支，always-PG（直接 `new PgPersistBackend` + `new PgPermissionBackend`，或保留工厂但工厂内只返 PG）。r1 漏列此注入点 |
| 内存权限后端类 + 工厂 | `server/lib/permissions.ts`（`InMemoryPermissionBackend` 类 + `createPermissionBackend` 工厂；:12 明写「`InMemoryPermissionBackend` ↔ `PgPermissionBackend` 对偶」） | 删除（与 `InMemoryPersistBackend` 同 PR 删——permission backend 的 memory 半，r1 漏列） |
| 测试 harness | `server/routes/persistTestApp.ts:18-33`（`buildPersistApp` 用 `new InMemoryPersistBackend()` + `new InMemoryPermissionBackend()` 构建最小 app + fresh 内存 backend） | 迁移/删除：memory backend 删后此 harness 失效——改用 PG fixture（testcontainer 或 mock PG），或并入 `server/__tests__/t1.3-wiring.test.ts` 主 app reset 路径。r1 漏列 |

**注意（memory 不是回滚保险）**：memory backend 的定位是**切换前的兼容 / 测试轨**
（`backend.ts:276`「非 PG——重启清空」，T1.3 过渡实现），**不是 cutover 回滚通道**——
cutover S7 不可逆点后数据已迁 PG，re-point 工厂回 memory 读到空库 = 数据消失，不是回滚。
真正的回滚语义按 `remaining-tasks-cutover-plan.md:102`「S1-S7 序列一字不改；回滚=冻结窗；
S7 不可逆点」：
- **S1-S6（冻结窗内）**：回滚 = 走 cutover plan §6 S1-S6 既定回退动作（停切换、保留冻结前
  PG 状态、未迁数据仍在原存储）；memory 此时可作为"切 PG 前的兼容轨"保留观察，但不是回滚目标。
- **S7（不可逆点）后**：回滚 = **只能 PG backup restore**（P0.2 drill 验证过的业务行 + asset
  备份），re-point 到 memory 不在回滚选项内。
cutover S7 + 30 天 + backup drill 通过前，**禁止**删 memory——不是因为它能回滚，而是因为它是
"切 PG 前的兼容 / 测试轨"，删了会让兼容观察窗与 `backend.contract.dual` 的 memory 半失去
对照基线。删 memory 的真实前置 = 兼容观察窗收口 + dual 契约改 PG-only，而非"回滚保险到期"。

#### ④ 回滚终止日
- **回滚通道（分阶段，非 memory）**：
  - **S7 前（冻结窗）**：cutover plan §6 S1-S6 既定回退动作（停切换 + 保留冻结前 PG 状态）；
    memory 是"切 PG 前兼容轨"，**不是回滚目标**（`backend.ts:276` 重启清空，re-point 回 memory = 空库 = 数据消失）。
  - **S7 后（不可逆点）**：**只能 PG backup restore**（P0.2 drill 验证的业务行 + asset 备份）。
- **终止日**：删 memory PR 合并日 = cutover S7 + 30 天 + backup drill 通过日（取后者）。
  注意：终止日门控的是"兼容观察窗收口 + dual 契约改 PG-only"，不是"回滚保险到期"——
  memory 从来不是回滚保险（见 §0 通用回滚语义 + §2.3 ③ 注意段）。
- 终止后回滚只能 git revert 删轨 PR + 从 PG backup restore。

#### ⑤ owner
**推荐**：persist/后端 maintainer（T1.3 系列 + PG provisioning 主导者）。
**待 lead 指派具体人选**。

#### 推荐 / 备选
- **推荐**：memory backend 保留至 cutover S7 + 30 天 + backup drill 通过；pg-suite 已 required，
  30 天观察窗 + drill 双保险后开删轨 PR。persist 删轨是"丢兼容/测试轨 + dual 契约 memory 半"
  的高危操作（不是丢回滚路径——memory 从不是回滚通道，§0），必须晚于 cutover 收口。
- **备选**：若 cutover 推迟，memory 轨无限期保留（CI 成本可接受——pg-suite 已独立 required，
  memory 半的 dual 契约测试是兼容性安全网，不急着删）。

---

## 3. 三组决议摘要表

| 组 | 当前阶段 | 删轨前置（可观测） | 推荐观察窗 | 删除 PR 触发日（推荐） | 回滚通道 | 回滚终止日 | owner |
|---|---|---|---|---|---|---|---|
| **renderer** | 默认已切 leafer（#131, 2026-07-06） | telemetry 上线 + label(renderer/leafer) 创建 + 6 指标全绿（dom 请求=0 / pixi 工装外=0 / e2e both 绿 ≥20 / visual-diff PASS ≥20 / leafer P0P1 bug=0 / bench dragP95<8ms 中位） | 30 天（telemetry 上线日起算，不倒算日历日） | telemetry 上线 + 30 天 + 6 指标全绿 | `?renderer=dom`（无状态 flag，切回不丢数据） | 删轨 PR 合并日 | 渲染层 maintainer（待指派） |
| **kernel** | 阶段 B（new 接活，默认 legacy），C/D 未走完 | C 入场：FX-6 + T1.2a + B shadow 全绿 + 一次性 legacy→new checkpoint（§4.2）+ C 契约测试（§4.7 场景 2-4）+ new-only 可重建 + e2e new 绿 ≥20 + CI 矩阵改 both；C 后：shadow warn=0 + rollback drill + e2e both 绿 ≥20 | C 后 30 天 | C-switch 合并 + 30 天 + drill 通过（machine-readable 事件 `kernel-c-switch-event.json` 校验） | `?kernel=legacy`（ckpt 保险，契约 §4.3） | D PR 合并日 | 内核迁移 maintainer（待指派） |
| **persist** | 默认 memory，PG opt-in，pg-suite 已 required | cutover S1-S7 + Gate2 + P0.1/0.2/0.3 + pg-suite 绿 ≥20；S7 后：PG 命中 + 连接池稳 + backup drill + 数据丢失=0（**事故登记表 gap 待补**） | S7 后 30 天 | cutover S7 + 30 天 + backup drill | S7 前=cutover S1-S6 回退动作；S7 后=PG backup restore（memory 非回滚通道，§0/§2.3④） | 删 memory PR 合并日 | persist/后端 maintainer（待指派） |

---

## 4. 顺序与依赖

三组相互独立，可单独推进；但删轨成熟度不同：

1. **renderer**（最成熟）——默认切换已完成（#131, 2026-07-06），但观察窗须待 telemetry 上线才起算（② 前置），最早可删。
2. **persist**（中等）——PG backend 已实现，CI 已 required，但默认切换（cutover）未执行；
   删轨受 cutover S1-S7 + backup drill 门控。
3. **kernel**（最远）——默认未切，C 阶段未走完，且受 FX-6/T1.2a 硬前置；删轨最晚。

> renderer 删轨不阻塞 kernel/persist；kernel 删轨不阻塞 persist；反之亦然。
> 但三组同时删轨会一次性砍掉 CI 笛卡尔积的两阶——建议错峰，避免同窗口三份大 diff 叠加审查压力。

---

## 5. 风险与注意

| 风险 | 影响 | 缓解 |
|---|---|---|
| renderer 误删永久 DOM overlay（text/markup/frame-title/选中壳） | leafer 模式文字/标注/标题/选中态失渲染 | 删轨 PR 须留 EditOverlayLayer + overlay 渲染路径；import-graph 守卫验证 leafer 仍消费 |
| kernel 跳阶段（C 未完成开 D） | split-brain、用户数据丢失 | D PR machine-readable 事件 `kernel-c-switch-event.json` + structure-guard 机械检查（cSwitchDate≥30 天 / drillPassed / ciBothGreenRuns≥20 / `kernelMode.ts` 不含 `'legacy'`），§2.2③ |
| persist 删 memory 早于 cutover 收口 | cutover 失败时 memory 非回滚（`backend.ts:276` 重启清空，re-point 回 memory = 空库 = 数据消失） | memory 保留至 S7+30 天+backup drill（作为兼容/测试轨，非回滚保险）；删轨 PR 前置硬约束写死 |
| 三组同窗口删轨 | CI 笛卡尔积两阶同砍 + 三份大 diff 审查压力 | 错峰，renderer→persist→kernel |
| 契约文档陈旧（kernel-dualtrack-contract §9 e2e 标 `[ ]` 实际已 required） | 删轨决策基于过期阶段信息 | 本文件已按 ci.yml 实际状态校准；建议契约文档同步刷 §9 checkbox |
| pixi spike 遗留（`?renderer=pixi`）混入 renderer 删轨 PR | scope 膨胀、审查分心 | pixi 非本组双轨，建议同 PR 清（同为渲染器维冗余）但单独 commit、PR 描述显式列 |
| telemetry 未上线就倒算观察窗（r1 错误） | dom/pixi 请求=0、kernel 身份 log 指标不可判定（`debugLogger.log` 不远传，240 条浏览器内存，页面关即清） | 窗口起点改为 telemetry 上线日；删 2026-08-06 倒算日；telemetry + label 创建列为删轨前置（§2.1②） |
| 删 required CI job 无分支保护迁移 | `visual diff (dom vs leafer)` / `e2e kernel gate (new)` context 永不上报 → 所有 PR 永卡 Expected（`enforce_admins=true`） | 两阶段迁移（admin 先移 required context → 再删 job，§1.5）；trunk-guard org ruleset 不含 required_status_checks，repo admin 可改 |

---

## 6. 不写死的项（留给用户/lead 拍板）

- 每组观察窗具体天数（推荐 30，备选 14/无限期）。
- 每组 owner 具体人选（本文只给角色）。
- renderer 是否同步清 pixi（推荐清，但可拆 PR）。
- kernel C 阶段切默认 PR 的具体排期（依赖 FX-6/T1.2a 进度）。
- persist 删轨是否保留 memory 半的 dual 契约测试作为兼容性安全网（备选：无限期保留）。
