# bug-doctor loop 建设执行计划

## Context(为什么做)

mivo 生产 debug log(FX-7 加固过的上报链,现有几十条/天真实错误)只进不出:没人消费、没聚类、没游标,错误安静过完 7 天保留期被删。React 层(70k 行/24 循环依赖)零健康监控。本计划落地一套三层自动化系统(bug-doctor loop):脚本发现 → agent 修复 → 人握否决权,每日自动修 bug、提 PR、白名单内自动合并,附状态看板。

**设计已全部定稿,本计划只管"怎么建"**:
- 契约(Goal/S级SLA/T级权限/SOP/模型路由):`docs/loops/bug-doctor.md`
- 任务与 SC:`docs/plan/bug-doctor-tasks.md`
- 预检决策记录(Q1-Q7):`docs/plan/bug-doctor-unknowns-map.md`

关键已锁决策:24h Mac + launchd + maker 定时会话(A 路线)|T1 自动合并第一天开(白名单最严)|issue 直提组织仓 `[bug-doctor]` 前缀|成本不设顶记账两周|S0 六项核心流程(画布/项目/生成/持久化/资产/聊天)|通知全走 MivoCanvas 飞书群。

## Review 对齐

- REVIEW_DOMAIN: automation/tooling
- REVIEW_FOCUS: 数据管道正确性、幂等性、生产只读安全
- PLAN_SOURCE: approved_plan(本文件)

## 后悔成本排序(最难逆转的先人审)

1. **state.json schema**(台账/游标/簇状态机)——后续所有组件依赖,改 schema = 迁移台账 → 本计划定稿 v1 schema(见 Phase 1)
2. **指纹规整算法**——决定聚类质量与台账连续性,换算法 = 台账指纹全体失效 → 算法带版本号 `fpv:1`,升版时台账按新旧指纹双写一轮过渡
3. **T2 的 appVersion 注入方式**——进生产构建链 → 最小 diff,vite define 单点注入
4. 其余(看板样式、卡片模板、launchd 参数)均可随时改,交给执行 agent 自主处理

## 执行阶段(依赖序)

### Phase 0 · 前置事实(Explore 已回填,执行 agent 必读)

| 事实 | 位置 | 对执行的影响 |
|------|------|-------------|
| appVersion 已读 `import.meta.env.VITE_MIVO_VERSION \|\| '0.0.0'` | `src/store/remoteDebugReporter.ts:177,217` | **T2 无需改 reporter**;只在 vite.config 加 define 注入 |
| vite.config 无 define 先例、无 vite-env.d.ts(types 走 tsconfig.app.json:7 `vite/client`) | vite.config.ts | T2 新增 define 为首例,diff 限单文件 |
| 脚本约定:`scripts/**/*.mjs` 零依赖(Node 内置 + git/gh CLI),单测 `*.test.mjs` 同目录,vitest 收 | `scripts/codemap.test.mjs` 先例 | gate 按同款;执行前确认 vitest include 覆盖 scripts/loops/ |
| **结构先例:`scripts/changelog/auto-changelog.mjs`**(scan→rewrite→publish 三段、runGit/runGh 子进程封装、黑名单扫描、+08:00 归天) | scripts/changelog/ | gate 直接照此模式写;loops/ 与 changelog/ 平级 |
| e2e 端口隔离**已内建**:`MIVO_E2E_PORT`(默认 5174,BFF=+1)、`MIVO_E2E_PORT_BASE` 分段(SEGMENT_SIZE=50,`base+index*10+attempt`) | scripts/e2e-smoke.mjs:31、e2e/harness.mjs:267,411-429 | 并行 worktree e2e 冲突这一未知项**已消除**,worker 按 index 分段即可 |
| `npm run preflight` = tsc+lint+verify:logging+structure-guard+unit+shell 一条命令 | package.json | 修复 worker 本地验证统一跑它,与云端 CI 项对齐 |

### Phase 1 · P0 三条并行(Orca 派工,routing: execute=glm-5.2 max)

**T1 · gate 脚本 + 状态骨架**(worker A)
- 新文件:`scripts/loops/bug-doctor/gate.mjs` + `lib/fingerprint.mjs` + `lib/state.mjs`(+ 同目录 `*.test.mjs` 单测);**结构照抄 `scripts/changelog/auto-changelog.mjs` 的零依赖模式**(Node 内置 fetch/execFileSync + git/gh/ssh CLI)
- 状态目录 `history/loops/bug-doctor/`:state.json v1 schema:
  ```json
  {
    "schemaVersion": 1, "fingerprintVersion": 1,
    "cursor": "<receivedAt ISO>",
    "clusters": { "<fp>": { "source":"", "pattern":"", "sLevel":"S1", "tCap":"T2",
      "count":0, "clients":[], "firstSeen":"", "lastSeen":"", "appVersions":[],
      "status":"new|queued|fixing|pending-review|fixed|issue-filed|known-noise",
      "attempts":0, "issue":null, "pr":null } },
    "openPRs": [], "runCount": 0, "consecutiveGateFailures": 0
  }
  ```
- 指纹:`source + '::' + normalize(message)`(剥 UUID/hex≥8/数字串/引号路径/URL query;保留错误语义词),函数纯、有单测
- 数据源四路:SSH cat JSONL(增量按 receivedAt>cursor)、react 基线 diff(T3 产物接入)、`gh run list --workflow=nightly-e2e -L1`、`npm run verify:logging` 退出码
- 打分与 S 级判定照契约公式;`--s0-only` 模式;输出 `workpacket.json`;全程幂等(重跑同输入 → 台账不变)
- **SC(验收即证据)**:真实 41 条聚类抽查合理(Persist Boot 簇正确识别为 S1);重跑幂等 diff 为空;空增量 exit 0 + logs 一行;指纹单测≥5 例;命令审计确认生产只读

**T2 · appVersion 注入**(worker B,独立小 PR,**Explore 后大幅简化**)
- reporter 已读 `import.meta.env.VITE_MIVO_VERSION || '0.0.0'`(remoteDebugReporter.ts:177,217)→ **reporter 零改动**
- 唯一 diff:vite.config.ts 加 `define: { 'import.meta.env.VITE_MIVO_VERSION': JSON.stringify(<git short sha>-<yyyymmdd>) }`,git sha 用 execFileSync 读、失败 fallback 环境变量再 fallback 'dev'
- 不碰 package.json version、不碰服务器 deploy.sh
- **SC**:本地 build 触发 warn → POST payload appVersion=sha;`npm run preflight` 全绿;CI 全绿 PR 合并(部署后生产验证延后确认)

**T3 · react-doctor spike**(worker C,验证型,产物是结论不是代码)
- 临时 worktree 跑 `npx react-doctor@latest`,评估:可跑性/输出可解析性/误报率(抽查 10 条)/时长
- 不可用 → 降级方案落地:`eslint --plugin react-hooks --format json` + `tsc --noEmit` 错误计数,自算健康分(错误加权)
- **SC**:选型结论回写 unknowns-map;生成 `history/loops/bug-doctor/react-baseline.json`;重复扫描结果稳定

### Phase 2 · P1 五条(T4/T5/T-Dash 可并行;T6 之后 T7 收口)

**T4 · 飞书群通道**:飞书搜"MivoCanvas"群取 chat_id 存 state(多命中问用户);三类卡片模板(告警/待审/战报)遵守卡片排版规范。SC:三卡实发进群肉眼验收。
**T5 · launchd 整点轻巡**:plist 每小时 `gate --s0-only`;S0→飞书;连败 3 次→"loop 失明"告警。SC:注入伪 S0 → 整点告警;正常零消息;重启自恢复。
**T-Dash · 看板**:`scripts/loops/dashboard/render.mjs` 读 state/ledger/logs/基线 + gh → 自包含 HTML(内联 SVG)→ `history/loops/bug-doctor/dashboard/`;launchd 静态服务 8787。SC:三区齐全;gh 失败降级不白屏;六流程灯红绿翻转用真实簇验证。
**T6 · maker 定时会话注册**:02:30 主轮 + 13:00 补轮,prompt 指向契约;**内含关键实测:定时会话内 Orca/lizi_ssh/飞书 MCP 可用性**。SC:次日实际触发;静默日秒退有日志;三通道全通(不通→回预检重设计,不硬上)。
**T7 · 首轮实弹演习**:SOP 固化为操作手册;拿真实簇 `Persist Boot hydrate 500`(server 禁区→预期 T2)走全流程:分诊→复现(先红后绿)→修复→sol 审→PR+证据→飞书待审通知,**不自动合**。SC 七项见任务文档——演习验证的是"刹车"(禁区识别/T2 降级/留人审),不是油门。

### Phase 3 · P2 收尾

**T8 · 入库 PR**:契约 + gate/dashboard 脚本 + 计划文档一并走 PR(`[bug-doctor]` 说明),Greptile 线程回复后 resolve。SC:CI 绿合并。
**T9 · 进化轮**:runCount≥5 触发提醒,首次人工发起;输入契约+台账+logs,产出 known-noise/契约修订/两周成本定价。只改 loop 不改产品。

## 边界(执行 agent 禁越)

- 生产服务器:**只读**(SSH cat / gh 查询),任何写/改配置需单独授权
- 不改 `server/`、`src/` 中与 T2 无关的文件;T2 diff 限 vite.config + 类型声明 + reporter 单点
- 契约/任务/预检三文档:执行中发现落差 → 记 Deviations 回报,不擅改设计
- worktree 无论成败必清理;不直接 push main;所有入库走 PR

## 验证(端到端)

1. Phase 1 完成即可跑"干跑演习":`node scripts/loops/bug-doctor/gate.mjs` 对真实生产数据出工作包,人工核对聚类与 S 级
2. Phase 2 的 T7 实弹演习 = 全链路集成测试(七项 SC)
3. 完工判据:连续 3 个自然日,loop 无人工干预完成"发现→分诊→(修复→PR)→战报"且看板/台账/账本三处一致;期间至少 1 次静默日秒退、1 次真实修复交付

## 残余风险(如实)

- ~~并行 worktree e2e 端口冲突~~ **已消除**(Explore 证实 harness 内建 MIVO_E2E_PORT_BASE 分段机制)
- T6 的定时会话 MCP 可用性是唯一可能推翻架构的未知,置于 P1 尽早实测
- T1 自动合并第一天开(用户明确接受):凌晨合并→9:00 上生产无人眼;白名单+四层验证对冲,风险不为零
- 复现率受 debug log 无 stack trace 限制,初期 T3 占比偏高属预期
