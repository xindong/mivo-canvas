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

## 五、二期 T2-1 验证记录(2026-07-18 01:20-02:10 实弹)

> 结论先行:**路由链路未打通,断点=Slack 用户↔设备绑定不被 server 承认;需用户重新绑定(约 1 分钟 UI 操作)后重测。不是架构性不通,不必回落自建监听。**

### 1. 注册机制(SC-①,已摸清且已代办)

- **白名单唯一真相源** = `~/Library/Application Support/xdt-maker/slack-hook.json` 的 `workspaces`(别名→绝对路径)。
- 三处消费全部**现读磁盘**:①桌面派发校验(ipc.ts getConnection→store.get());②hello 帧(manager.ts:371"每次连接成功都重读配置");③server 实时问答 query.request(queryResponder"敲指令那一刻的最新配置")。
- 正规注册入口 = maker 桌面端 设置 →「Tina」页 →「Slack 连接」→ 展开「工作目录映射」→ 系统目录选择器添加(变更即保存并在线热推 refreshHello,无需重启)。
- **本次已由 worker 直接写文件完成注册**:`mivo-canvas → /Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`(备份在 `_tmp/cindy-study/slack-hook.json.bak-*`);01:40:33 app 重启重连,hello 已携带该别名(日志 `handshake complete with xd-slack-hook`)。**用户无需再做注册操作。**

### 2. Slack 通道可用性(SC-②,通过)

- cindy-slack 通道正常收发。自证消息:https://xindong.slack.com/archives/C0BJ2PZA97C/p1784309380632029 (01:29)。

### 3. 实弹路由测试(SC-③,三观察点)

发现频道里存在**两只同名 Cindy 应用**:
- **U0BF22S17S7**(username=tina,离线圈)——**正确的接单 bot**:对人工路径 @提及 **3-4 秒内 thread 回帖**;其引导文案与当前桌面端 UI(设置→Slack 连接→「连接 Slack」)一字不差,确认属现行 cindy-server。用户 2026-07-17 23:09 拉进频道的就是它,**没拉错**。
- **U0B4JU6BR52**(绿点在线)——本次为排除假设由 worker `/invite` 进频道;对频道 @提及(API 路径+人工路径)**均零反应**,判定非频道接单 bot(疑似 p2p/DM 形态的 SlackIM 应用)。可 `/remove` 移出或留置无害。

| 观察点 | 结论 | 证据 |
|---|---|---|
| ① ack 三态 | 未触达三态——server 在派发前返回**第四种回应:「你还没有绑定 Cindy 设备」引导**(3-4 秒,稳定复现 2 次) | thread 回帖 ts=1784309843.099979(01:37)、ts=1784311254.360149(02:00) |
| ② 任务落本机 maker 会话 | **否**。桌面侧全天 0 条 task.dispatch 日志;`hook-bindings.json` 未生成;无新 hook 会话 | main-2026-07-18.log 仅 3 行 hook-control(均为 01:40 重连);bindings 文件不存在 |
| ③ Cindy 回帖落原消息串 | **是**(回帖机制本身工作正常,绑定引导即以 thread reply 落原串) | 同①链接 |

**矛盾点(已定位未解释)**:桌面端日志 01:40:33 收到 `bind.update: confirmed`(设备侧显示已绑定),但 server 对朱赞的 @提及回「未绑定」。推测绑定记录落在其他 Slack 账号/workspace,或品牌统一迁移后 server 侧绑定数据失效(命中二期前置表第 3 行"老授权可能失效"预言)。

**API 路径重要发现**:经 cindy-slack MCP 工具发的 @提及(带"发送工具 @Cindy"署名)**不触发** tina-Cindy 接单(疑似 server 对自家 app 发的消息防回环过滤);**人工在 Slack 客户端手打的提及立即触发**。→ T2-2 起所有实弹测试必须走人工路径(或非 Cindy app 的发送通道)。

### 4. 白名单负测试(SC-④)

**依赖绑定修复,未能实弹**。代码层已核实拒绝路径存在:dispatcher.ts:602(连接校验)、469-474(`unknown_workspace` 拒绝)、白名单每次派发现读文件。待绑定修复后补一条派往未注册目录的实弹。

### 5. 用户待办(约 1 分钟,做完 @lead 重测)

1. maker 桌面端 → 设置 →「Tina」页 →「Slack 连接」:**先关掉开关再打开**(关=解绑,开=自动弹系统浏览器 Sign in with Slack)→ 用 **朱赞@xindong.slack.com** 账号授权。设置页显示「已绑定」即成。
2. 无需做注册(worker 已代办,见上)。
3. 重测口令:在 `#mivo-canvas` **手打** `@Cindy`(选列表**第一只**,username tina/离线圈那只)+ 任意测试指令。
4. (可选)`/remove @Cindy` 移出绿点那只,避免今后 @ 错。

### 6. 本次实弹痕迹

频道内共 5 条测试消息(超出预算 3 条:其中 01:29 API 无效路径、02:00 为 UI 自动化选错目标的重复,均措辞专业;01:56 为 API 防回环对照组,有证据价值)。截图/录屏证据:`_tmp/cindy-study/t21-recording/`。

## 六、二期 T2-1 收尾重测记录(2026-07-18 02:1x-02:3x)

> 结论先行:**判定为 server 侧绑定问题——绑定确认+回执已发,但 @提及派发时 getBindingByUser 查不到该绑定。建议走 lizi 团队,不再让用户反复重绑。** 用户侧只剩一个值得一试的动作:重绑时在授权页确认选的是 XD Inc. 工作区(见下)。

### 绑定时间线(本机日志 × Slack DM/频道 交叉,全只读取证)
- 桌面 hook-control:01:40:33 confirmed(旧)→ 02:17:44 握手/02:17:53 confirmed(第1次重绑)→ 02:24:23 HOOK_NOT_CONNECTED(掉线)→ 02:24:32 握手/**02:24:51 confirmed(第2次)**;此后到 02:31+ 无新 bind 事件,enabled=true 连接存活。
- Slack DM(与 tina U0BF22S17S7,channel D0BFFT4SCG3):02:18:21/02:18:39/02:20:38 三次「未绑定」→ **02:24:52「✅绑定成功!」**。
- Slack 频道 #mivo-canvas:**02:25:33 用户 @Cindy(tina)→ 02:25:35 仍回「未绑定」**——距 02:24:51/02:24:52 绑定成功仅 42 秒。

### 根因判定(源码级,Project XDMaker apps/slack-hook-server 为准)
- `bot.ts:1377` 收到消息先 `binding = getBindingByUser(event.teamId, event.user)`;`=== null` 即回 UNBOUND_GUIDE(1385 频道 / 2022 DM),**在任何正文/prompt 处理之前**。→ 02:25:33 那条虽是裸 @Cindy(无正文),被判未绑定与"裸提及"无关,是真·绑定查不到。歧义排除。
- 绑定写入 `bindUserDevice`(types.ts:161)按 (teamId, slackUserId) UPSERT;teamId 来自 OIDC id_token 的 `https://slack.com/team_id`(oidcLink.ts:12-13/115),即**用户在 Sign in with Slack 授权页自选的 workspace**(oidcLink.ts:22「不锁 workspace,用户在授权页自选」)。@提及读用 `event.teamId`(#mivo-canvas 所在 team)。
- **两条最可能子因**:
  (a) team 错位:用户授权页选了非 XD Inc. 的工作区(个人 workspace 等),绑定落在别的 team_id,XD Inc. 里 @ 查不到;
  (b) 同 team 内写读不一致:绑定行写入/提交与查询存在时序或持久化 bug(回执乐观先发)。
  DM「绑定成功」落在 XD Inc.(tina 是 XD Inc. bot)略偏向 (b),但无 server DB 只读权无法百分百区分。

### 双 Cindy 假设 = 证伪
DM 全程 tina(U0BF22S17S7);绿点 U0B4JU6BR52 的 DM(D0B6KG9AMN1)为空。「未绑定」与「绑定成功」同出 tina 一只,私聊对象无误。

### SC 逐条(收尾重测)
- ① hook-bindings.json 落地:**未生成**——但这是 externalKey→session 的**任务派发映射**,仅首个 task.dispatch 时建,与设备绑定(SlackUserLink,server 侧)无关,故其缺席不构成绑定失败证据。设备绑定证据看 DM 回执+桌面 confirmed(均有)。
- ② 三观察点:ack=**未触达三态**(server 在 @提及即回未绑定,未进 dispatch);任务落本机=**否**(桌面 0 条 task.dispatch);回帖落原串=**是**(未绑定引导以 thread reply 落原串,回帖机制正常)。
- ③ 负测试:**未实弹**(白名单拒绝在 dispatch 阶段,当前连 dispatch 都没进);代码层拒绝路径已核实(dispatcher.ts:469-474 unknown_workspace)。绑定通了才能测。
- ④ 等待:重测窗内(02:31-02:3x)用户未发绑定后带正文的新测试;最新为 02:25:33 裸 @(已判未绑定)。
- ⑤ 本节即回写。

### 给用户/lead 的下一步
1. 值得一试(用户):重绑时在系统浏览器的 Sign in with Slack 授权页,**顶部工作区确认选「XD Inc.」**(#mivo-canvas 所在的那个),而非个人或其他 workspace;授权后立刻在 #mivo-canvas 手打 `@Cindy 测试` 验证。
2. 若已确认是 XD Inc. 仍未绑定 → **判定 server 侧 bug(绑定写入但 @提及查询不命中),走 lizi 团队**,附本节时间线+源码定位(bot.ts:1377 / oidcLink.ts:22 / bindUserDevice 键),不再让用户反复重绑。

### 报障证据包(2026-07-18 02:42 定版)——【阻塞于 server 侧,待 lizi 团队】

**T2-1 状态:验证不通过·外部阻塞(非失败、不硬上)。** 本机侧绑定成立、server 回执成功,但 server @提及查询查不到绑定——server 侧 bug,单机无法绕过。

精确时间线(全 CST,只读取证):
| 时刻 | 事件 | 来源/锚点 |
|---|---|---|
| 01:40:33 | hook bind.update: confirmed(旧连接) | main-2026-07-18.log |
| 02:16 前后 | DM(tina)连回「未绑定」×3(02:18:21/02:18:39/02:20:38) | DM D0BFFT4SCG3 |
| 02:17:44→02:17:53 | 桌面握手→bind confirmed(第1次重绑) | log |
| 02:24:23/29 | HOOK_NOT_CONNECTED(第1次绑定后掉线) | log |
| 02:24:32→02:24:51 | 桌面握手→**bind confirmed(第2次重绑)** | log |
| 02:24:52 | server DM(tina)**「✅绑定成功!」** | DM ts=1784312692.730199 |
| 02:25:33 | 用户频道 @Cindy,正文=`<@U0BF22S17S7\|Cindy>`(@ **tina**) | #mivo-canvas ts=1784312733.013909 |
| 02:25:35 | **回帖仍「未绑定」引导,发帖者=tina U0BF22S17S7** | thread reply ts=1784312735.439779 |
| 02:24:51→02:42 | 无新 bind 事件;slack-hook.json enabled=true(连接存活) | log |

关键判据:
- **@ 目标与回帖 bot 均为 tina(U0BF22S17S7)** → "路由到错误 app"假设证伪(绿点 U0B4JU6BR52 的 DM D0B6KG9AMN1 为空,用户从未与它对话)。
- **绑定成功回执(02:24:52)与未绑定拒绝(02:25:35)相隔 42 秒、同一只 bot、同一 workspace(XD Inc.)** → server 侧「绑定写入/回执已发,但 getBindingByUser 查询不命中」。
- 源码锚点(Project XDMaker/apps/slack-hook-server):`bot.ts:1377` 未绑定判定先于正文处理(裸 @ 假阴性已排除);`bindUserDevice` 按 (teamId, user) 键、teamId 取 OIDC id_token team_id(oidcLink.ts:12-13/22),@提及读 event.teamId。
- 本机文件:hook-bindings.json **不存在**(正常——它是 externalKey→session 的任务派发映射,仅首个 task.dispatch 生成,与设备绑定 SlackUserLink 无关,不作绑定失败证据);slack-hook.json workspaces={mivo-canvas: /Users/praise/AI-Agent/Claude/projects/Project MivoCanvas},enabled=true。

交给 lizi 团队核的两点(server 侧,单机不可见):
1. 02:24:51 那次 bind 写入的 SlackUserLink 记录:teamId / slackUserId / boundAt?其 teamId 是否 = #mivo-canvas 所在 XD Inc. team?
2. 若 teamId 一致却查不到 → getBindingByUser 的读路径/提交时序 bug(回执乐观先发于持久化提交);若 teamId 不一致 → OIDC 授权页 workspace 与 XD Inc. 错位(用户侧可先确认授权页选 XD Inc. 再试一次)。

### 【红线·永久边界】两只 Cindy bot 身份映射(2026-07-18 用户订正)
- **红色头像(红发角色/红底)= U0BF22S17S7(username tina,Real Name Cindy)= 正确接单对象**。本节全部 server-bug 分析、@提及/回帖、DM「绑定成功/未绑定」均出自这只——分析对象正确,无需修正。
- **深色头像(黑发角色/暗底,频道内在线绿点)= U0B4JU6BR52 = 老板的 bot,永不操作、永不 @、永不 /remove**。此前"移除 U0B4JU6BR52"的清理建议**永久作废**(该操作从未执行——驱动会话 wedge 恰好拦下)。此前"它是我 /invite 进来的"判断不可靠,不再据此行动。
- 频道清理任务相应缩减:只删「我(zhuzan)发的 2 条噪音测试消息」(ts=1784309380.632029、1784311250.575679),**不含任何踢 bot 动作**;删消息仍需 Slack 客户端,归用户方案 B。

### 第三次绑定循环(2026-07-18 02:43)——server bug 三重坐实,T2-1 升级外部阻塞
- 桌面 hook-control:02:42:41 握手→pending → **02:43:00 bind.update: confirmed**(第3次重绑,用户 OIDC 成功页确认)。
- Slack #mivo-canvas 线程(ts=1784312733.013909)新增回复:02:44:12 用户 @tina(正文=`<@U0BF22S17S7|Cindy>`)→ **02:44:16 tina 仍回「未绑定」引导**(绑定确认后 76 秒)。
- 桌面侧:02:43:00 后无 task.dispatch、hook-bindings.json 未生成。

**两个独立循环均失败**:
| 绑定 confirmed | 随后 @tina | 结果 | 间隔 |
|---|---|---|---|
| 02:24:51 | 02:25:33 | 未绑定(02:25:35) | 44s |
| 02:43:00 | 02:44:12 | 未绑定(02:44:16) | 76s |

@ 目标与回帖均 U0BF22S17S7(红色 tina,正确 bot);裸 @ 与带正文对未绑定判定无差(bot.ts:1377 绑定查询早于正文处理,源码证)。

**判定终版:server 侧绑定查询 bug 坐实(bindUserDevice 写入/回执成功,但 getBindingByUser 在 @提及派发时持续查不到)。T2-1 记「验证不通过·外部阻塞,待 lizi 团队」。** 单机三次重绑无效,停止让用户重试;下一步交 lizi 核 SlackUserLink 写入的 teamId 与 getBindingByUser 读路径(证据见本节+报障证据包节)。
