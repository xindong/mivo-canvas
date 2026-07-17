# bug-doctor — loop 契约

> 每日自动消化生产 debug log + React 健康扫描,修 bug、提 PR、白名单内自动合并。
> 设计来源:2026-07-17 预检定稿(决策记录见 `docs/plan/bug-doctor-unknowns-map.md`)。
> 本文件是契约(稳定,改动走 PR);运行时状态与日志在 `history/loops/bug-doctor/`(不入 git,loop 每轮自更新)。

---

## Goal

mivo 生产环境的用户可见错误随时间下降,React 健康分随时间上升。每个工作轮:消化新错误簇 → 修复最高优先级的活 → 带证据交付 PR → 白名单内自动合并。

**这是 monitor 型 loop,没有终点线。零新增信号的一轮 = 成功的一轮,不是浪费。永远不要为了显得忙碌而制造改动。**

---

## 信号源(发现层,全部确定性脚本,零 LLM)

| # | 来源 | 机制 |
|---|------|------|
| 1 | 生产 debug log | SSH 只读拉 `10.102.80.15:/AIGC_Group/mivo-canvas/data/debug-logs/*.jsonl`,指纹聚类(`source` + message 规整前缀,剥离 id/时间戳/路径变量),对照台账过滤已处理项 |
| 2 | React 健康扫描 | react-doctor v0.7.8(T3 spike 已选型:强制 `--no-telemetry`,健康分用基线内置本地公式)与 `react-baseline.json` diff。**定位=趋势源**(实测误报约 3/10):分数进看板;新增 error 级进队列作 S1 候选但**必须过分诊核实**;warning 只动分数,存量归 S3 |
| 3 | nightly-e2e 云端结果 | `gh run list --workflow=nightly-e2e` 查最近结论,红灯 = S0 信号(main 回归,早于用户报错) |
| 4 | verify:logging 违规 | 现成守卫命令,违规项 = S3 补日志活 |

## 触发拓扑(Q1/Q7 定稿)

| 时刻 | 载体 | 干什么 |
|------|------|--------|
| 每小时整点 | launchd 纯脚本(**不建会话,零 LLM**) | 只查 S0 信号(六项核心流程 error 簇 / nightly 红灯 / 静默失败);命中 → 飞书群立即告警(附簇详情),等最近班车或人工点开会话 |
| 02:30 每日 | maker 定时会话(主轮) | 会话第一步跑 gate:无活 → 记一行日志秒退;有活 → 全流程 |
| 13:00 每日 | maker 定时会话(补轮) | 只消化上午新进 S0/S1,赶 17:00 部署班车 |

Gap-check 兜底:会话醒来先看距上次日志条目多久,>26h 说明漏跑,拉数窗口自动扩为 `gap + 12h`(7 天保留窗内补得回来)。gate 连续 3 天失败 → 飞书告警"loop 已失明"。

## 优先级(S 级 = 多快修)

打分公式(gate 脚本算,无模型):
`score = 级别(error=3/warn=1) × 影响面(distinct clientId,封顶10) × 流程权重(核心=3/其余=1) × 新鲜度(最新版本首见×2) × 增速(24h环比翻倍×1.5)`

**核心流程白名单(六项,Q5 定稿)**:画布打开/渲染、项目 CRUD、AI 生成工作流、持久化读写、资产加载、**聊天面板**。

| 级别 | SLA | 判定 |
|------|-----|------|
| S0 | 当轮/最近班车 | 核心流程 error 簇(24h ≥3 clientId 或 ≥5 次)/ 新部署回归 / nightly 红灯 / 静默失败信号(writeRetryQueue 耗尽、outbox 丢批) |
| S1 | ≤24h | 核心流程 error 有绕行 / 单用户可复现崩溃 / React 扫描新增 error 级 |
| S2 | ≤7 天(挂 7 天自动升 S1) | 反复 warn 簇 / 非核心 error / React warning 头部 |
| S3 | 无 SLA,队列空闲才做 | 死代码、memoization、补日志、存量健康项 |

每日预算:最多 3 并行修复 worker、5 个 PR;单簇 token/轮数硬顶,撞线降级 T3;同簇修 2 次失败强制转 issue,禁止第三次。日累计成本不设顶(Q4),每轮记账,跑满两周由进化轮定价。

## 权限(T 级 = 谁按合并键,Q3 定稿:T1 第一天即开)

### T0 · 只告警,不动手
error 突增(单小时 >50)/ persist·迁移类数据完整性信号 / 鉴权异常簇 / debug 系统自身故障。→ 飞书群立即告警,等人。

### T1 · 自动修 + 自动合并(全部条件缺一不可)
- 改动类型白名单:hook 依赖数组、memoization、死代码/纯清理 effect、补 debugLogger 调用、纯文案样式;
- ≤2 文件,且不碰禁区(见下);
- 云端 CI 全绿 + review worker APPROVE + 本地 e2e smoke 过 + 复现测试转绿;
- PR 附完整证据(簇统计/before-after);评审线程**先可见回复再 resolve**;
- 每日自动合并 ≤3 个;上一个 loop PR 未合不开新的(S0 豁免此条)。

**禁区(命中即 T 级封顶 T2,无例外)**:`src/lib/persist*`、`src/kernel/`、`server/persist/`、`shared/persist-contract.ts`、documentSlice 删除/tombstone 逻辑、迁移、鉴权、计费、asset DAM、任何行为/UX 变化、3+ 文件。

### T2 · 自动修 + PR 留人审(默认档)
行为级修复/禁区内修复/拿不准的一律 T2。agent 干完全部活(复现+修复+证据+PR),飞书群通知,**不按合并键**。

### T3 · 不修,自动提 GitHub issue(Q2 定稿)
复现失败 / 根因跨模块 / 意图不明反复 warn / 修 2 次失败 / T0 跟踪票。组织仓 issue,标题 `[bug-doctor]` 前缀 + `bug-doctor` label,按指纹去重(同簇一张票,复发追加评论)。

## SOP(每个工作轮)

1. **Gate**(确定性脚本):拉四路信号 → 聚类打分 → 对照台账 → 产出工作包 JSON;空 → 记日志退出。
2. **分诊**(主会话,不改码):逐簇对照代码核实"真 bug 还是预期降级路径" → 定 S/T 级 → T0 告警、T3 提 issue → 按队列挑活(S0 全清,S1 按分,预算内带 S2)。
3. **修复**(执行 worker,隔离 worktree off origin/main,worktree 建在 loop 目录与主 checkout 之外):**先复现**(写失败测试),复现不出降 T3;再最小修复。
4. **验证**:worker 自跑 build/lint/test:unit/verify:logging/test:shell + 复现测试转绿;e2e worker 跑本地双进程 smoke(local persist 模式;server 模式受 PG 限制,如实标注)。
5. **审查**:review worker 独立审 diff;任何 finding → 取消 T1 资格降 T2。
6. **交付**:开 PR(证据齐全);T1 达标 → merger worker squash 合并(回复并 resolve 评审线程);否则飞书通知留人审。
6.5 **合并后兜底**(借鉴 cindy typecheck-merged):T1 自动合并后立即在本地 main 跑 `npm run preflight`,红 → 自动开 revert PR + 飞书 T0 告警——防两个绿 PR 语义冲突。
7. **收尾**:无论成败 `worktree remove --force`;更新 State(游标/台账/PR)、Logs 追加一行(含成本);战报发 MivoCanvas 飞书群(静默日一行摘要)。

**并发与防失控**(借鉴 cindy review-pr 实测机制):
- **文件重叠守卫**:分诊派工前求各簇疑似文件集交集,重叠簇不并行(串行或只派一个),防 3 个修复 worker 互踩;
- **互斥锁 + TTL**:gate/主轮/补轮共用一把锁(state 内,TTL 60min),防轻巡与主轮并发重入;
- **空转指纹 + 心跳**:连续轮次工作包指纹一致 → 静默跳过;但 ≥6h 必放行一轮(防永久自锁);
- **幂等标记**:issue/PR/飞书卡片均嵌隐藏指纹标记,重复触发不重复建档;
- **fail-open 方向性**:每个环节写明"哪个方向的失败是安全的"——gate 失败宁可多告警不静默;审查不确定宁可降 T2 不放行。

**机器可读规则源**:T1 白名单/禁区/S0 核心流程清单以 `scripts/loops/bug-doctor/rules.json` 为单一真相源(gate 打分与分诊共读,防契约文字与执行漂移);本契约文字与 JSON 不一致时,以 JSON 为准并回修契约。

## 模型路由(沿用 orca routing 现值,换模型改 routing.json 即生效)

| 角色 | 模型 | 说明 |
|------|------|------|
| gate/打分/聚类 | 无模型 | 纯脚本 |
| 分诊/编排(主会话) | Claude | 不改码,只判断派活 |
| 修复 worker ×≤3 | z-ai/glm-5.2 · max | 隔离 worktree |
| 审查 worker | gpt-5.6-sol · xhigh | 独立审 diff |
| e2e worker | gpt-5.4 · high | 本地双进程 smoke |
| merger | glm-5.2 · high | 禁改代码,只按键 |

## 进化轮

每 5–10 个工作轮触发一次专门进化会话:输入 = 本契约 + 台账 + 全部 Logs;产出 = 契约修订建议(走 PR)、known-noise 沉淀、State 剪枝、把重复分诊规则固化进 gate 脚本、成本定价(两周记账后)。**进化轮只改 loop,不改产品。**

## 通知与播报(2026-07-17 更新:通道改 Slack `#mivo-canvas`,替代原 Q6 飞书群决策)

全部单向播报,cindy 风格,消息串作团队讨论锚点:
1. **T0 告警**(即时,整点轻巡/会话内命中即发);
2. **T2 待审提醒**(@Praise,附 PR 链接+簇证据摘要);
3. **每日战报**(主轮后;静默日一行);
4. **issue 建档公告**(T3 建档时,带链接标题,同款"⚠ Issue #N:标题");
5. **PR 合并播报**:自动合并标注"自动合(机械档)+ 证据链接";人审合并致谢@合并人;
6. **修复结果回帖**:S0/T0 告警消息串下回帖闭环(告警→修复→verified 同串可追)。
交互类(@接单/按钮批准)= 二期 T-Intake。脚本层投递用 Slack incoming webhook(待用户提供 `#mivo-canvas` 的 webhook 或 bot token,存本地 env 不入库);会话层可用已连接的 Slack 通道发送。

## 运行时文件(不入 git)

```
history/loops/bug-doctor/
├── state.json        # 游标(最后消费的 receivedAt)、台账(指纹→状态/计数/S/T/尝试次数/issue号/PR号)、open PRs
├── react-baseline.json
├── ledger.csv        # 每轮成本记账
├── logs.md           # 只增,每轮一行:日期 · 新簇数 · 修复数 · PR · 合并 · issue · 成本(零也记)
└── dashboard/        # 状态看板(每轮重渲染的自包含 HTML,launchd 静态服务 localhost:8787)
```

## 状态看板

每个工作轮末尾重渲染 `dashboard/index.html`(渲染器在仓库 `scripts/loops/dashboard/`),三区:①agent 工作状态(当前/下一班车/队列/成本 + 运行方块行,蓝点=进化轮)②交付状态(PR 自动合/人审分栏、issue、top 簇台账)③工作仓健康(六项核心流程红黄绿状态灯、React 健康分曲线、错误簇趋势、代码卫生指标)。看板只投影 State/Logs/gh 已有数据,不是第二真相源。

## 已知局限(如实)

- 凌晨 T1 自动合并 → 9:00 上生产,无人眼环节(用户 2026-07-17 明确接受;白名单+四层验证对冲,风险不为零)。
- debug log 无 stack trace/操作序列,复现率有限,初期 T3 占比会偏高。
- appVersion 当前为 "0.0.0",回归检测失明,待前置 PR 修复。
- 两信号源都看不见"没人走过的死角",本 loop 不是测试替代品。
- e2e server 模式本地受 PG 限制,验证以 local 模式为主,nightly-e2e 云端兜底。
