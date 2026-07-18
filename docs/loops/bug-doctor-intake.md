# bug-doctor · Slack 接单会话指引(报bug / 状态)

> 适用对象:经 Slack `@Cindy` 派发到本仓库工作目录(mivo-canvas)的**接单会话**——不论会话由哪个模型驱动,本指引都是唯一行为契约(模型无关:只用「读文件、跑命令、回复文字」三种能力)。
> 上游契约:`docs/loops/bug-doctor.md`(loop 总契约)。台账写入/查询一律经 `scripts/loops/bug-doctor/intake.mjs`,**接单会话自己不改产品代码、不直接编辑 state.json**。
> 展示层用 **P 编号**(P0-P3),内部台账字段是 S 级(S0-S3),一一映射;对用户只说 P。

## 0. 动词路由(收到派发正文后第一步)

| 正文命中 | 动作 |
|---|---|
| 「报bug」/「报 bug」开头或明确报障意图(描述了一个产品缺陷) | 走 §1 报bug 流程 |
| 「状态」/「查状态」/「进度」单动词查询 | 走 §2 状态流程 |
| 两者都不是 | 不属于 bug-doctor 动词;按普通任务处理,本指引不适用(二期只有 报bug/状态 两个动词,不接受"帮我实现功能"类派活) |

**通用红线**:不在频道发起新消息(所有回复都是对派发消息串的回帖,即会话的正常交卷输出);不 @ 任何人;不因报单内容直接改代码——修复由 loop 班车(分诊→修复 worker)负责,接单会话只做登记与应答。

## 1. 「报bug」动词(T2-2)

### 1.1 提取字段

从派发上下文提取:

- `externalKey`:本会话绑定的消息串键,格式 `slack:<teamId>:<channelId>:<thread_ts>`(DM 为 `slack:dm:<teamId>:<userId>:<n>`)。派发上下文里能看到触发消息的频道与 thread ts;拿不到完整键时,用消息永久链接里的 `p<数字>` 还原 ts(`p1784351780602959` → `1784351780.602959`)。**同一消息串永远用同一个 key**——这是"追问不开新单"的唯一依据。
- `reporter`:发单人的 Slack user id(如 `U01D851JXL7`)。派发上下文的发件人;拿不到 id 时如实回帖"无法识别报单人身份,请联系管理员",不要猜。
- `description`:去掉「报bug」前缀与 @ 提及后的正文描述,原样保留(它参与指纹聚类,不要润色改写)。
- `screenshot`(可选):消息带图时,取附件的 Slack 永久链接(file permalink)作为字符串传入;拿不到链接就省略,并在回帖里注明"截图未能存档,已按文字描述登记"。

### 1.2 执行(一条命令)

```bash
node scripts/loops/bug-doctor/intake.mjs report \
  --external-key "<externalKey>" \
  --reporter "<slackUserId>" \
  --description "<描述原文>" \
  [--screenshot "<permalink>"]
```

读 stdout 的一行 JSON,按 `kind` 应答(§1.3)。特殊输出:

- `{"allowed":false,...}` → 白名单外:礼貌拒绝,**不重试**。回帖模板:
  > 谢谢反馈!目前 bug 报单通道在小范围试运行,你还不在报单白名单里。可以把问题转给 @朱赞 代报;开放全员报单在计划中。
- `{"status":"locked",...}` → 台账正被班车占用:等 30 秒重跑同一命令;连续 3 次仍锁,回帖"台账忙,稍后我会自动补登"并在会话内稍后重试。
- 脚本报错(exit 1):如实回帖执行失败原因,不要伪造受理号。

### 1.3 应答模板(回帖到原消息串)

`kind=created`(新工单):

> ✅ 已受理 **工单 fp#<fpShort>**(P1 候诊)
> 队列位置:第 <queuePosition> / <queueSize> 位
> 下一班车分诊后结果会回这条消息串。追问/补充直接回本串即可,不会开新单。

`kind=followup`(同串补充):

> 已补充到 **工单 fp#<fpShort>**(第 <count> 条信息)。分诊时一并核实。

`kind=merged`(与既有工单同因):

> 这个问题已有在办工单 **fp#<fpShort>**(P<级> / 队列第 <queuePosition> 位),已把你 +1 并关联本串;结果会同步回来。

`kind=duplicate`(重复提交):

> 这条已登记过(工单 fp#<fpShort>),无需重复提交。

### 1.4 纪律(与 loop 契约对齐)

- **人工报告不自动高于日志信号**:默认 P1 候诊只是"进队排队",分诊会话照常核实,复现不出同样降 T3 建档——不要向用户承诺"会修"。
- 回帖只报事实字段(受理号/队列位置/下一步),不预估修复时间。
- 描述过短无法判断(如只有"卡了")→ 先在串里追问一句最小复现信息,**拿到后再登记**;不要用空泛描述污染指纹。

## 2. 「状态」动词(T2-3)

### 2.1 执行(一条命令,只读)

```bash
node scripts/loops/bug-doctor/intake.mjs status
```

### 2.2 应答模板(数据全部来自命令输出,不要另查别处;**先看顶层 `status` 字段分支**)

`status="ok"` → 正常卡:

> **bug-doctor 状态** _(<generatedAt> 快照)_
> 队列:P0 <P0> · P1 <P1> · P2 <P2> · P3 <P3>(活跃工单 <activeTotal>)
> 进行中 loop PR:<openPRCount> 个
> React 健康分:<healthScore>(基线口径)
> 上轮班车:<lastRun.at>(<lastRun.mode>,<空转/工作包 N 簇>)

`status="degraded"` → **禁止套正常卡**(此时输出里没有队列字段,任何数字都是编造),回帖固定文案:

> 状态台账暂不可读,请稍后重试(已记录)。

- 白名单成员均可查(状态查询不设更细权限;`report` 的白名单不约束 `status`)。
- **响应要快**:收到「状态」后直接跑命令出卡,不做任何额外调查/浏览;卡片外不附加分析。速度尽力而为,不向用户承诺具体秒数。
- 字段与 `localhost:8787` 看板同源(同一套计算函数),若用户质疑数字不一致,先确认对照的是同一时刻。

## 3. 台账语义备忘(给分诊/进化轮,不是给接单会话的动作)

- 人工簇双字段(**casing 是契约,勿混写**):`source` 固定 `HumanReport`(大驼峰,参与指纹与展示);`origin` 固定 `human-report`(小写连字符,人工来源标记,gate 据此判定)。计划文里的简写"source=human-report"对应的是这里的 `origin` 字段。其余特征:`clients=human:<uid>`、`reporters[]`、`samples[].externalKey`;`state.intake.threads` 存 消息串→簇 绑定 + `seen[]` 输入摘要(幂等键)。
- gate 重打分**不覆盖**人工簇 S 级(gate.mjs 按 `origin` 判断);升降级由分诊会话直接改台账字段。**例外**:生产日志记录并入同指纹人工簇时,gate 会解除 `origin` 标记,让真实日志判据接管 S 级(silentFailure/S0 不被候诊 S1 压住)——人工报告不自动高于日志信号,反之亦然。
- 报单人白名单:`history/loops/bug-doctor/notify.env` 的 `INTAKE_ALLOWLIST`(逗号分隔 Slack user id,不入 git);扩权(T2-7)只改这一处。
- 台账位置:接单会话跑在 `.xdt-worktrees/` 隔离工作树,但 intake.mjs 默认按 git common dir 穿透到**主 checkout** 的 `history/loops/bug-doctor/` 读写——全仓只有一份台账,勿传 `--state-dir` 覆盖。
