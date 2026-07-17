# bug-doctor loop 建设任务计划

> 2026-07-17 定稿。契约:`docs/loops/bug-doctor.md`;决策记录:`docs/plan/bug-doctor-unknowns-map.md`。
> 依赖链:T2 独立|T1(内含 T1a 状态骨架)→ T4/T5|T3 独立|T6 → T5/T4|T7 需 T1+T6|T8/T9 收尾。
> Review 对齐:REVIEW_DOMAIN=automation/tooling;REVIEW_FOCUS=数据管道正确性、幂等性、生产只读安全。

## P0(阻塞项,先行,三条可并行)

### T1 · gate 脚本 + 状态骨架(核心发现层)
**做法**:
- 新建 `scripts/loops/bug-doctor-gate.mjs`(node,零依赖优先);状态目录 `history/loops/bug-doctor/`(state.json/ledger.csv/logs.md,不入 git)。
- SSH 只读拉数:`ssh zhuzan@10.102.80.15 'cat /AIGC_Group/mivo-canvas/data/debug-logs/*.jsonl'`(系统 key 已通);按 `receivedAt > cursor` 增量。
- 指纹规整:message 剥离 UUID/hash/数字/URL 路径变量后取前缀,`fingerprint = source + '::' + 规整前缀`;聚类计数 distinct clientId。
- 打分公式照契约;台账 diff(已修/issue-filed/known-noise 过滤);`gh run list --workflow=nightly-e2e` 红灯检测;输出工作包 JSON(簇列表+S级+score+样例记录)。
- `--s0-only` 模式供轻巡;所有写台账操作幂等(同输入重跑不产生重复簇)。
- 借鉴 cindy 增补:`rules.json` 单一真相源(T1 白名单/禁区/六流程清单,gate 与分诊共读);互斥锁+TTL(轻巡/主轮防重入);空转指纹一致跳过+6h 心跳强制放行;issue/卡片嵌隐藏指纹标记幂等去重。
**成功验收(SC)**:
1. 对生产真实数据(现有 41 条)跑通,聚类结果人工抽查:无明显误合并/误分裂,`Persist Boot hydrate 500` 簇被正确识别且 S 级判定合理;
2. 同输入重跑两次,台账与工作包完全一致(幂等);
3. 空增量日输出空工作包、exit 0、logs.md 记一行;
4. 指纹规整函数有单测(UUID/数字/路径变量剥离各一例);
5. 全程对生产零写操作(命令审计确认只读)。

### T2 · appVersion 构建注入(独立小 PR)
**做法**:vite `define` 注入 `__APP_VERSION__ = <git short sha>-<build date>`;`remoteDebugReporter` 上报处改读该常量;不碰 package.json version。先查 reporter 现在 appVersion 取值链再动手。
**SC**:① 本地 build 后触发一条 warn,POST payload 里 appVersion = 当前 sha(非 0.0.0);② CI 6 项绿,PR 合并;③ 下次部署后生产 JSONL 新记录 appVersion 带 sha(部署后验证,可延后确认)。

### T3 · react-doctor spike(信号源②选型)
**做法**:临时 worktree 里 `npx react-doctor@latest` 跑 mivo;评估四点:能否跑通(React19+Vite+Leafer)、输出可解析性(JSON?)、误报率(抽查 10 条)、时长。不行则降级方案:eslint react-hooks 全量 + `tsc --noEmit` 错误计数,自算健康分。
**SC**:① spike 结论(采用/降级+理由)写回 unknowns-map;② 无论选哪条,生成首份 `react-baseline.json` 基线快照;③ 基线扫描可重复执行且结果稳定。

## P1(核心链路)

### T4 · Slack `#mivo-canvas` 播报通道(2026-07-17 由飞书群改道;cindy 风格六类播报)
**做法**:统一走 Slack incoming webhook(用户提供,存 `history/loops/bug-doctor/` 本地 env 不入库;脚本与会话同用,纯 HTTPS 零 MCP 依赖)。六类消息模板:①T0 告警 ②T2 待审(@Praise+PR 链接+簇证据摘要) ③每日战报(静默日一行) ④issue 建档公告(带链接,"⚠ Issue #N:标题"式) ⑤PR 合并播报(自动合标注"自动合·机械档"+证据链接;人审合致谢) ⑥告警消息串回帖闭环(S0 告警→修复→verified 同串)。交互类(@接单/按钮)= 二期 T-Intake。
**SC**:① 六类消息各实发一条进 `#mivo-canvas`,格式/链接/@提及肉眼验收;② 回帖确实落原消息串(thread 锚点);③ webhook 失效降级:本地记录+下轮战报补报,不静默丢。

### T5 · launchd 整点轻巡
**做法**:plist(macOS launchd 模板)每小时跑 `gate --s0-only`;命中 S0 → Slack `#mivo-canvas` 告警(webhook);gate 连续 3 次失败 → 自告警"loop 失明"。日志落 history/loops/bug-doctor/。
**SC**:① 手动往台账注入伪 S0 簇 → 下一个整点频道收到告警;② 正常时段零消息;③ `launchctl list` 常驻且断电重启后自恢复;④ 伪造 gate 连败 3 次 → 收到失明告警。

### T6 · maker 定时会话注册(02:30 主轮 / 13:00 补轮)
**做法**:用 maker 定时任务(scheduler)建两个计划,prompt = "读 `docs/loops/bug-doctor.md` 契约 → 跑 gate → 空则记日志结束会话;有活按 SOP 分诊派工"。**内含关键验证:定时会话里 Orca 派工、SSH 是否可用**(通知走 webhook 纯 HTTPS 已无 MCP 依赖,实测面缩为两通道)。
**SC**:① 两个计划注册成功且次日实际自动触发;② 静默日会话自动秒退且 logs.md 有记录;③ 定时会话内实测 Orca create_worker / lizi_ssh 两通道 + webhook curl 全通(任一不通 → 记录缺口并回到 unknowns-map 重新设计,不硬上)。

### T7 · 首个工作轮实弹演习(SOP 模板固化)
**做法**:把契约 SOP 2-7 步写成会话操作手册(worktree bash 模板、修复/review/e2e/merger 派工包模板、T1 checklist);然后拿现成真实簇(`Persist Boot hydrate 500`,server 路由 → 禁区 → 预期 T2)手动触发一次完整流程:分诊→复现→修复→审查→PR→Slack 待审通知(**不自动合,留人审**)。
**SC**:① 分诊正确判 T2(禁区识别生效);② 修复 worker 在隔离 worktree 完成复现测试(先红后绿);③ review worker 出具独立结论;④ PR 开出且证据齐(簇统计+测试输出);⑤ `#mivo-canvas` 收到待审通知;⑥ worktree 无论成败被清理;⑦ 台账/日志/账本三处均正确落笔。

### T-Dash · 状态看板(localhost:8787)
**做法**:node 渲染器(与 gate 同仓 `scripts/loops/dashboard/`)读 state.json/ledger.csv/logs.md/react 基线 + `gh` 查 PR/issue → 输出自包含 HTML(内联 SVG 曲线,零框架)到 `history/loops/bug-doctor/dashboard/`;launchd 常驻静态 server 8787;每个工作轮末尾重渲染。三区:①agent 状态(当前/班车/队列/成本+运行方块行含进化蓝点)②交付(PR 自动合/人审分栏、issue、top 簇)③工作仓健康(**六项核心流程状态灯**(source→流程映射,24h 错误率红黄绿)、React 健康分曲线、错误簇趋势、代码卫生指标)。看板只投影已有状态,不引入新数据源。
**SC**:① 真实台账渲染三区齐全;② gh 失败降级显示缓存+过期标注,不白屏;③ 每轮后可见更新;④ launchd 重启自恢复;⑤ 六流程灯用真实簇验证红→绿翻转(持久化簇修复前后)。

## P2(收尾)

### T8 · 契约+脚本入库 PR(含 dashboard 渲染器)
**做法**:`docs/loops/bug-doctor.md` + `scripts/loops/bug-doctor-gate.mjs` + unknowns-map/tasks 计划文档一并走 PR(带 `[bug-doctor]` 说明)。
**SC**:CI 绿、PR 合并 main、Greptile 线程按规矩回复后 resolve。

### T9 · 进化轮机制
**做法**:台账 run_count 达 5 触发提醒(先人工发起进化会话,不急自动化);进化会话输入 = 契约+台账+全部 logs,产出契约修订建议(走 PR)/known-noise/State 剪枝/成本定价(两周账本)。
**SC**:第 5-10 个工作轮内完成首次进化轮,产出至少 1 条 known-noise 沉淀或契约修订,且两周账本给出成本定价建议。

## 二期预告(本期不做,2026-07-17 用户定:@接单整体滑二期)

### T-Intake · Slack @接单(二期首项;2026-07-17 重大简化:接现成 Cindy Bot,不再自建)
**背景**:2026-07-15 XDMaker v0.0.9999 公告(Slack thread C0B3D62NPTQ/1784103300.659129,已存 `_tmp/cindy-study/slack-thread.json`):Slack Cindy Bot 已成公司通用能力,**可加入任何组织(非心动限定),由 Maker 统一提供转发服务**——即三期设想的"服务器网关"官方已建好,自建方案(飞书长连接/mivo 服务器 pm2 网关)全部作废。
**做法(二期)**:把 Cindy Bot 加入 `#mivo-canvas` → @Cindy 接单经 Maker 转发落本地 maker 会话 → 会话内嫁接 bug-doctor 分诊 SOP(报 bug→入台账为人工报告簇 S1 候诊→回帖原消息串)。
**二期预检三验证**:①工作目录别名注册对 Slack 入口的路由生效(hello 注册制,别名即白名单);②"报 bug"语义嫁接为 skill/prompt 工程;③品牌统一后重新授权(公告明示老授权可能失效)。
**一期顺带红利**:会话层发 Slack 可直接用 Cindy `slack_send_message` MCP(读写已实测可用),T4 的 webhook 仅 launchd 零 LLM 脚本层必需。

## 派工执行方式(2026-07-17 用户定)

所有任务派 worker 一律要求 **goal skill 执行**:SC 清单=goal 完工判据,worker 自驱循环到每条 SC 有通过证据才回报;lead 独立核证验收;无 SC 的任务先由 lead 补 SC 再派。

## 收尾审核流程(2026-07-17 用户定)

一期全部任务执行完成后:
1. **整体审核**:派 review worker(gpt-5.6-sol / xhigh)对一期全部交付做统审——gate 脚本+rules.json、appVersion PR、基线、播报通道、launchd/定时会话配置、演习记录,对照契约与各任务 SC 逐项核;
2. **共识门**:lead(我)与 sol 逐条对齐审核 findings——一致 → 放行;分歧 → lead 复核证据后裁决并在台账留痕;任何 P1 级 finding 必须修复后重审;
3. **合并**:共识达成后派 merger(z-ai/glm-5.2 / high,禁改代码)处理全部待合 PR(含 T8 入库 PR),按线程回复+resolve 纪律执行。

## 风险与回退
- T6 的 MCP 可用性是唯一可能推翻架构的残余未知 → 放在 P1 尽早实测,不通则回预检;
- T3 降级路径已备,不阻塞;
- 所有对生产的操作只读(SSH cat / GET),无回退需求;
- T1 自动合并第一天开,但演习轮(T7)刻意选禁区簇走 T2——首次真实 T1 自动合并发生时,战报会特别标注供你复核。
