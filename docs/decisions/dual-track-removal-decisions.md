# 三组双轨删轨决议（renderer / kernel / persist）

日期：2026-07-12
来源任务：`docs/plan/remaining-tasks-cutover-plan.md` §7 D-4
作者：D-4 worker（分支 `docs/d4-dual-track-removal`）

> **文档性质**：决策**建议**文档。最终拍板权在用户/lead。每组给「推荐 + 备选」，
> 不写死。所有判据必须是可观测的数字/事件（不允许"稳定后""观察一段时间"这类不可判定表述）。
> 事实依据全部实查于 origin/main（HEAD `1b9c92c`），引用带 file:line。

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

**通用回滚语义**：删轨前，旧轨=回滚通道（`?renderer=dom` / `?kernel=legacy` /
`MIVO_PERSIST_BACKEND=memory`）。删轨 PR 合并=回滚通道物理消失，之后回滚只能靠 git revert
删轨 PR（且越往后 revert 越痛）。故「回滚终止日」=删轨 PR 合并日，其本身被观察窗指标门控。

---

## 1. 事实依据实查表（origin/main `1b9c92c`）

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

---

## 2. 三组删轨决议

### 2.1 renderer（dom → leafer）——最接近删轨

**当前阶段**：默认切换**已完成**（2026-07-06 #131），处于观察窗（第 6 天，截至 2026-07-12）。

#### ① 默认切换条件
切换已发生（`rendererMode.ts:20` DEFAULT_MODE='leafer'）。无待办切换动作；
本组实际是「删轨条件」，即观察窗指标全部满足后才能删 dom 轨。

#### ② 观察窗指标与时长
观察起点 = 2026-07-06（#131 合并 + 默认切 leafer）。推荐时长 **30 天**（至 2026-08-05），
覆盖 60 次 cron 自动部署（9:00/17:00 各一，见 CLAUDE.md 部署规则）+ 2 轮周使用模式。
所有指标须在删轨 PR 开工前连续满足：

| 指标 | 阈值 | 数据源 |
|---|---|---|
| 生产环境 `?renderer=dom` 请求计数 | = 0（连续 30 天） | 生产 Debug Log：`rendererMode.ts:48` 打的 `"dom renderer requested（应急回退通道…）"` 行计数 |
| `?renderer=pixi` 工装外访问 | = 0 | 生产 Debug Log：`rendererMode.ts:52` `"pixi 0d spike renderer active"` 行计数 |
| e2e `--renderer=both` 连续绿 merge 数 | ≥ 20 个 PR 合并 | CI `e2e-prod-subset` + `e2e-kernel-gate` job 历史 |
| visual-diff dom vs leafer diff% 连续 PASS | ≥ 20 个 PR（DIFF_THRESHOLD_PERCENT 默认 5%，`scripts/visual-diff.mjs`） | CI `visual-diff` job summary |
| leafer 渲染回归 bug（P0/P1） | = 0 件（30 天内） | GitHub issues label=renderer + leafer |
| leaferPaintSignature bench dragP95 | < 8ms 且 < allP95（连续 20 PR，非阻断但监控） | CI `bench` job summary（`leaferPaintSignature.bench.test.ts`） |

#### ③ 删除 PR 范围清单
**只删 dom 渲染器轨**，不删永久 DOM overlay（text/markup/frame-title/选中壳是 leafer 模式组件）。

| 类别 | 路径 | 动作 |
|---|---|---|
| 渲染器轨主文件 | `src/render/DomRenderer.tsx` | 删除 |
| 渲染器模式开关 | `src/render/rendererMode.ts:18,22,47-50` | `RendererMode` 去掉 `'dom'`；`VALID_MODES` 去 `dom`；删 dom 分支（`:47-50`） |
| pixi spike 遗留（同步清，NO-GO） | `src/render/rendererMode.ts:13,51-54`；`src/render/usePixiSpikeRenderer.ts`；`src/render/useEngineSpikeRenderers.ts` pixi 分支 | 删除（pixi 非本组双轨，但同为渲染器维冗余，建议同 PR 清） |
| 适配器契约 | `src/render/rendererAdapter.ts:29` | `mode` 收为 `'leafer'`；删 `:23-26` DOM 声明式注释 |
| 消费方 dom 分支 | `src/canvas/MivoCanvas.tsx`、`src/render/textPaintMode.ts` | 删 dom 分支，只留 leafer |
| e2e 旗标 | `scripts/e2e-runner.mjs`、`scripts/e2e-smoke.mjs`（`parseRenderer` / `--renderer`） | 删 `both`/`dom`，leafer-only（或整体去 `--renderer` 旗标） |
| visual-diff harness | `scripts/visual-diff.mjs`、`scripts/visual-shell-baselines.mjs` | 删除（无 dom baseline） |
| CI job | `.github/workflows/ci.yml` `e2e-prod-subset`（`:182`）、`e2e-kernel-gate`（`:252`） | 去 `--renderer=both`；`visual-diff` job（`:283`）整段删 |
| 单测 | `src/render/rendererMode.test.ts`、`src/render/rendererFallback.test.ts`、`src/render/useEngineSpikeRenderers.failsafe.test.ts`、`src/render/usePixiSpikeRenderer.ts` 关联测 | 删 dom/pixi case |
| 文档 | `CLAUDE.md`（"默认渲染器"段 + "?renderer=dom 应急回退"）、`src/render/README.md` | 删 dom 回退段，改 leafer-only |

**注意（防误删）**：`src/render/EditOverlayLayer.tsx`、text/markup/frame-title 的 DOM overlay
渲染路径**保留**——它们是 leafer 模式下仍生效的组件（PR #124/#125/#132），不属于 dom 渲染器轨。
删轨 PR 的 import-graph 守卫须验证这些 overlay 仍被 leafer 路径消费。

#### ④ 回滚终止日
- **回滚通道**：`?renderer=dom`（应急回退，生产可即时切回）。
- **终止日**：删轨 PR 合并日（推荐 2026-08-06 起，即观察窗满 30 天后）。
- 终止后回滚 = git revert 删轨 PR + 重新部署（依赖 9:00/17:00 cron 或手动 `deploy.sh`）。

#### ⑤ owner
**推荐**：渲染层 maintainer（建议曾主导 Leafer 接入 #98/#110-#131 系列者）。
**待 lead 指派具体人选**。

#### 推荐 / 备选
- **推荐**：2026-08-06 开删轨 PR，30 天观察窗 + 6 指标全绿。平衡稳妥性与成本——dom 轨每天
  在 CI 里跑两份 e2e + 一份 visual-diff，30 天约 60 次部署的验证密度足够。
- **备选**：14 天短窗（2026-07-20 开 PR），仅当 14 天时 6 指标已全绿且 leaferPaintSignature bench
  连续 10 PR dragP95<8ms。风险：周末/特定用户工作流未覆盖。

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

#### ② 观察窗指标与时长（C 阶段，切默认 new 之后）
观察起点 = C 阶段切默认 PR 合并日（`kernelMode.ts:24` DEFAULT_MODE 改 `'new'`）。推荐 **30 天**。

| 指标 | 阈值 | 数据源 |
|---|---|---|
| 生产 kernel 身份 log | `"kernel identity: new (default)"` 出现，`"legacy"` 仅显式 `?kernel=legacy` 时出现 | `kernelMode.ts:71-73` Debug Log |
| shadow compare 不一致 warn | = 0 条（连续 30 天） | `kernelMode.ts`/契约 §4.2 的 `debugLogger.warn('Kernel', ... mismatch)` 计数 |
| checkpointed rollback drill | 执行 1 次成功：new→legacy→new roundtrip，用户数据（画布/聊天/资产）无损；revision/CRDT clock/记忆接缝/三域元数据按 §4.5 重建 | 契约 §4.3/§4.4/§4.7 场景 3-4；drill 报告入 PR |
| e2e `--kernel=both` 连续绿（C 后） | ≥ 20 PR | `e2e-prod-subset` + `e2e-kernel-gate` |
| 内核回归 bug（P0/P1） | = 0 件 | GitHub issues label=kernel |
| 账号切换 canonical 不撞 | A→B→A→logout→B 全场景 storage key 全属当前 userId | 契约 §5.5 验收 |

#### ③ 删除 PR 范围清单（D 阶段）
**前置硬约束**：D 阶段删轨 PR 不得早于 C 阶段切默认 PR 合并 + 30 天观察窗 + rollback drill 通过。

| 类别 | 路径 | 动作 |
|---|---|---|
| 内核模式开关 | `src/app/kernelMode.ts:22-26,46-53,79-87` | `KernelMode` 收为 `'new'`；删 `legacy` 分支、`isLegacyKernel`、`resolveKernel` legacy 路径；`getKernelMode()` 返回常量 |
| legacy 内核实现 | MemoryDocKernel / legacy store 初始化 / legacy persist adapter / legacy 缓存 namespace / `canvasActionModel` legacy dispatch 出口（契约 §6 `:236-247`） | 删除（new 成唯一轨） |
| e2e 旗标 | `scripts/e2e-runner.mjs`、`scripts/e2e-smoke.mjs`（`parseKernel` / `--kernel`） | 删 `both`/`legacy`，new-only（或整体去 `--kernel` 旗标） |
| CI job | ci.yml `e2e-kernel-gate`（`:217`） | 并入 `e2e-prod-subset`（不再有 kernel 维笛卡尔积） |
| 契约文档 | `docs/decisions/kernel-dualtrack-contract.md` | 标 RESOLVED 归档；ckpt key（§5.2 `:194-196`）清理脚本随 D PR 落 |
| 单测 | `src/app/kernelMode.test.ts` | 删 legacy/both case |
| VITE_MIVO_KERNEL env | 构建配置 | 删（new-only，无切换） |

**注意（防跳阶段）**：D PR 的 CI 描述必须显式声明"C 阶段切默认 PR 已合并 ≥ 30 天 +
rollback drill 报告编号"，structure-guard 可加一条机械检查（`kernelMode.ts` 不含 `'legacy'` 字面量）。

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

| 指标 | 阈值 | 数据源 |
|---|---|---|
| 生产 persist 后端身份 | `MIVO_PERSIST_BACKEND=pg`，无 memory 回退 | 生产 env + `pgConfig.ts:40` kind=pg |
| 生产 PG 读写命中 | PG row counts > 0 且增长；无"重启清空"假象 | PG 查询 + BFF debug 记录 |
| PG 连接池稳定 | 无连接耗尽（maxConnections=10）、无异常 idle timeout | pm2 日志 + `pgConfig.ts:57-58` 监控 |
| backup+restore drill | 窗口内 ≥ 1 次成功（业务行 + asset 可恢复） | P0.2 drill 报告 |
| 数据丢失事故 | = 0 件 | cutover S7 后事故记录 |
| `backend.contract.dual` 测试 | 连续绿（双后端契约仍守 memory 兼容，直到 D PR 删 memory 半） | ci.yml `pg-suite` |

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

**注意（防丢回滚）**：memory backend 是 cutover 期的回滚路径（re-point 工厂即回到 memory）。
cutover S7 不可逆点 + 30 天 + backup drill 通过前，**禁止**删 memory——删了 = cutover 失败只能 git revert +
数据可能已部分迁 PG，回滚成本指数级上升。

#### ④ 回滚终止日
- **回滚通道**：`MIVO_PERSIST_BACKEND=memory`（re-point 工厂回 InMemoryPersistBackend，路由零改动，见 `backend.ts:6-11`）。
- **终止日**：删 memory PR 合并日 = cutover S7 + 30 天 + backup drill 通过日（取后者）。
- 终止后回滚只能 git revert 删轨 PR + 从 PG backup restore。

#### ⑤ owner
**推荐**：persist/后端 maintainer（T1.3 系列 + PG provisioning 主导者）。
**待 lead 指派具体人选**。

#### 推荐 / 备选
- **推荐**：memory backend 保留至 cutover S7 + 30 天 + backup drill 通过；pg-suite 已 required，
  30 天观察窗 + drill 双保险后开删轨 PR。persist 删轨是"丢回滚路径"的高危操作，必须晚于 cutover 收口。
- **备选**：若 cutover 推迟，memory 轨无限期保留（CI 成本可接受——pg-suite 已独立 required，
  memory 半的 dual 契约测试是兼容性安全网，不急着删）。

---

## 3. 三组决议摘要表

| 组 | 当前阶段 | 删轨前置（可观测） | 推荐观察窗 | 删除 PR 触发日（推荐） | 回滚通道 | 回滚终止日 | owner |
|---|---|---|---|---|---|---|---|
| **renderer** | 默认已切 leafer（#131, 2026-07-06），观察第 6 天 | 6 指标全绿（dom 请求=0 / e2e both 绿 ≥20 / visual-diff PASS ≥20 / leafer P0P1 bug=0 / bench dragP95<8ms / pixi 工装外=0） | 30 天（至 2026-08-05） | 2026-08-06 | `?renderer=dom` | 删轨 PR 合并日 | 渲染层 maintainer（待指派） |
| **kernel** | 阶段 B（new 接活，默认 legacy），C/D 未走完 | C 入场：FX-6 + T1.2a + B shadow 全绿 + new-only 可重建 + e2e new 绿 ≥20；C 后：shadow warn=0 + rollback drill + e2e both 绿 ≥20 | C 后 30 天 | C-switch 合并 + 30 天 + drill 通过 | `?kernel=legacy`（ckpt 保险） | D PR 合并日 | 内核迁移 maintainer（待指派） |
| **persist** | 默认 memory，PG opt-in，pg-suite 今日翻 required | cutover S1-S7 + Gate2 + P0.1/0.2/0.3 + pg-suite 绿 ≥20；S7 后：PG 命中 + 连接池稳 + backup drill + 数据丢失=0 | S7 后 30 天 | cutover S7 + 30 天 + backup drill | `MIVO_PERSIST_BACKEND=memory` | 删 memory PR 合并日 | persist/后端 maintainer（待指派） |

---

## 4. 顺序与依赖

三组相互独立，可单独推进；但删轨成熟度不同：

1. **renderer**（最成熟）——默认切换已完成，观察窗已过 1/5，最早可删。
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
| kernel 跳阶段（C 未完成开 D） | split-brain、用户数据丢失 | D PR CI 描述声明 C+30 天 + drill 编号；structure-guard 机械检查 `kernelMode.ts` 不含 `'legacy'` |
| persist 删 memory 早于 cutover 收口 | cutover 失败无回滚路径，数据可能部分迁 PG | memory 保留至 S7+30 天+backup drill；删轨 PR 前置硬约束写死 |
| 三组同窗口删轨 | CI 笛卡尔积两阶同砍 + 三份大 diff 审查压力 | 错峰，renderer→persist→kernel |
| 契约文档陈旧（kernel-dualtrack-contract §9 e2e 标 `[ ]` 实际已 required） | 删轨决策基于过期阶段信息 | 本文件已按 ci.yml 实际状态校准；建议契约文档同步刷 §9 checkbox |
| pixi spike 遗留（`?renderer=pixi`）混入 renderer 删轨 PR | scope 膨胀、审查分心 | pixi 非本组双轨，建议同 PR 清（同为渲染器维冗余）但单独 commit、PR 描述显式列 |

---

## 6. 不写死的项（留给用户/lead 拍板）

- 每组观察窗具体天数（推荐 30，备选 14/无限期）。
- 每组 owner 具体人选（本文只给角色）。
- renderer 是否同步清 pixi（推荐清，但可拆 PR）。
- kernel C 阶段切默认 PR 的具体排期（依赖 FX-6/T1.2a 进度）。
- persist 删轨是否保留 memory 半的 dual 契约测试作为兼容性安全网（备选：无限期保留）。
