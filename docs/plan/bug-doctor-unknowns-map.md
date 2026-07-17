# bug-doctor loop · 未知数地图(预检产物)

> 生成:2026-07-17 预检 | 对象:mivo-bug-doctor loop(debug log 自动修复 + React 体检,S/T 双维分级 + 队列)
> 状态标记:✅已核实 ⚠️已核实-有问题 ❓待用户回答 🔍待技术验证

## 一、领土核查结论(已验证的事实)

| # | 事实 | 状态 | 对设计的影响 |
|---|------|------|-------------|
| 1 | 生产在收 debug log:近两天 41 条(25 error/16 warning),含现成 bug 信号(`Persist Boot` hydrate 500) | ✅ | 信号源成立,loop 第一天有活 |
| 2 | 量级:几十条/天 | ✅ | 聚类阈值按小样本调;小时轻巡成本≈0 |
| 3 | GET `/api/mivo/debug-logs` 支持 date/level/clientId/sessionId/q/limit(≤1000),token 走 `x-mivo-debug-token` 头,system-scoped 不被 SSO 挡 | ✅ | HTTP 拉数可行(需配 token) |
| 4 | 生产未配 `MIVO_DEBUG_VIEW_TOKEN` → 公网边界下 GET fail-closed 403 | ⚠️ | 二选一:配 token 走 HTTP / **SSH 只读拉 JSONL(已验证可用,零服务器改动,倾向此路)** |
| 5 | 生产 `appVersion` 全部为 `"0.0.0"`(构建未注入版本) | ⚠️ | **"新版本回归检测"(S0 触发②)当前失明**;前置修复:构建期注入 git sha/版本 |
| 6 | 服务器 JSONL 保留 7 天 / 512MB 配额 / 写前脱敏 | ✅ | loop 日频足够;但 loop 连续停摆 >7 天会永久丢信号 → gate 需自监控 |
| 7 | 上报链 FX-7 加固过(IDB outbox + 退避重试),浏览器侧不静默丢 | ✅ | 信号可信度高 |

## 二、盲点清单(用户可能没想到的因素)

1. **回归检测依赖版本号,而版本号现在是假的**(见 ⚠️#5)。不修它,"部署后新冒出的错误"和"存量老错误"无法区分,S0 最有价值的触发器形同虚设。
2. **debug log 没有 stack trace 和用户操作序列**——只有 source+message+pagePath。复现率不会高,初期 T3(提 issue)比例会显著大于 T1/T2(能修)。若要提高复现率,需给 remoteDebugReporter 加 stack 采集(一个独立的代码改动,需评审脱敏)。
3. **两个信号源都不覆盖"没人走过的死角"**:debug log 修"已经炸过的",React 扫描修"静态可见的";没人触发过的路径两边都看不见。这个 loop 不是测试替代品。
4. **验证深度受现实约束**:e2e 是双进程拓扑(BFF+Vite),server-mode 还依赖 PG(本地曾因此 blocked);并行 worktree 跑 e2e 会撞端口。合并线的"证据"标准必须按现实定义(build+lint+单测+local-mode e2e),不能照抄视频的"整栈沙箱录屏"。
5. **凌晨触发依赖跑 loop 的机器在线**:Mac 睡眠 = loop 断档,还叠加 7 天保留窗风险。需要 CRM loop 同款 Gap-check(醒来发现欠账就扩窗补跑)+ 连续失败自告警。❓机器在线情况待答。
6. **组织仓可见性治理**:auto PR/issue 发生在 xindong 组织仓,团队成员(yanjian 等)全可见。PR 洪水和 issue 噪声会打扰协作者;自动合并还涉及"AI 回复并 resolve Greptile 线程"被组织 ruleset 记录。需要命名前缀/label 约定与你的治理点头。❓
7. **React 扫描第一轮会挖出存量山**(视频同款:基线 0/100、309 errors)——必须先拍基线快照,日常只处理增量,存量归 S3 慢磨,否则队列第一天就爆。
8. **成本敞口**:轻巡纯脚本免费;干活日(修复轮)3 并行 worker 估 $3-10/天。你有成本敏感史(changelog $1.6/天都砍),预算上限需要你定。❓
9. ~~**react-doctor 工具本身未验证**~~ ✅ 2026-07-17 T3 spike 已验证并选型**采用**(详见第四节):可跑/JSON 可解析/三跑结果逐位一致;误报 3/10 偏高故只作健康分趋势源不逐条派活;必须 `--no-telemetry` + 本地评分公式。降级路径无需启用。

## 三、待回答问题队列(一次一问,按架构影响排序)

| # | 问题 | 影响什么 | 状态 |
|---|------|---------|------|
| Q1 | 跑 loop 的机器(这台 Mac)夜间/全天在线吗? | 触发架构成立与否(launchd vs 备选方案)、Gap-check 设计强度 | ✅**已答:24h 在线不睡眠** → launchd 方案成立,Gap-check 仅兜底(如系统更新重启) |
| Q2 | auto issue 提组织仓 GitHub(团队可见)还是先落飞书/本地台账? | 对外可见性、团队治理、issue 去重策略 | ✅**已答:GitHub Issues + `[bug-doctor]` 前缀 + 专属 label,按指纹去重**(团队可见接受) |
| Q3 | T1 自动合并:第一天就开,还是 2 周试运行全人审后再开? | 风险敞口、契约 Boundary 措辞 | ✅**已答:第一天就开**(白名单收最严;残余风险如实入契约:凌晨自动合并→9:00 上生产,无人眼环节) |
| Q4 | 干活日成本上限接受多少($/天)? | 并行 worker 数与每日预算参数 | ✅**已答:日累计不设顶,先跑两周记账,进化轮再定**(单簇轮数/token 硬顶保留兜底,防单 bug 死磕) |
| Q5 | S0"核心流程"清单确认(画布开/项目CRUD/生成/持久化/资产加载 五项对不对) | S0 判定白名单 | ✅**已答:五项 + 聊天面板 = 六项**(对话式+画布双范式,chat 挂了半个产品不可用) |
| Q6 | 飞书通知投递到哪(私信/哪个群) | 通知通道 | ⚠️**2026-07-17 晚被替代:通道改 Slack `#mivo-canvas`**(用户已建频道并出示 cindy Slack 播报样式);播报扩为六类(告警/待审/战报/issue 公告/PR 合并致谢/告警串回帖),交互类仍二期。**新增前置:用户提供该频道 incoming webhook**。红利:webhook 纯 HTTPS,T6 的"定时会话内飞书 MCP 可用性"依赖消失 |

| Q7 | 自动修复在 maker 里的会话形态(A 全 maker / B 隐形 CLI / C 混合) | 运行载体架构、Orca/飞书/SSH 通道继承 | ✅**已答:A 路线**——maker 定时会话承载;gate 做会话第一步,静默日秒退;干活日 1 主会话+下挂 worker;整点轻巡仍是 launchd 纯脚本(不建会话,S0 只飞书告警) |

> **访谈收口(2026-07-17,含 Q7 补问)**:全部已答,连续一轮无新架构级未知 → 预检通过,可进入契约起草。
> 已锁定决策:24h 在线 Mac + launchd 触发|issue 直提组织仓带 `[bug-doctor]` 前缀|**T1 自动合并第一天即开**(白名单最严格措辞)|日成本不设顶、记账两周进化轮定价|S0 核心流程六项(画布/项目CRUD/AI生成/持久化/资产/**聊天面板**)|通知全走 Slack `#mivo-canvas`(2026-07-17 晚由飞书群改道,见 Q6 行)。

## 四、待技术验证清单(我做,不问用户)

- ✅ **react-doctor 已验证,选型:采用**(T3 spike,2026-07-17,worktree @ origin/main)
  - **可跑性**:✅ `npx -y react-doctor@latest . --json --no-telemetry -y` 在 mivo(React19+Vite+Leafer)直接可跑,零配置零安装,自动识别 vite framework,扫 556 文件。
  - **输出可解析性**:✅ 一流。`--json`/`--json-out` 输出 schemaVersion=3 结构化报告(diagnostics 带 rule/severity/category/file:line/稳定 id),39 条规则覆盖 Bugs/Performance/A11y/Security/Maintainability。
  - **误报率**:抽 10 条人工判:4 条真实有价值(a11y dialog 无焦点陷阱、sessionStorage 存 token、unused-export、innerHTML sink)、3 条技术上成立但噪音(bench 脚本被扫、微优化)、**3 条硬误报**(30%):故意顺序 await 的鼠标轨迹被判可并行、定长位置列表 index-as-key、唯一一条 error 级(effect-needs-cleanup)漏识别了非同位 ref 清理(ImageMaskEditOverlay.tsx:264 有卸载清理)。→ 误报率偏高但**不用于逐条派活,只用于健康分趋势**,确定性完美(三次扫描 221 条诊断 id 集合逐位一致),趋势信号可靠。
  - **时长**:冷跑 17.7s(含 npx 下载),温跑 3.3s,内部缓存后 <2s。
  - **落地约束**:①永远带 `--no-telemetry`(官方 0-100 分走其云端 score API,内部仓不外发统计)→ score=null,健康分用本地确定性公式(权重 error=5/Security=3/Bugs=2/Perf=A11y=1/Maint=0.5,`100 - penalty/files*20`);②后续可配 exclude bench/ 降噪。
  - **基线已拍**:`history/loops/bug-doctor/react-baseline.json`(v0.7.8,健康分 91.4,1 error + 220 warning,91 文件受影响,top 规则 unused-export 37/async-await-in-loop 35/js-combine-iterations 33)。
  - 降级路径(eslint react-hooks + tsc 计数)**无需启用**,保留为 backlog 备胎。
- 🔍 appVersion 注入方案(vite define + git sha,一个小 PR)
- 🔍 SSH 拉取 gate 脚本原型(含指纹聚类,对近两天 41 条真实数据试跑聚类质量)
- 🔍 并行 worktree 的 e2e 端口隔离方案(PORT 参数化 or 串行化验证段)

## Deviations

(执行中偏差记录,当前无)
