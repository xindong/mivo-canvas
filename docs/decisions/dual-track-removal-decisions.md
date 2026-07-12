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
实测，PraiseZhu）从 `required_status_checks` 移除旧 context 名。这是 settings 级原子更新，不走 PR、即时生效。
**PUT 是整体替换**——必须发**全量保留项**，且保 app_id 绑定（实测 9 项全挂 `app_id:15368`），否则会误清。

> **r2 原命令 `-F contexts='[...]'` 是 422 bug**：`-F`（form field）把 JSON 文本当**字符串字段**发——
> httpbin echo 实测收到 `"contexts":"[\"a\",\"b\"]"`（string），而 GitHub 端 `contexts` 期望 array → **422**。
> 修法：`--input -` 把 stdin 当原始 JSON body 发（httpbin echo 实测收到 `"contexts":["a","b"]` 真 array）。
> 用 `checks`（含 `app_id`）而非裸 `contexts` 字符串数组：逐字保留 9 项挂的 app_id 绑定（"逐字不变"最严）。

**before-snapshot**（执行前存档，确认目标在列 + 记录 app_id）：

```bash
gh api repos/xindong/mivo-canvas/branches/main/protection \
  --jq '.required_status_checks' > /tmp/d4-required-before.json
# 实测（2026-07-12 fetch）：9 项全挂 app_id 15368，strict=false。顺序：
#   lint + tsc + unit + logging / structure guard (anti-regression) / e2e prod subset (mock upstream) /
#   e2e token gate (authorized) / e2e token gate (unauthorized) / secret scan (gitleaks) /
#   visual diff (dom vs leafer) / e2e kernel gate (new) / pg suite (PG16)
jq '(.checks|length),(.contexts|length)' /tmp/d4-required-before.json   # 期望 9 9（r6 修 D4-R6-1：裸 `jq '.checks|length,.contexts|length'` 逗号/管道优先级错——先算 `.checks|length` 得 9，再用字符串 `"contexts"` 索引该数字数组报 `Cannot index array with string "contexts"` rc=5；加括号强制先各自 length 再逗号输出，实跑 rc=0 输出 9、9）
```

**renderer 删轨**：只移 `visual diff (dom vs leafer)`，保留 `e2e kernel gate (new)` 与其余 7 项逐字不变：

```bash
echo '{"strict":false,"checks":[{"app_id":15368,"context":"lint + tsc + unit + logging"},{"app_id":15368,"context":"structure guard (anti-regression)"},{"app_id":15368,"context":"e2e prod subset (mock upstream)"},{"app_id":15368,"context":"e2e token gate (authorized)"},{"app_id":15368,"context":"e2e token gate (unauthorized)"},{"app_id":15368,"context":"secret scan (gitleaks)"},{"app_id":15368,"context":"e2e kernel gate (new)"},{"app_id":15368,"context":"pg suite (PG16)"}]}' \
  | gh api -X PUT repos/xindong/mivo-canvas/branches/main/protection/required_status_checks --input -
```

**kernel 删轨**：只移 `e2e kernel gate (new)`，保留 `visual diff (dom vs leafer)` 与其余 7 项逐字不变：

```bash
echo '{"strict":false,"checks":[{"app_id":15368,"context":"lint + tsc + unit + logging"},{"app_id":15368,"context":"structure guard (anti-regression)"},{"app_id":15368,"context":"e2e prod subset (mock upstream)"},{"app_id":15368,"context":"e2e token gate (authorized)"},{"app_id":15368,"context":"e2e token gate (unauthorized)"},{"app_id":15368,"context":"secret scan (gitleaks)"},{"app_id":15368,"context":"visual diff (dom vs leafer)"},{"app_id":15368,"context":"pg suite (PG16)"}]}' \
  | gh api -X PUT repos/xindong/mivo-canvas/branches/main/protection/required_status_checks --input -
```

> **dry-run 证据**（不碰生产，复核人可重跑）：
> 1. `echo '<payload>' | jq '.checks|length'` → renderer/kernel 两变体均 `8`；jq `contains` 校验 renderer
>    变体不含 `visual diff` 且含 `e2e kernel gate`、kernel 变体反之——payload 静态正确。
> 2. `echo '<payload>' | gh api -X PUT https://httpbin.org/put --input - --jq '.json.checks|length'` → `8`，
>    证 `-X PUT --input -` 命令组合与 body 编码正确（真 JSON array，非 string）。
> 3. GET 真实 `repos/xindong/mivo-canvas/branches/main/protection` 确认路径+鉴权+9 项实值（上 before-snapshot）。
> 4. 备选 `gh api -X PUT ... -F strict=false -F 'contexts[]=a' -F 'contexts[]=b'`（httpbin echo 实测亦发真 array），
>    但不保 app_id 绑定，等同裸 contexts，次选。
>
> **r3 实测观测值（2026-07-12，worker vldvaxvzah7qk3gacgtb3676，复核人可重跑对拍）**：
> - jq 静态：renderer/kernel 变体 `.checks|length`=`8`；renderer `visual diff`=`0`、`e2e kernel gate`=`1`；kernel `e2e kernel gate`=`0`、`visual diff`=`1`；`[.checks[].app_id]|unique`=`[15368]`。
> - httpbin `--input -`：`.json.checks|type`=`array`、`.json|is_array`=`array`（真 array，非 string）；
>   对照 `-F 'contexts=["a","b"]'`（r2 422 源）→ `.json.contexts|type`=`string`、值=`"[\"a\",\"b\"]"`；
>   `-F 'contexts[]=a' -F 'contexts[]=b'`（备选）→ `.json.contexts|type`=`array`、值=`["a","b"]`。
> - 真实 GET `branches/main/protection`：`contexts_count`=`9`、`checks_count`=`9`、`app_ids`=`[15368]`、`strict`=`false`；
>   acceptance jq 对当前未改动状态：`visual diff`=`1`、`e2e kernel gate`=`1`、`contexts|length`=`9`、`app_id unique`=`[15368]`；
>   `grep -c '^  visual-diff:'`=`1`、`grep -c '^  e2e-kernel-gate:'`=`1`（证 jq filter 与 grep 模式可判定；PUT 后按上表翻转）。

**阶段 2（代码 PR 删 job）**：context 移出 required 后，开 PR 删除 ci.yml 中对应 job 段。
此时 PR 不再被旧 context 卡（已非 required）→ CI 绿 → 合并。

**验收命令**（PUT 后即时验 context 迁移 + 阶段 2 合并后验 job 删除；r4 改 R3-7：加 jq 集合 diff 机械证明 7 项逐字不变）

PUT 后先存 after JSON，再用 jq 与 before snapshot 做集合 diff（r3 原命令只查目标=0/另一=1/总数=8/app_id unique，没与 before 比对，不能证明"其余 7 项逐字不变"——改 context 拼写或 app_id 仍过 r3 四条；r4 加 4 条集合断言，renderer/kernel 各一套，TARGET/OTHER 对调）：

```bash
# ── renderer 删轨（TARGET=visual diff, OTHER=e2e kernel gate）──
TARGET='visual diff (dom vs leafer)'; OTHER='e2e kernel gate (new)'
gh api repos/xindong/mivo-canvas/branches/main/protection \
  --jq '.required_status_checks' > /tmp/d4-required-after.json
# 1. after.checks == before.checks - 目标（按 context 排序，含 app_id 逐字不变）
diff <(jq -S --arg t "$TARGET" '.checks | map(select(.context != $t)) | sort_by(.context)' /tmp/d4-required-before.json) \
     <(jq -S '.checks | sort_by(.context)' /tmp/d4-required-after.json) && echo "1.set-diff-ok" || { echo "1.FAIL" >&2; exit 1; }
# 2. strict 不变
[ "$(jq -r '.strict' /tmp/d4-required-before.json)" = "$(jq -r '.strict' /tmp/d4-required-after.json)" ] || { echo "2.strict-FAIL" >&2; exit 1; }
# 3. 另一 gate 仍在 after
jq -e --arg g "$OTHER" '.checks | map(select(.context == $g)) | length == 1' /tmp/d4-required-after.json >/dev/null || { echo "3.other-gate-FAIL" >&2; exit 1; }
# 4. 无 added checks（after contexts ⊆ before contexts）
[ -z "$(comm -13 <(jq -r '.checks[].context' /tmp/d4-required-before.json | sort) <(jq -r '.checks[].context' /tmp/d4-required-after.json | sort))" ] || { echo "4.added-FAIL" >&2; exit 1; }
```

```bash
# ── kernel 删轨（TARGET=e2e kernel gate, OTHER=visual diff；两 context 名对调）──
TARGET='e2e kernel gate (new)'; OTHER='visual diff (dom vs leafer)'
gh api repos/xindong/mivo-canvas/branches/main/protection \
  --jq '.required_status_checks' > /tmp/d4-required-after.json
diff <(jq -S --arg t "$TARGET" '.checks | map(select(.context != $t)) | sort_by(.context)' /tmp/d4-required-before.json) \
     <(jq -S '.checks | sort_by(.context)' /tmp/d4-required-after.json) && echo "1.set-diff-ok" || { echo "1.FAIL" >&2; exit 1; }
[ "$(jq -r '.strict' /tmp/d4-required-before.json)" = "$(jq -r '.strict' /tmp/d4-required-after.json)" ] || { echo "2.strict-FAIL" >&2; exit 1; }
jq -e --arg g "$OTHER" '.checks | map(select(.context == $g)) | length == 1' /tmp/d4-required-after.json >/dev/null || { echo "3.other-gate-FAIL" >&2; exit 1; }
[ -z "$(comm -13 <(jq -r '.checks[].context' /tmp/d4-required-before.json | sort) <(jq -r '.checks[].context' /tmp/d4-required-after.json | sort))" ] || { echo "4.added-FAIL" >&2; exit 1; }
```

```bash
# ── 阶段 2 合并后：job 也已从 ci.yml 删除
grep -c '^  visual-diff:' .github/workflows/ci.yml       # 期望 0（renderer 删轨）
grep -c '^  e2e-kernel-gate:' .github/workflows/ci.yml    # 期望 0（kernel 删轨）
```

> r4 dry-run 证据（本地 mock before/after fixture，复核人可重跑）：正例 after 去 `visual diff`、其余 7 项逐字不变（含 app_id）→ 4 条全 OK；负例误删另一 gate → 3 红、改 `strict=true` → 2 红、新增 `BOGUS NEW CONTEXT` → 4 红、改 `app_id=99999` → 1 红（证逐字不变检测含 app_id 绑定，非仅 context 名）。r3 原 4 条快速验收仍可作概览，但**不能替代集合 diff**——目标=0 + 总数=8 不保证"其余 7 项 context 拼写 / app_id 逐字不变"。
>
> r5 修 D4-R5-5：r4 末尾 `|| echo "1.FAIL"` 把 diff 失败吞成 rc=0（仅打印 FAIL，整段 rc=0 假绿），且 assertion 2-4 失败不传播（strict 改动会让 assertion 2 `[ ]` rc=1 但被后续 assertion 覆盖成 rc=0）。四条断言均改 `cmd || { echo "N.FAIL" >&2; exit 1; }`（不靠 `set -e`——zsh 下 `set -e` 对 `[ ]`/`jq -e` 不可靠，显式 `|| { exit 1; }` shell-agnostic），任一失败整段 shell rc!=0。dry-run（本地 mock 9-check before fixture + 6 after 变体，zsh 与 bash 均验）：正例 rc=0；改 app_id=99999 / 改 context 拼写 / 误删另一 gate / 新增 BOGUS check / 改 strict=true 各自 rc=1（不再只打印 FAIL）。

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
不产生 `?renderer=dom` 用户流量，不是观察密度代理）。所有**硬门控指标**须在删轨 PR 开工前连续满足；
bench 为**监控项（非门控）**，单列。

**前置：观测能力（删轨前必须先上线，否则 dom/pixi 计数指标不可判定）**：

| 前置 | 动作（二选一已定死：走 BFF 计数器，**不**走 warn 远传） | 验收命令 |
|---|---|---|
| dom/pixi 请求计数 telemetry | **选定 BFF 计数器**：生产前端 `?renderer=dom`/`pixi` 命中时 POST `/api/mivo/renderer-mode`，BFF 写 PG `mode_hits` 表（schema 见下）。**不选 warn 远传**：依赖 remoteDebugReporter 三道过滤 + 240 条浏览器 ring buffer，页面关即清，不稳。 | `psql "$DATABASE_URL" -c "SELECT count(*) FROM mode_hits WHERE track='renderer' AND mode IN ('dom','pixi') AND ts > now()-interval '30 days'"` 期望 ≥0 行返回（有计数能力） |
| GitHub labels + severity schema（r4 改 R3-5） | 创建 `renderer`、`leafer` label + 回归 bug severity schema：`regression`（标记回归）、`severity-P0`、`severity-P1`（severity 级别，renderer/kernel 共用）。repo 现只有 9 个默认 label，全无——dry-run 实测 `gh api .../labels` 过滤 renderer/leafer/kernel/severity 全 `[]` | `MISSING=0; for L in renderer leafer regression severity-P0 severity-P1; do gh api repos/xindong/mivo-canvas/labels/"$L" >/dev/null 2>&1 \|\| { echo "MISSING: $L"; MISSING=1; }; done; [ $MISSING -eq 0 ]`（r3 `grep -E 'renderer\|leafer'` 是 OR，任一存在即过，不能保证两者都创建；r4 逐个精确断言，缺任一 rc=1） |

**telemetry 表 schema**（renderer 与 kernel 共用 `mode_hits`，删轨前置创建）：

```sql
CREATE TABLE mode_hits (
  id bigserial PRIMARY KEY,
  track text NOT NULL CHECK (track IN ('renderer','kernel')),
  mode text NOT NULL,
  ts   timestamptz NOT NULL DEFAULT now(),
  user_id text,
  ip text
);
CREATE INDEX mode_hits_track_mode_ts ON mode_hits (track, mode, ts);
-- BFF 路由 POST /api/mivo/renderer-mode {mode} → INSERT (track='renderer', mode, ...)
-- 工装 IP 白名单在 BFF 路由内过滤（pixi 工装内访问不写表），故 mode='pixi' 行即"工装外命中"
```

> r2 原文给 `SELECT count(*) FROM renderer_mode_hits ...` + 虚构 `remote_debug` 表，前者表名错（统一为
> `mode_hits`）、后者服务端 sink 实为按日期 JSONL（`server/lib/debug-records.ts:182,210`，非 PG 表）——
> r3 一并定死：mode 计数走 `mode_hits` PG 表；shadow mismatch 走 JSONL（见 §2.2②）。

**硬门控指标（5 项，全绿才可开删轨 PR；每条命令已 dry-run）**：

1. **生产 `?renderer=dom` 30 天命中 = 0**
   ```bash
   psql "$DATABASE_URL" -c "SELECT count(*) FROM mode_hits WHERE track='renderer' AND mode='dom' AND ts > now()-interval '30 days'"
   ```
   样例（green）：`0`（fixture dry-run PG16：40 天前旧命中被 30 天窗排除，30 天内计数=0）。

2. **生产 `?renderer=pixi` 工装外 30 天命中 = 0**（完整命令，非 WHERE 片段）
   ```bash
   psql "$DATABASE_URL" -c "SELECT count(*) FROM mode_hits WHERE track='renderer' AND mode='pixi' AND ts > now()-interval '30 days'"
   ```
   样例（green）：`0`。

3. **e2e `--renderer=both` 最近 20 merged PR 连续绿**（目标 context 过滤 + 连续性断言，非 `grep -c success` 笼统计）
   ```bash
   TARGET='e2e prod subset (mock upstream)'
   gh pr list -R xindong/mivo-canvas --state merged --limit 25 --json number,mergedAt \
     --jq "sort_by(.mergedAt)[-20:] | reverse | .[].number" \
     | while read pr; do
         gh pr checks "$pr" -R xindong/mivo-canvas --json name,state \
           --jq "[.[] | select(.name==\"$TARGET\") | .state][0] // \"MISSING\""
       done | awk 'BEGIN{tot=0;fail=0} {tot++; if($0!="SUCCESS") fail++} END{print "total:",tot,"failures:",fail; exit !(tot==20 && fail==0)}'
   ```
   样例（dry-run 2026-07-12 真实数据，PR #216→#198）：`total: 20 failures: 0`（rc=0 绿）。
   断言（r4 改 R3-3）：`exit !(tot==20 && fail==0)`——**机械断言 total==20 且 failures==0**。r3 原命令只统计 non-SUCCESS，截断 <20 条全成功也输出 `non-SUCCESS: 0` 假绿、空输入无失败信号；r4 退出码：20/20 rc=0、19/19 rc=1、20 中 1 MISSING rc=1、0 条 rc=1、截断 10 条 rc=1（本地 dry-run 5 case 验）。

4. **visual-diff (dom vs leafer) 最近 20 merged PR 连续 PASS**（DIFF_THRESHOLD_PERCENT 默认 5%，`scripts/visual-diff.mjs`）
   ```bash
   TARGET='visual diff (dom vs leafer)'
   gh pr list -R xindong/mivo-canvas --state merged --limit 25 --json number,mergedAt \
     --jq "sort_by(.mergedAt)[-20:] | reverse | .[].number" \
     | while read pr; do
         gh pr checks "$pr" -R xindong/mivo-canvas --json name,state \
           --jq "[.[] | select(.name==\"$TARGET\") | .state][0] // \"MISSING\""
       done | awk 'BEGIN{tot=0;fail=0} {tot++; if($0!="SUCCESS") fail++} END{print "total:",tot,"failures:",fail; exit !(tot==20 && fail==0)}'
   ```
   样例（dry-run 2026-07-12）：`total: 20 failures: 0`（rc=0 绿）。
   断言（r4 改 R3-3）：r3 原命令 `sort -u` 只去重看唯一值，空输入直接空输出无失败信号（假绿）；r4 改与指标 3 同模板，`total==20 && failures==0` 退出码断言。

5. **leafer 渲染回归 bug P0/P1（观察窗内）= 0**（r4 改 R3-5：severity schema + state all + created 时间窗）
   ```bash
   # 硬前置：severity label 全存在（见上前置表），缺则本指标不可判定
   OBS_START="<telemetry 上线日 YYYY-MM-DD>"   # owner 填观察起点
   P0=$(gh issue list -R xindong/mivo-canvas --state all --label leafer --label regression --label severity-P0 --search "created:>=$OBS_START" --json number | jq 'length')
   P1=$(gh issue list -R xindong/mivo-canvas --state all --label leafer --label regression --label severity-P1 --search "created:>=$OBS_START" --json number | jq 'length')
   echo "P0=$P0 P1=$P1"
   [ "$P0" -eq 0 ] && [ "$P1" -eq 0 ]   # rc=0 绿，rc=1 红
   ```
   样例（green）：`P0=0 P1=0`（rc=0）。dry-run mock：正例 `[]`/`[]` GREEN；P0=1 RED；已关闭 P1 incident（`state all` 仍计）RED。
   r3 原命令 `--state open --search "P0 OR P1"` 三缺陷（R3-5）：①`state=open` 漏窗口内发生后已关闭的回归；②`--search "P0 OR P1"` 是文本搜索非 severity schema（issue body 提"P0"即命中、未提则漏）；③`--label` 命中不存在 label 静默返 `[]` 假绿。r4 改 `state all`（已关闭 incident 仍计发生数）+ severity label schema（regression + severity-P0/P1）+ `created:>=$OBS_START` 时间窗 + label 前置先验。

**监控项（非门控，不卡删轨）**：

- **leaferPaintSignature bench dragP95**：< 8ms 且 < allP95（看最近 20 PR 中位数趋势）。`bench` job summary
  （`leaferPaintSignature.bench.test.ts`）。**已知 flaky**（issue #172，共享 runner 毫秒级抖动）——**单 PR 超阈不阻断**，
  只看 20 PR 中位数趋势是否回归。r2 摘要表"6 指标全绿"与"非阻断"语义冲突，r3 校正为"5 硬门控 + 1 监控项"
  （见 §3 摘要表），bench 不进删轨硬门控。

#### ③ 删除 PR 范围清单
**只删 dom 渲染器轨**，不删永久 DOM overlay（text/markup/frame-title/选中壳是 leafer 模式组件）。

| 类别 | 路径 | 动作 |
|---|---|---|
| 渲染器轨主文件 | `src/render/DomRenderer.tsx` | 删除 |
| 渲染器模式开关 | `src/render/rendererMode.ts:18,22,47-50` | `RendererMode` 去掉 `'dom'`；`VALID_MODES` 去 `dom`；删 dom 分支（`:47-50`） |
| pixi spike 遗留（同步清，NO-GO） | `src/render/rendererMode.ts:13,51-54`；`src/render/usePixiSpikeRenderer.ts`；`src/render/useEngineSpikeRenderers.ts` pixi 分支 | 删除（pixi 非本组双轨，但同为渲染器维冗余，建议同 PR 清） |
| 适配器契约 | `src/render/rendererAdapter.ts:29` | `mode` 收为 `'leafer'`；删 `:23-26` DOM 声明式注释 |
| 消费方 dom 分支 | `src/canvas/MivoCanvas.tsx`、`src/render/textPaintMode.ts` | 删 dom 分支，只留 leafer |
| 视口 pan pixi 分支（r5 补 D4-R5-4） | `src/canvas/useViewport.ts:84`（`engineOnlyPan` 判 `shell.dataset.rendererMode === 'leafer' \|\| ... === 'pixi'`） | 迁移：去 `'pixi'` union 后三元收为 `=== 'leafer'` 单条件；r4 漏列——删 `'pixi'` 后此 pixi 比较成死分支 |
| e2e probe dom fallback（r5 补 D4-R5-4） | `scripts/e2e/scenarios/coordinate-probe.mjs:27`（`rendererMode: shell?.getAttribute('data-renderer-mode') \|\| 'dom'` 默认 'dom'） | 迁移：默认值改 `'leafer'`（dom 轨删后默认 dom 无意义）；r4 漏列 |
| textPaintMode dom 断言（r5 补 D4-R5-4） | `src/render/textPaintMode.test.ts:17-21,29-33,35-38`（三处 `expect(...).toBe('dom')` 断言缺省/非法值/显式 dom 三个 case） | 删 dom case：dom 轨删后 `textPaintMode` 收为 leafer-only，这三处 `toBe('dom')` 断言须随实现收敛改/删；r4 漏列 |
| bench harness dom/pixi 消费（r4 补 R3-6） | `scripts/bench/collect.mjs:95,140,415-481,1006-1088`（默认 `renderer:'dom'`、`--renderer=` 解析默认 dom、`requestedRenderer||'dom'`、pixi 属性采集 `pixiChildren`/`pixiPixelNonEmpty` 等） | 迁移：bench harness 默认改 leafer-only、去 dom/pixi 双轨采集；collect.mjs 的 pixi 属性读取分支随 pixi spike 删除清。r3 漏列——删 `RendererMode` `'dom'`/`'pixi'` 后此 harness 遗留死分支 |
| LOD 引擎 pixi 分支（r4 补 R3-6） | `src/render/engineSpikeLod.ts:139`（`rendererMode==='leafer'?leaferStats:rendererMode==='pixi'?pixiStats:emptyEngineLodStats()`） | 迁移：去 `'pixi'` union 后 pixi 三元分支成死分支，删 `pixiStats` carrier 或收为 leafer-only。r3 漏列 |
| Leafer spike filter dom/pixi 分支（r4 补 R3-6） | `src/render/leaferSpikeFilter.ts:182`（`rendererMode==='pixi'?nodes.filter((node)=>!isPixiSpikePainted(node)):nodes` 分支）；`src/render/leaferSpikeFilter.test.ts:118-149`（dom case `filterDomNodesForRendererSpike(all,'dom')`） | 迁移：去 `'dom'`/`'pixi'` union 后 ternary 收为 leafer-only；test 的 dom case 删。r3 漏列 |
| Leafer spike renderer pixi 早返（r4 补 R3-6） | `src/render/useLeaferSpikeRenderer.ts:443`（`if(rendererMode==='pixi') return`） | 迁移：去 `'pixi'` union 后早返成死分支，删。r3 漏列 |
| 降级管道（fallback 语义重定义） | `src/render/rendererFallback.ts:3-18`（`computeEffectiveRendererMode`：pixi 或 leafer init 失败（`fallbackToDom=true`）→ effectiveRendererMode 降到 `'dom'`，DOM 接管） | 迁移：删 dom 后此 fallback 到 dom 无意义（dom 轨已删）。**必须先重定义失败语义**——leafer init 失败时改为"leafer retry + 错误 toast + `debugLogger.warn`（不上报 blank dom，避免白屏）"。与上一行 `rendererMode.ts` 去 `'dom'` union 耦合（fallback 返回类型不再含 `'dom'`）。保留文件改逻辑；`rendererFallback.test.ts` 的 dom-fallback case 改新语义 |
| pixi.js 依赖 | `package.json:42`（`"pixi.js": "^8.19.0"`） | 删除（随 pixi spike 遗留清理，:115 行已列 pixi 源文件；dep 同 PR 清，避免孤儿依赖——r1 漏列） |
| e2e 旗标 | `scripts/e2e-runner.mjs`、`scripts/e2e-smoke.mjs`（`parseRenderer` / `--renderer`） | 删 `both`/`dom`，leafer-only（或整体去 `--renderer` 旗标） |
| visual-diff harness | `scripts/visual-diff.mjs`、`scripts/visual-shell-baselines.mjs` | 删除（无 dom baseline） |
| visual-diff npm scripts（r3 漏列补） | `package.json:13-14`（`"visual:diff": "node scripts/visual-diff.mjs"`、`"visual:diff:shell": "node scripts/visual-shell-baselines.mjs"`） | 删除——harness 文件删后这两个 script 成孤儿调用死路径；同 PR 删避免 `npm run visual:diff` 指向不存在文件 |
| visual-diff BFF probe（r3 漏列补） | `server/app.ts:77-84`（`MIVO_VD_TOKEN` env-gated `GET /__vd_probe` 路由——仅 `scripts/visual-diff.mjs` 跑时设 token，用于确认本 BFF 进程非 stale 占端口） | 删除——visual-diff 删后无消费方，probe 成死代码。env-gated 故平时不激活，但留则需随 stale-process 检测语义一起维护；删后 `/__vd_probe` 路由与 `vdProbeToken` 变量一并清 |
| CI job | `e2e-prod-subset`（ci.yml `:136` job / `:182` run）：去 `--renderer=both` → leafer-only；`e2e-kernel-gate`（`:217`/`:252`）：去 `--renderer=both`；`visual-diff`（`:283`）：整段删（无 dom baseline 可对照） | 见 §1.5「CI required job 两阶段迁移」——`visual diff (dom vs leafer)` 是 required context，直接删 job 会让所有 PR 永卡 Expected |
| 单测 | `src/render/rendererMode.test.ts`、`src/render/rendererFallback.test.ts`、`src/render/useEngineSpikeRenderers.failsafe.test.ts`、`src/render/usePixiSpikeRenderer.ts` 关联测 | 删 dom/pixi case |
| 文档 | `CLAUDE.md`（"默认渲染器"段 + "?renderer=dom 应急回退"）、`src/render/README.md` | 删 dom 回退段，改 leafer-only |

**注意（防误删）**：`src/render/EditOverlayLayer.tsx`、text/markup/frame-title 的 DOM overlay
渲染路径**保留**——它们是 leafer 模式下仍生效的组件（PR #124/#125/#132），不属于 dom 渲染器轨。
删轨 PR 的 import-graph 守卫须验证这些 overlay 仍被 leafer 路径消费。

**e2e scenario `.dom-node` 选择器属永久 overlay，非 dom 渲染器轨消费者（r5 补 D4-R5-4 全仓清单口径）**：
全仓 `grep -rln "dom" src/ scripts/ server/` 命中 20+ 文件，但多数命中是 `.dom-node` CSS 类选择器
（canvas 节点以 DOM 元素渲染的 class，FU-11 markup / FU-12 frame-title / 选中壳等**永久 DOM overlay**，
leafer 模式同样使用，见上一段），不是 `'dom'` 渲染器模式字符串消费者。`scripts/e2e/scenarios/` 下
`markup-text-overlay.mjs`、`project-sidebar.mjs`、`stamp-overlap.mjs`、`variations-annotation.mjs` 的 `.dom-node`
选择器与 `rendererMode === 'leafer' ? ... : ...` 分支属此类——删 dom 轨后分支塌为 leafer-only 但**不破编译**
（`.dom-node` 是 CSS class 串，非 `RendererMode` 类型字面量）。真正用 `'dom'`/`'pixi'` 渲染器模式**字符串字面量**
的消费者（删 union 后破编译或成死分支）已列入上表：`rendererMode.ts`、`rendererAdapter.ts`、`rendererFallback.ts`、
`usePixiSpikeRenderer.ts`、`useEngineSpikeRenderers.ts`、`engineSpikeLod.ts`、`leaferSpikeFilter.ts`(+test)、
`useLeaferSpikeRenderer.ts`、`textPaintMode.ts`(+test)、`collect.mjs`、`e2e-runner.mjs`/`e2e-smoke.mjs`、
`useViewport.ts`、`coordinate-probe.mjs`。验收：模拟删 `'dom'`/`'pixi'` union 后 `npx tsc -b` + unit +
pg-suite 绿；全仓 `grep -rn "'dom'\|'pixi'" src/ scripts/ server/` 仅命中明确允许的历史文档/注释或上表已列文件。

#### ④ 回滚终止日
- **回滚通道**：`?renderer=dom`（应急回退，生产可即时切回——渲染层无状态投影，flag 切回不丢数据，真相源在 IDB canonical / PG persist）。
- **终止日**：删轨 PR 合并日（= telemetry 上线日 + 30 天观察窗 5 硬门控全绿后，**不倒算日历日 2026-08-06**——telemetry 未上线则窗口不起算）。
- 终止后回滚 = git revert 删轨 PR + 重新部署（依赖 9:00/17:00 cron 或手动 `deploy.sh`）。

#### ⑤ owner
**推荐**：渲染层 maintainer（建议曾主导 Leafer 接入 #98/#110-#131 系列者）。
**待 lead 指派具体人选**。

#### 推荐 / 备选
- **推荐**：telemetry 上线后 + 30 天观察窗 + 5 硬门控全绿 → 开删轨 PR。**不倒算日历日**
  （telemetry 未上线则窗口不起算）。平衡稳妥性与成本——dom 轨每天在 CI 里跑两份 e2e +
  一份 visual-diff，30 天 ≥ 20 PR 验证密度足够。
- **备选**：14 天短窗，仅当 14 天时 **5 硬门控全绿且 leaferPaintSignature bench 连续 10 PR
  dragP95<8ms（中位数）——bench 升格为备选策略额外门槛**（r4 改 R3-4：r3 泛称"6 指标"含非门控
  bench，与"5 硬门控 + 1 监控项"自相矛盾；推荐路径 bench 只监控不阻塞，§2.1②；备选才把 bench
  升格为额外条件，非同一 6 指标）。风险：周末/特定用户工作流未覆盖；且 telemetry 上线日 + 14 天
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
telemetry 前置同 renderer（§2.1②）：mode 计数走 `mode_hits` PG 表（`track='kernel'`），shadow mismatch 走
debug-logs JSONL（`server/lib/debug-records.ts:182` logDir，非虚构 PG 表——r2 原文 `SELECT FROM remote_debug` 是虚构表，已撤）。

**kernel label 前置（r4 补 R3-5）**：建 `kernel` label + severity schema 同 renderer（§2.1② `regression`/`severity-P0`/`severity-P1` 共用，renderer/kernel 一套 severity）。逐个精确验收（r3 未列 kernel label 创建/验收步骤）：
`MISSING=0; for L in kernel regression severity-P0 severity-P1; do gh api repos/xindong/mivo-canvas/labels/"$L" >/dev/null 2>&1 \|\| { echo "MISSING: $L"; MISSING=1; }; done; [ $MISSING -eq 0 ]`（缺任一 rc=1）。

**硬门控指标（4 项，每条命令已 dry-run）**：

1. **shadow compare 不一致 warn（30 天）= 0**（warn 远传落 JSONL，jq 扫近 30 天文件）
   ```bash
   # 生产 BFF 机：jq 扫近 30 天 debug-logs JSONL，数 source=Kernel 且 message 含 mismatch 的 warn
   LOGDIR="${MIVO_DEBUG_LOG_DIR:-data/debug-logs}"
   find "$LOGDIR" -name '*.jsonl' -mtime -30 -exec cat {} + 2>/dev/null \
     | jq -s '[.[] | select(.level=="warning" and .source=="Kernel" and ((.message // "") | test("mismatch")))] | length'
   ```
   样例（green）：`0`（fixture dry-run：含 2 条 Kernel mismatch warn 的 JSONL → 计数 `2`；空 logdir → `0` 不挂起，证 filter 可判 mismatch）。
   `find -mtime -30` 取近 30 天文件、`-exec cat {} +` 无文件不调 cat；`jq -s` 把 JSONL 行 slurp 成数组后 filter。`debugLogger.warn('Kernel', ...)` 经 `remoteDebugReporter` warn level 远传 → POST `/api/mivo/debug-logs` → `appendRemoteDebugRecords`（`debug-records.ts:192`）写 `${date}.jsonl`，`source`/`message`/`level` 字段见 `RemoteDebugRecord`（`:17-38`）。

2. **e2e `--kernel=both` 最近 20 merged PR 连续绿**（双 context 都 SUCCESS；C-switch PR 必先改 CI 矩阵跑 both，见下注）
   ```bash
   C_SWITCH_MERGED_AT=$(gh api repos/xindong/mivo-canvas/pulls/<C-switch-PR-number> --jq '.merged_at')
   gh pr list -R xindong/mivo-canvas --state merged --limit 100 --json number,mergedAt \
     --jq "[.[] | select(.mergedAt >= \"$C_SWITCH_MERGED_AT\")] | sort_by(.mergedAt)[-20:] | reverse | .[].number" \
     | while read pr; do
         gh pr checks "$pr" -R xindong/mivo-canvas --json name,state \
           --jq "([.[] | select(.name==\"e2e prod subset (mock upstream)\") | .state][0] // \"MISSING\") + \" \" + ([.[] | select(.name==\"e2e kernel gate (new)\") | .state][0] // \"MISSING\")"
       done | awk 'BEGIN{tot=0;fail=0} {tot++; if($1!="SUCCESS" || $2!="SUCCESS") fail++} END{print "total:",tot,"failures:",fail; exit !(tot==20 && fail==0)}'
   ```
   样例（dry-run 2026-07-12 真实数据，PR #216→#198）：`total: 20 failures: 0`（rc=0 绿）。
   断言（r4 改 R3-3）：双 context 每行 `$1 $2` 都须 SUCCESS，`total==20 && failures==0` 退出码断言。**`select(.mergedAt >= "$C_SWITCH_MERGED_AT")` 限 C-switch 合并后 PR**（r3 原命令无下界，C 前历史成功可补足 20 假绿，R3-3）；`C_SWITCH_MERGED_AT` 从 `gh api pulls/<n> .merged_at` 派生（同 §2.2③ guard step 1，非人工填）；`limit 100` 保 C-switch 后够取 20。

3. **checkpointed rollback drill 通过**（一次性，非 30 天指标）
   ```bash
   npm run test:unit -- src/kernel/shadowCompare.test.ts src/kernel/rollbackTrigger.test.ts   # 契约 §4.7 场景 2-4 绿（r5 改 D4-R5-6：仓库无 `test` script，改 `npm run test:unit`）
   # drill：手动 new→legacy→new roundtrip，验画布/聊天/资产无损 + revision/CRDT clock/三域元数据按 §4.5 重建
   # drill 报告路径写入 D PR 的 machine-readable 事件（见 §2.2③ 末 D 门控注意块，R3-P2-4 改为可核验字段）
   ```
   样例：测试 `pass`（dry-run 2026-07-12 worktree HEAD：`npm run test:unit -- src/kernel/shadowCompare.test.ts src/kernel/rollbackTrigger.test.ts` 跑 2 files / 34 tests 全绿 rc=0；原 `npm test` 报 `Missing script: "test"` rc=1，D4-R5-6）；drill 报告 `docs/reports/kernel-rollback-drill-<date>.json`（符 §2.2③ drill report JSON schema，由独立 closeout PR 合入 main）存在且 `jq -e` 校验通过（`roundtripVerdict=="pass"` + 六项 `checks` 全 true）。

4. **内核回归 bug P0/P1（观察窗内）= 0**（r4 改 R3-5：severity schema + state all + created 时间窗 + kernel label 前置补全）
   ```bash
   # 硬前置：kernel + severity label 全存在（见 §2.1② severity schema + 本组 kernel label 前置），缺则不可判定
   OBS_START="<C-switch 合并日 YYYY-MM-DD>"   # owner 填观察起点
   P0=$(gh issue list -R xindong/mivo-canvas --state all --label kernel --label regression --label severity-P0 --search "created:>=$OBS_START" --json number | jq 'length')
   P1=$(gh issue list -R xindong/mivo-canvas --state all --label kernel --label regression --label severity-P1 --search "created:>=$OBS_START" --json number | jq 'length')
   echo "P0=$P0 P1=$P1"
   [ "$P0" -eq 0 ] && [ "$P1" -eq 0 ]   # rc=0 绿，rc=1 红
   ```
   样例（green）：`P0=0 P1=0`（rc=0）。r3 原命令同 renderer 三缺陷（`state=open` 漏已关闭 / 文本搜索非 schema / label 缺失静默返空），r4 同改 + `--label kernel` 限定内核领域。

**监控项（非门控）**：

- **生产 kernel 身份**：切默认后 `?kernel=` 缺省解析 new；`?kernel=legacy` 仅受控 rollback drill 产生（非用户流量）。
  ```bash
  psql "$DATABASE_URL" -c "SELECT count(*) FROM mode_hits WHERE track='kernel' AND mode='legacy' AND ts > now()-interval '30 days'"
  ```
  样例（green，C 后）：≈ drill 次数（1-2，来自受控 drill 时段）；若远超 drill 计数 = 有用户回退，须查。不卡删轨，作旁证监控。

**一次性 gate（非 30 天指标，FX-6 实施 PR 验收时即定）**：

- **账号切换 canonical 不撞**：A→B→A→logout→B 全场景 storage key 全属当前 userId。契约 §5.5 验收（FX-6 实施 PR 的契约测试）：
  ```bash
  npm run test:unit -- src/kernel/useKernelRead.contract.test.ts   # FX-6 账号切换 e2e 绿（r5 改 D4-R5-6：同上，`npm run test:unit` 非 `npm test`）
  ```
  样例：`pass`（dry-run 2026-07-12 worktree HEAD：`npm run test:unit -- src/kernel/useKernelRead.contract.test.ts` 跑 1 file / 7 tests 全绿 rc=0）。

> **C-switch PR 必含 CI 矩阵改动（r1 漏列，P2-6 修复）**：② 第 2 条要求"e2e `--kernel=both`
> 连续绿"，但现状 ci.yml 不跑 both——`e2e-kernel-gate`（`:252`）固定 `--kernel=new`，
> `e2e-prod-subset`（`:182`）不带 `--kernel`（跑默认 kernel，C 切默认 new 后 = 只跑 new）。
> **两 job 都不跑 legacy**，C 后 legacy 回退路径零 e2e 覆盖。故 C-switch PR 范围必须含：
> 把 `e2e-prod-subset` 改 `--kernel=both`（或给 `e2e-kernel-gate` 加 legacy leg），使 C 观察窗内
> new+legacy 都在 required CI 跑。此改动在 C-switch PR 内与默认切换同提，不另开 PR——否则
> "both 观察不会发生"让 ② 第 2 条指标不可判定。

#### ③ 删除 PR 范围清单（D 阶段）
**前置硬约束**：D 阶段删轨 PR 不得早于 C 阶段切默认 PR 合并 + 30 天观察窗 + rollback drill 通过。

| 类别 | 路径 | 动作 |
|---|---|---|
| 内核模式开关 | `src/app/kernelMode.ts:22`（`KernelMode` union）、`:24`（`DEFAULT_MODE='legacy'`）、`:40-53`（`resolveKernel` legacy 分支）、`:79-87`（`getKernelMode`/`isLegacyKernel`/`isNewKernel`） | 迁移：收为 new-only 常量（`KernelMode='new'`、`getKernelMode()→'new'`、删 `isLegacyKernel`/`resolveKernel` legacy 路径）；开关文件或留为常量或删 |
| **new 内核实现（保留，不在删除清单）** | `src/kernel/docKernel.ts:55`（`MemoryDocKernel` 类）、`:148`（`createDocKernel` 工厂）；`src/kernel/docKernelPersistAdapter.ts`、`src/kernel/persistMigration.ts`、`src/kernel/useKernelRead.ts`、`src/kernel/records.ts`、`src/kernel/mapping.ts` | **保留**：`docKernel.ts:3` 明写「?kernel=new 才消费，legacy 不读」——`MemoryDocKernel` 是 new 内核实现（D 后成唯一轨），**不是 legacy**，r1 误列已纠正。`persistMigration.ts` 的 legacy 格式半可在 D 后裁，迁移工具本体保留 |
| new 内核 `isLegacyKernel` 消费（r4 补 R3-6） | `src/kernel/useKernelRead.ts:28`（import `isLegacyKernel`）、`:53,55,66,85`（selector `isLegacyKernel ? '' : s.sceneId` / memo `if (isLegacyKernel || !document) return null` / scheduler `isLegacyKernel ? null : createShadowScheduler` 做 legacy 短路）；源码契约测 `useKernelRead.contract.test.ts:33-46` 断言这些短路 | 迁移：:451 把 useKernelRead 列"new 实现保留"但 r3 漏查它活跃 import/use `isLegacyKernel`——删 :450 的 `isLegacyKernel` 后此 hook 编译断或遗留死分支。D PR 必随开关收敛：删 `isLegacyKernel ? '' : s.sceneId` 短路（D 后唯一 new，selector 直接读 store）、删 `if (isLegacyKernel || !document) return null` 的 legacy 半、删 `isLegacyKernel ? null : createShadowScheduler` 的 legacy 半；源码契约测同步改 new-only 语义。**非纯保留** |
| legacy command dispatch 出口 | `src/canvas/actions/canvasActionModel.ts`（契约 §6 `:239-241`：UI closure 不可序列化；new 出口 = `CanvasCommand` JSON union T2.3 新增） | 迁移：new 出口 `CanvasCommand` 接管后，legacy dispatch 路径 + characterization 测试（`canvasActionModel.characterization.*.test.ts`）在 D 删 |
| legacy persist adapter / 兼容桥 | `src/store/canvasPersistConfig.ts`（zustand persist 的 `migrate` hook = 契约 §4.2-4.4 legacy↔new 兼容桥，C→rollback 仪式依赖它）；消费方 `src/app/useStoreHydration.ts`、`src/kernel/useKernelRead.ts`（均 import `isLegacyKernel`） | 保留至 D：`migrate` hook 是 C 阶段 rollback 保险，D 删 legacy 格式半后 migrate hook 退场；`useStoreHydration`/`useKernelRead` 的 `isLegacyKernel` 分支随开关收敛。**r5 更正（D4-R5-4）**：r4 误列 `src/lib/assetServiceMode.ts` 为 `isLegacyKernel` 消费方——全仓 `grep -rln isLegacyKernel src/ server/ scripts/` 实测 7 命中（`src/app/kernelMode.ts`、`src/app/kernelMode.test.ts`、`src/app/useStoreHydration.ts`、`src/store/canvasPersistConfig.ts`、`src/kernel/useKernelRead.ts`、`src/kernel/useKernelRead.contract.test.ts`、`src/kernel/shadowRoundTrip.bench.test.ts`）不含 `assetServiceMode.ts`，r4 误列已撤 |
| legacy 缓存 namespace | 扁平 key `mivo-canvas-demo` / `mivo-chat-demo` / `mivo-canvas-assets`（契约 §5.1 `:184-185`，pre-FX-6） | 迁移：FX-6 per-user 化（`${BASE}:${userId}`）后消亡；FX-6 是 C 前置（见 ① FX-6 行），D 时 legacy 扁平 key 已无消费方 |
| e2e 旗标 | `scripts/e2e-runner.mjs`、`scripts/e2e-smoke.mjs`（`parseKernel` / `--kernel`） | 删 `both`/`legacy`，new-only（或整体去 `--kernel` 旗标） |
| CI job | ci.yml `e2e-kernel-gate`（`:217`） | 并入 `e2e-prod-subset`（不再有 kernel 维笛卡尔积）；但 `e2e kernel gate (new)` 是 required context——见 §1.5「CI required job 两阶段迁移」，直接删 job 会让所有 PR 永卡 Expected |
| 契约文档 | `docs/decisions/kernel-dualtrack-contract.md` | 标 RESOLVED 归档；ckpt key（§5.2 `:194-196`）清理脚本随 D PR 落 |
| 单测 | `src/app/kernelMode.test.ts` | 删 legacy/both case |
| VITE_MIVO_KERNEL env | 构建配置 | 删（new-only，无切换） |

**注意（防跳阶段，machine-readable 门控；r3 改外部可核验字段 + guard 走 GitHub API + 自保护如实归 base-side；r4 修 event 生成时序，R3-1）**：
D PR 不得仅靠"PR 描述显式声明"——描述与事实可脱节，且 r2 的人工填布尔/日期/计数可伪造（R3-P2-4）。

**event 生成时序（r4 修正 R3-1）**：event **不由 C-switch PR 落盘**——C 合并前不可能知道最终
`merge_commit_sha` / `merged_at`，且 rollback drill 发生在 C 合并后、报告更不可能在 C PR 内。r3 要求
C PR 落盘这些 post-merge 字段 = 预填可伪造事实。r4 改为：event 由 **D 阶段删轨 PR 开工时**落盘
`docs/decisions/kernel-c-switch-event.json`——此时 C-switch 早已合并、drill 早已完成、drill 报告已由
**独立 closeout PR 合入 main**（非 D PR 自己塞，D PR 改不动它）。event 只存**两个可人工填且可经 API
核验真伪**的字段，merge SHA / mergedAt / drill 内容**全由 guard 经 GitHub API 派生**，不入 event：

| 字段 | 值 | 核验依据 |
|---|---|---|
| `schemaVersion` | event schema 版本（当前 `1`） | guard 按版本校验 event 字段齐全 |
| `cSwitchPrNumber` | C-switch PR 号（如 `216`） | `gh api repos/xindong/mivo-canvas/pulls/<n>` → `.merged==true`（PR 号可人工填但真伪由 API 判） |
| `drillReportPath` | rollback drill 报告仓库内相对路径（独立 closeout PR 已落 main） | `gh api repos/.../contents/<path>` 存在 + 报告符 r4 JSON schema |

> **event 不再含 `cSwitchHeadSha` / `cSwitchMergedAt`**（r3 误列两字段）：均为 post-merge 数据，
> C PR 合并前不可知，r3 要求 C PR 落盘 = 预填可伪造事实（R3-1）。r4 改为 guard 调
> `pulls/<cSwitchPrNumber>` 从 API 读 `.merge_commit_sha` / `.merged_at`，event 不存它们。

**drill report JSON schema（r4 定义机器可解析 schema，替代 r3 "`schemaVersion=1` + Markdown 有字段"模糊表述）**。
报告为独立 JSON 文件（如 `docs/reports/kernel-rollback-drill-<date>.json`），由独立 closeout PR 合入 main：

```json
{
  "schemaVersion": 1,
  "executedAt": "2026-07-10T08:00:00Z",
  "executor": "<github-handle>",
  "roundtripVerdict": "pass",
  "checks": {
    "canvasLossless": true,
    "chatLossless": true,
    "assetLossless": true,
    "revisionRebuilt": true,
    "crdtClockRebuilt": true,
    "metadataRebuilt": true
  }
}
```

guard 用 `jq -e` 校验全字段必填（任一缺 / 类型错 / `verdict≠pass` 必红）：

```bash
jq -e '.schemaVersion==1 and (.executedAt|type=="string") and (.executor|type=="string") and .roundtripVerdict=="pass" and (.checks.canvasLossless and .checks.chatLossless and .checks.assetLossless and .checks.revisionRebuilt and .checks.crdtClockRebuilt and .checks.metadataRebuilt)' <drill-report.json>
```

D PR 的 `scripts/ci/structure-guard.mjs` 加机械检查（每条对应一外部事实，五负例逐一必红；**所有 post-merge 事实从 GitHub API 派生，不信 event 内填的 SHA / 日期 / 计数**）：

1. `gh api repos/xindong/mivo-canvas/pulls/<cSwitchPrNumber>` → `.merged==true`（**伪造 PR 号 / 未合并必红**）；从同一响应读 `merge_commit_sha` 备第 4 条用（**不与 event 内字段比对——event 不存 SHA，R3-1**）；
2. 从上一步 API 响应的 `.merged_at` 算距 D PR 开工日 ≥ 30 天（**伪造日期必红**——日期来自 API 非人工填）；
3. `gh api repos/xindong/mivo-canvas/contents/<drillReportPath>` 存在 + 内容符上 JSON schema（`schemaVersion==1` / `roundtripVerdict=="pass"` / `executedAt` / `executor` / 六项 `checks` 全 true）（**缺报告 / 不符 schema 必红**）；报告由独立 closeout PR 落 main，D PR 改不动它；
4. `gh api repos/xindong/mivo-canvas/commits/<step 1 API 派生的 merge_commit_sha>/check-runs` + 枚举 cSwitch 之后 merged PR，数连续两个 kernel context（`e2e prod subset (mock upstream)` + `e2e kernel gate (new)`）均 `SUCCESS` 的 PR ≥ 20（**从 check-runs API 计数，不信人工填 ciBothGreenRuns；手填 20 必红**）；SHA 由 step 1 API 派生，非 event 填；
5. `! grep -q "'legacy'" src/app/kernelMode.ts`（new-only 收敛，文件内可查）。

任一不满足 → structure-guard 红 → D PR 挡合并。

> **r4 dry-run 证据**（本地 fixture，复核人可重跑）：mock `pulls/216` 响应经 `jq` 正确提取
> `.merged` / `.merge_commit_sha` / `.merged_at`；30 天窗口 `days_since_merge>=30` 判定正确；
> drill report 正例（全字段 + `verdict=pass`）`jq -e` rc=0、负例（缺 `chatLossless`）rc=1 拒；
> event 文件 `jq -e` 验只含 `schemaVersion` / `cSwitchPrNumber` / `drillReportPath` 且
> `has("cSwitchHeadSha")|not` rc=0——证 event 不存 post-merge SHA 字段、guard 全派生链可判。

**自保护边界（r3 如实写明，不声称"历史断言自保护"）**：`structure-guard.mjs` 是**分支内脚本**，
D PR 可同时改 `kernelMode.ts` + `structure-guard.mjs` 让弱化后的 guard 在自己 CI 里绿——
r2 的"structure-guard 历史断言会挡'移除该检查'的倒退 PR"**不成立，已撤**。真实防线三层：
1. **审查纪律（当前实际落地）**：D PR 的 reviewer 必须核 `structure-guard.mjs` diff 为"只增不减"
   （不删上述 5 条检查），与 trunk-guard `required_review_thread_resolution=true` 叠加——
   Greptile review 线程必 resolve，member 无法强 resolve 他人线程需 org owner 兜底（见 §1.5 末段）；
2. **候选 PR SHA 上的外部 check（可选加固，r4 改 R3-8）**：r3 第 2 层用 `.github/workflows/schedule`
   从 pinned tag 跑 `structure-guard.mjs` 并称"base-side 红会卡后续 PR"——**技术上不成立**：schedule
   workflow 绑**默认分支运行 SHA**，不为候选 PR head/merge SHA 产生 required status（GitHub required
   status 按**候选提交 SHA** 判定，schedule run 的 check suite 挂默认分支 SHA，即使同名 context 设
   required 也只让 PR 缺失/Expected，不由那次 schedule 结果对候选 PR 作可信判定）。r4 撤销该承诺。
   schedule 只能作**旁证监控**（监默认分支 guard 是否被未来 PR 退化，红时人工查 base drift），
   **非门控、不能卡候选 PR**。要真正作用于候选 SHA 且 PR 分支不能弱化，二选一：
   (a) **外部 GitHub App check**——App 注册 `structure-guard` check on `pull_request` 事件，跑在 PR head SHA、
       结果上报候选 SHA、进 required context；PR 分支改不动 App，弱化 guard 的 PR 被 App check 红卡；
   (b) **org 级 required workflow ruleset**——org owner 把 `structure-guard` 固化为 org ruleset 的 required
       check（跑在候选 SHA，member 无权弱化，见第 3 层）。
3. **org ruleset（终极，需 org owner）**：把"5 条检查"固化为 org 级 ruleset（trunk-guard `18006872`
   现不含此项，member 无权加，见 §1.5 末段）——这是唯一 D PR 改不动的层；第 2 层 (b) 即此层的
   required-workflow 形态。
本文如实标注：当前仅第 1 层有效，第 2 层（外部 App check / org required workflow）与第 3 层
（org ruleset）均需 org owner 或外部 App 配置、标为可选，**不夸大为已自保护**；r3 "schedule
红会卡后续 PR"的错误承诺已撤（R3-8）。


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

**前置：观测能力（删轨前必须先就位，否则事故/连接指标不可判定）**：

| 前置 | 动作 | 验收命令 |
|---|---|---|
| 事故登记源（**硬前置**，非"建议补"） | 建 `data-loss` GitHub label + `docs/reports/incident-log.md`（人工登记任何数据丢失事件，**事故段标题须带日期 `## YYYY-MM-DD <影响简述>` 机器可解析 schema**，正文记影响/根因/PR）。r2 原文"建议删轨前置补"与"数据丢失=0 硬指标"矛盾，r3 改硬前置；r5 补日期 schema 让 §2.3②指标 5 能按窗口过滤（D4-R5-3） | `gh api repos/xindong/mivo-canvas/labels/data-loss >/dev/null 2>&1` rc=0 + `test -f docs/reports/incident-log.md` |
| pm2 日志保留 ≥30 天 | 配 logrotate（daily + 30 份）或 pm2 `--merge --log-date-format` 落盘带时间戳。r2 原命令 `pm2 logs --lines 1000` 只覆盖近若干小时，证不了 30 天零错误 | `ssh "$MIVO_PROD_HOST" 'find ~/.pm2/logs -name "mivo-canvas-error.log*" -printf "%T@\n" \| sort -n \| awk "NR==1{old=\$1} END{print int((\$1-old)/86400)"'` 期望 ≥30（r4 改 R3-2：取 oldest/newest 实际 mtime 跨度天数；r3 `wc -l` 数文件数不证时间跨度——30 个同日文件也过）。**GNU `find -printf` 依赖**（r5 标注剩余风险）：生产 Linux 自带 GNU find 可用；BSD/macOS find 不支持 `-printf`，owner 在目标生产机 dry-run，本机仅用 fixture 验 oldest/newest mtime 跨度算法语义 |
| persist_observations 审计时序源（**硬前置**，r4 加 R3-2） | 建 `persist_observations(observed_at timestamptz, backend text, canvas_rows bigint, chat_rows bigint)` 表 + 每 3 天 cron 采样一次（生产 BFF 读 `MIVO_PERSIST_BACKEND` env 后 INSERT 带 backend 值 + `canvas_meta`/`chat_messages` 当前 count）。r3 原指标只 `printenv` 一次（只证当下）+ `created_at` 每日新增（非历史累计），证不了 30 天全 pg 且无重启切回 memory / 累计下降 | `psql "$DATABASE_URL" -c "\d persist_observations"` 期望表存在 + `psql "$DATABASE_URL" -tAc "SELECT count(*) FROM persist_observations"` 期望 ≥1 |

**硬门控指标（6 项，每条命令已 dry-run；prod-side 命令 form 经本地 PG16/sample log 验证，owner 在生产执行）**：

1. **生产 persist 后端身份 = pg，无 memory 回退（观察窗内；r5 改 D4-R5-2：S7 前不污染 + 新鲜度断言）**
   ```bash
   OBS_START="<cutover S7 日 YYYY-MM-DD>"   # owner 填观察起点（S7 不可逆点，参数化传入防 S7 前 memory 行污染）
   ssh "$MIVO_PROD_HOST" "psql \"\$DATABASE_URL\" -tA -v OBS_START=\"$OBS_START\" -f -" <<'SQL' | grep -qx GREEN   # rc=0 绿，rc=1 红
   SELECT CASE WHEN count(*) >= 10
                AND max(observed_at) - min(observed_at) >= interval '30 days'
                AND bool_and(backend = 'pg')
                AND max(observed_at) >= now() - interval '4 days'
               THEN 'GREEN' ELSE 'RED' END
   FROM persist_observations
   WHERE observed_at >= :'OBS_START'::timestamptz;
   SQL
   ```
   样例（fixture dry-run PG16）：正例 S7 后 11 点全 pg / 跨度≥30 天 / 最新样本≤4 天 → `GREEN`；S7 前含 memory 行（被 `WHERE` 过滤）不影响判绿（旧版全表扫描会因 `bool_and(backend='pg')` 永久假红）；S7 后任一 memory 行 / 9 点 / 跨度<30 天 / 最新样本>4 天陈旧 分别 `RED`。
   `WHERE observed_at >= OBS_START` 把 S7 不可逆点前的 memory 采样行排除——表是删轨前硬前置且当前默认 memory（§2.3①），S7 前合法 `backend='memory'` 行会让旧版 `bool_and(backend='pg')` 永久假红（D4-R5-2）。`max(observed_at) >= now()-interval '4 days'` 断言采样 job 仍在跑（每 3 天周期 + 1 天容差），防 cron 停采后拿陈旧 10 点/31 天数据假装观测中。`OBS_START` 经 `psql -v` 参数化、`:'OBS_START'::timestamptz` 引用（`$OBS_START` 本地展开、`$DATABASE_URL` 远端展开，`<<'SQL'` 引用 heredoc 让 psql 而非 shell 做变量替换）；`$MIVO_PROD_HOST` 为部署目标机（`/AIGC_Group/mivo-canvas/deploy.sh` 所在 host，owner 填）。

2. **生产 PG 累计行数单调非递减（观察窗内，无"重启清空"假象；r5 改 D4-R5-2：S7 前不污染）**
   ```bash
   OBS_START="<cutover S7 日 YYYY-MM-DD>"   # owner 填观察起点（与指标 1 同 S7）
   ssh "$MIVO_PROD_HOST" "psql \"\$DATABASE_URL\" -tA -v OBS_START=\"$OBS_START\" -f -" <<'SQL' | grep -qx GREEN   # rc=0 绿，rc=1 红
   WITH o AS (
     SELECT canvas_rows, chat_rows,
            lag(canvas_rows) OVER (ORDER BY observed_at) AS prev_canvas,
            lag(chat_rows)   OVER (ORDER BY observed_at) AS prev_chat
       FROM persist_observations
       WHERE observed_at >= :'OBS_START'::timestamptz
   )
   SELECT CASE WHEN bool_and(canvas_rows >= prev_canvas OR prev_canvas IS NULL)
                AND bool_and(chat_rows >= prev_chat OR prev_chat IS NULL)
                AND max(canvas_rows) + max(chat_rows) > 0
               THEN 'GREEN' ELSE 'RED' END
   FROM o;
   SQL
   ```
   样例（fixture dry-run PG16）：正例 S7 后 canvas/chat 单调非递减 + `max>0` → `GREEN`；canvas 12→9 下降 → `RED`；canvas/chat 全 0 单调（无业务数据）→ `RED`（`max>0` 防 0 行假绿，保留 r3 "读写命中>0" 语义）；S7 前 memory 高计数 + S7 后 pg 低计数（memory→pg 切换不是真下降）→ 旧版全表 `lag()` 假红，新版 `WHERE` 仅算 S7 后 pg 段判绿（D4-R5-2）。
   `lag()` 在 `WHERE observed_at >= OBS_START` 之后计算（窗口函数在 WHERE 之后求值），首行 `prev_*` 为 NULL 由 `OR prev_* IS NULL` 兼容；验累计无下降取代 r3 `created_at` 每日新增（每日新增非历史累计采样，检不出重启切回 memory 或累计下降，R3-2）。

3. **PG 连接池稳定（30 天 0 次 `ECONNRESET`/pool exhaust/idle timeout）**（扫持久日志，**非** `--lines 1000`）
   ```bash
   ssh "$MIVO_PROD_HOST" 'cat ~/.pm2/logs/mivo-canvas-error.log ~/.pm2/logs/mivo-canvas-error.log.* 2>/dev/null | grep -ciE "ECONNRESET|pool.*exhaust|idle.*timeout" | { read n; [ "${n:-0}" -eq 0 ]; }'
   ```
   样例：0 命中 → rc=0 绿；≥1 命中 → rc=1 红（r5 修剩余风险：原 `grep -ciE` 在 0 命中时 rc=1、有命中时 rc=0，rc 与健康度反相不能直接作 shell gate；改 `| { read n; [ "${n:-0}" -eq 0 ]; }` 捕获 count 显式断言 `==0`，rc 与门控语义一致）。dry-run sample log：含 `ECONNRESET`+`pool exhausted`+`idle timeout` 各 1（count=3）→ rc=1 红；全 clean / 空文件 → rc=0 绿。
   `maxConnections=10`（`pgConfig.ts:57-58`）；r2 原命令 `pm2 logs --lines 1000` 只取近若干小时，**证不了 30 天**，r3 改扫全部保留的 error log 文件（前置表 logrotate ≥30 天保证覆盖）。

4. **backup+restore drill 窗口内 ≥ 1 次成功（业务行 + asset 可恢复）**——persist **不复用** kernel C-switch event（persist 无 C-switch PR；kernel event 核心身份字段 `cSwitchPrNumber` 对 persist 无意义，r5 改 D4-R5-7）。persist 单独定义 machine-readable 事件 `docs/decisions/persist-cutover-event.json` + 独立 closeout PR 合入 main 的 drill 报告 JSON。P0.2 drill 已验业务行 + asset 可恢复；此 event/schema/guard 把它机器可核验化。

   **persist event schema**（`docs/decisions/persist-cutover-event.json`，D PR 开工时落盘，只存可人工填且可经 API 核验的字段）：

   | 字段 | 值 | 核验依据 |
   |---|---|---|
   | `schemaVersion` | event schema 版本（当前 `1`） | guard 按版本校验字段齐全 |
   | `cutoverPrNumber` | 把 `pgConfig.ts:40` 默认 `memory`→`pg` 的 cutover PR 号（S7 不可逆点 = 该 PR 合并日） | `gh api repos/xindong/mivo-canvas/pulls/<n>` → `.merged==true`（PR 号可人工填但真伪由 API 判；**不命名 `cSwitchPrNumber`——persist 无 C-switch**） |
   | `drillReportPath` | backup+restore drill 报告仓库内相对路径（独立 closeout PR 已落 main） | `gh api repos/.../contents/<path>` 存在 + 报告符下 schema |

   > **event 不含 `cSwitchHeadSha` / `cSwitchMergedAt` / `cSwitchPrNumber`**：这些是 kernel C-switch 专用字段；persist 的 S7/cutover 身份由 `cutoverPrNumber` 经 GitHub API 派生 `.merged_at`（= S7），merge SHA / 合并时间**全由 guard 经 API 读，不入 event**（同 kernel R3-1 原则，防预填可伪造事实）。
   >
   > guard 用 `jq -e` 校验 event 只含三允许字段（含 `cSwitchPrNumber` / `cSwitchHeadSha` / `cSwitchMergedAt` 任一必红）：

   ```bash
   jq -e '(keys|sort) == ["cutoverPrNumber","drillReportPath","schemaVersion"]' <persist-cutover-event.json>
   ```

   **persist drill report JSON schema**（`docs/reports/persist-backup-restore-drill-<date>.json`，独立 closeout PR 合入 main）：

   ```json
   {
     "schemaVersion": 1,
     "executedAt": "2026-07-10T08:00:00Z",
     "executor": "<github-handle>",
     "roundtripVerdict": "pass",
     "checks": {
       "businessRowsRestored": true,
       "assetRowsRestored": true,
       "permissionsRestored": true,
       "rowCountMatch": true
     }
   }
   ```

   guard 用 `jq -e` 逐字段断言 boolean 类型 + 顶层/`checks` 双 exact-key + `executedAt` 可解析 RFC3339（r6 修 D4-R6-3：原 guard 只 truthy 组合——四项 `checks` 改字符串 `"yes"` / 数字 `1` / `null` 全 truthy 假绿，文案承诺"类型错必红"却不兑现；现逐项 `type=="boolean" and .==true`，双 exact-key 拒额外/缺字段，`fromdateiso8601` 拒非法时间——任一缺字段 / 类型错 / 额外 key / `verdict≠pass` / 非法时间 必红）：

   ```bash
   jq -e '
     (keys|sort) == ["checks","executedAt","executor","roundtripVerdict","schemaVersion"]
     and (.checks|type) == "object"
     and (.checks|keys|sort) == ["assetRowsRestored","businessRowsRestored","permissionsRestored","rowCountMatch"]
     and .schemaVersion == 1
     and (.executedAt|type) == "string"
     and (.executedAt | (try fromdateiso8601 catch null) | type == "number")
     and (.executor|type) == "string"
     and .roundtripVerdict == "pass"
     and (.checks.businessRowsRestored|type) == "boolean" and .checks.businessRowsRestored == true
     and (.checks.assetRowsRestored|type) == "boolean" and .checks.assetRowsRestored == true
     and (.checks.permissionsRestored|type) == "boolean" and .checks.permissionsRestored == true
     and (.checks.rowCountMatch|type) == "boolean" and .checks.rowCountMatch == true
   ' <persist-drill-report.json>
   ```

   D PR 的 `scripts/ci/structure-guard.mjs` 加 persist 段机械检查（每条对应一外部事实，所有 post-merge 事实从 GitHub API 派生，不信 event 内填的 SHA/日期/计数）：

   1. `gh api repos/xindong/mivo-canvas/pulls/<cutoverPrNumber>` → `.merged==true`（**伪造 PR 号 / 未合并必红**）；从同一响应读 `.merged_at` = S7 不可逆点（**不与 event 内字段比对——event 不存日期**）；
   2. 从上步 `.merged_at` 算距 D PR 开工日 ≥ 30 天（**伪造日期必红——日期来自 API 非人工填**）；
   3. `gh api repos/xindong/mivo-canvas/contents/<drillReportPath>` 存在 + 内容符上 JSON schema（顶层与 `checks` 双 exact-key / `schemaVersion==1` / `roundtripVerdict=="pass"` / `executedAt` 为可解析 RFC3339 / `executor` 字符串 / 四项 `checks` 全 `type=="boolean" and .==true`，r6 修 D4-R6-3 防 truthy 假绿）（**缺报告 / 不符 schema / 类型错 / 额外或缺字段 / 非法时间 必红**）；报告由独立 closeout PR 落 main，D PR 改不动它；
   4. drill `executedAt` ≥ cutover `merged_at` 且 ≤ D PR 开工日（**窗口外 drill 必红——drill 须在 S7 后观察窗内执行**）。

   任一不满足 → structure-guard 红 → D PR 挡合并。

5. **数据丢失事故 = 0（观察窗内）**（事故登记源为硬前置，见上前置表；r4 改 R3-5：加 created 时间窗）
   ```bash
   # 硬前置：data-loss label 存在（见上前置表），缺则 --label 静默返空假绿
   OBS_START="<cutover S7 日 YYYY-MM-DD>"   # owner 填观察起点
   DL=$(gh issue list -R xindong/mivo-canvas --state all --label data-loss --search "created:>=$OBS_START" --json number | jq 'length')
   echo "data-loss issues: $DL"
   [ "$DL" -eq 0 ]   # GitHub 半：窗口内 data-loss issue=0 → rc=0 绿，rc=1 红
   # 人工登记半：incident-log.md 事故段须带日期 `## YYYY-MM-DD <描述>`（机器可解析 schema），只计窗口内事故
   test ! -s docs/reports/incident-log.md \
     || awk -v start="$OBS_START" '
          /^## [0-9]{4}-[0-9]{2}-[0-9]{2}/ { if (substr($0, 4, 10) >= start) found = 1 }
          END { exit found }
        ' docs/reports/incident-log.md   # 窗口内任一事故 → rc=1 红；窗口外旧事故不计；空文件（前置已 test -f）rc=0 绿
   ```
   样例（green）：`data-loss issues: 0`（rc=0）。GitHub 半已按 `created:>=$OBS_START` 过滤窗口（r4）；人工登记半 r5 改 D4-R5-3：原 `! grep -q '^## '` 把窗口外任意二级标题都判红（窗口外旧事故永久阻断删轨，与同一指标 GitHub 半口径冲突），现要求事故段标题带日期 `## YYYY-MM-DD <描述>` schema，`awk` 抽 `substr($0,4,10)` 与 `OBS_START` 字符串比较（ISO 日期字典序即时间序）只计窗口内事故。dry-run：空文件 / 仅窗口外事故 / 仅无日期标题 → GREEN；窗口内任一事故（open 或 closed）→ RED。`data-loss` label 当前不存在，硬前置先建。

6. **`backend.contract.dual` 连续绿（pg-suite required，双后端契约守 memory 兼容直到 D PR 删 memory 半）**
   ```bash
   TARGET='pg suite (PG16)'
   gh pr list -R xindong/mivo-canvas --state merged --limit 25 --json number,mergedAt \
     --jq "sort_by(.mergedAt)[-20:] | reverse | .[].number" \
     | while read pr; do
         gh pr checks "$pr" -R xindong/mivo-canvas --json name,state \
           --jq "[.[] | select(.name==\"$TARGET\") | .state][0] // \"MISSING\""
       done | awk 'BEGIN{tot=0;fail=0} {tot++; if($0!="SUCCESS") fail++} END{print "total:",tot,"failures:",fail; exit !(tot==20 && fail==0)}'
   ```
   样例（dry-run 2026-07-12 真实数据）：`total: 20 failures: 4`（rc=1 红，反映当前未达）——pg-suite 2026-07-11（#210）才翻 required，最近 20 merged 含翻 required 前的 PR 故 4 failures（**命令正确反映当前未达**）。删轨门槛：翻 required 后连续 20 PR 全绿 → `total: 20 failures: 0`（rc=0），当前未达（符合 persist 删轨最晚预期）。

#### ③ 删除 PR 范围清单
**前置硬约束**：删 memory backend 的 PR 不得早于 cutover S7 + 30 天 + backup drill 通过。

| 类别 | 路径 | 动作 |
|---|---|---|
| 内存后端类 | `server/persist/backend.ts:281-1219`（InMemoryPersistBackend 整类） | 删除（保留 `PersistBackend` interface `:106-251`） |
| 工厂默认 | `server/persist/backend.ts:1221-1225` | `createPersistBackend` 直接返 `PgPersistBackend`（或删工厂，app.ts 直接 new） |
| 后端选择开关 | `server/persist/pgConfig.ts:11,40-41` | `PersistBackendKind` 去 `'memory'`；`resolvePersistBackendConfig` 只返 pg |
| `MIVO_PERSIST_BACKEND` env | env 配置 + `.env.example` | 删（pg-only，无切换） |
| 双后端契约测试 | `server/persist/backend.contract.dual.test.ts`、`server/persist/permissionBackend.contract.dual.test.ts` | 改 PG-only contract（去 memory 半）；或并入 `backend.pg.test.ts` |
| persist route dual smoke（r3 漏列补） | `server/routes/persist.route.dual.test.ts:15,22`（route 级 PG persist swap 等价 smoke；`:15` import `InMemoryPermissionBackend`、`:22` `new InMemoryPermissionBackend()` 作 permission 半。pg-suite 四 PG-gated 文件之一，见 §1.4；ci.yml `:410-411` 注释 + `MIVO_PG_TEST=1` gate） | 迁 PG-only：当 `server/lib/permissions.ts` 的 `InMemoryPermissionBackend` 随上行（见下"内存权限后端类"行）删除时，本文件 import 断 → pg-suite 编译失败。**同 PR 改**：`InMemoryPermissionBackend` → `PgPermissionBackend`（或注入 mock permission，保留 PG persist swap 等价 smoke 语义——本测钉的是 persist swap 而非权限逻辑，`:20` 注释明写"permission backend 用内存即可"）。照 persist ③ 清单删 memory 而不迁此文件 = pg-suite 挂 |
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
| **renderer** | 默认已切 leafer（#131, 2026-07-06） | telemetry 上线 + label(renderer/leafer) 创建 + **5 硬门控全绿**（dom 请求=0 / pixi 工装外=0 / e2e both 连续绿 ≥20 / visual-diff 连续 PASS ≥20 / leafer P0P1 bug=0）+ bench dragP95 监控项趋势稳（非门控，见 §2.1②） | 30 天（telemetry 上线日起算，不倒算日历日） | telemetry 上线 + 30 天 + 5 硬门控全绿 | `?renderer=dom`（无状态 flag，切回不丢数据） | 删轨 PR 合并日 | 渲染层 maintainer（待指派） |
| **kernel** | 阶段 B（new 接活，默认 legacy），C/D 未走完 | C 入场：FX-6 + T1.2a + B shadow 全绿 + 一次性 legacy→new checkpoint（§4.2）+ C 契约测试（§4.7 场景 2-4）+ new-only 可重建 + e2e new 连续绿 ≥20 + CI 矩阵改 both；C 后 **4 硬门控**：shadow mismatch warn=0 + rollback drill 通过 + e2e both 连续绿 ≥20 + kernel P0P1 bug=0（kernel 身份=监控项） | C 后 30 天 | C-switch 合并 + 30 天 + drill 通过（machine-readable 事件 `kernel-c-switch-event.json` 校验，R3-P2-4） | `?kernel=legacy`（ckpt 保险，契约 §4.3） | D PR 合并日 | 内核迁移 maintainer（待指派） |
| **persist** | 默认 memory，PG opt-in，pg-suite 已 required | cutover S1-S7 + Gate2 + P0.1/0.2/0.3 + pg-suite 连续绿 ≥20；S7 后 **6 硬门控**：PG 身份=pg + PG 累计行数单调（persist_observations 审计时序源，r4）+ 连接池 30 天 0 异常 + backup drill + 数据丢失=0 + backend.contract.dual 连续绿（**事故登记源 label+incident-log 硬前置**，非"gap 待补"） | S7 后 30 天 | cutover S7 + 30 天 + backup drill（machine-readable 事件 `persist-cutover-event.json` 校验，r5 改 D4-R5-7） | S7 前=cutover S1-S6 回退动作；S7 后=PG backup restore（memory 非回滚通道，§0/§2.3④） | 删 memory PR 合并日 | persist/后端 maintainer（待指派） |

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
| kernel 跳阶段（C 未完成开 D） | split-brain、用户数据丢失 | D PR machine-readable 事件 `kernel-c-switch-event.json` + structure-guard 走 GitHub API 校验 5 条外部事实（PR merged + API 派生 SHA / mergedAt≥30 天 / drill 报告符 schema / check-runs 连续 ≥20 / `kernelMode.ts` 不含 `'legacy'`）；自保护如实归 base-side（审查纪律 + 可选外部 App check / org required workflow + org ruleset；r4 改 R3-8：schedule pinned-tag workflow 不能卡候选 PR，已撤），非"历史断言自保护"（§2.2③） |
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
