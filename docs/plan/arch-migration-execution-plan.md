# 架构迁移执行计划(定稿 v3):现有功能 → 分层内核+四总线(CRDT-ready,为协作预留)

> 状态:v3 = v2 + 三份 gpt-5.5/xhigh 深审(review-plan-a/b/c,均 REQUIRES_CHANGES)15 条 finding 全量吸收。审查落盘:`history/plan-review/`。
> 上游真相源:`docs/decisions/platform-architecture-2026-07-07.md`、`history/arch-precheck/unknowns-map.md`、`history/conn-matrix/README.md`、issue #153(D9-D16 已表态拍板)/ PR #152。
> 本文件是执行层唯一权威任务板。

## 0. 目标与成功定义

**目标**:把 MivoCanvas 从"单机浏览器 demo"变成"数据在服务端、按账号归属、可分享、为协作预留"的平台;现有全部功能无损搬进解耦分层架构,行为/UI/交互零变化;文档内核 CRDT-ready,为紧接着的协作共享画布铺地基。

**成功定义(全绿才算)**:
1. 换电脑登录同账号,项目/画布原样在(服务端真相源)。
2. 邀请/链接按 owner/editor/viewer 生效。
3. 两人同改同画布不同节点,双方改动都留(节点级 revision)。
4. 服务器重启数据无损。
5. 迁移前后所有功能 e2e(**28 场景**,renderer both)+ visual-diff 一致(行为/UI/交互零变化)。
6. CRDT-ready:按 **T1.2a record schema 文档**逐字段核验可无损映射 Y.Map/Y.Array(不再是空泛条款)。

## 1. 分支与部署策略(不变)

短 feature 分支 → PR → main;risky 切换藏 `?kernel=new|legacy` 后默认 legacy。deploy.sh 只拉 main,长分支自断验证;main 6 项必绿 CI(实查:lint+tsc+unit+logging / structure guard / e2e prod subset / e2e token gate ×2 / secret scan)。M1 允许短期集成分支,里程碑合回。

## 2. 回归契约(数字按实测修正)

裁判 = **28 个 e2e 场景**(renderer-aware;leafer 显式 skip canvas-interactions,须在 T0.7 解决)+ **单测 101 文件 / 1249 通过 12 skip(6.6s)** + visual-diff 像素基线。基线数字以 review-plan-b 实跑为准,后续每轮以最新实跑覆盖。

覆盖与改动的错配(不变,更精确):canvasActionModel 1320 行零测试、authSlice 75 行零直接单测、canvasStore.contract 864 行强保护。**visual-diff 只覆盖画布 shell + 4 个 fixture(default/rotation/brush-stamp/markup-text),外壳 UI(侧栏 CRUD/右键菜单/chat task card/设置面板/更新日志/素材库)零像素基线**——见 T0.8。

**硬约束**:表征测试先行、迁移后一字不改;"存量不重要"只降级数据搬迁,不降级表征测试。

## 3. 前置决策(更新:部分已拍)

**已拍板(issue #153 owner 评论 2026-07-09)**:D9 PG / D10 Kysely / D11 本地FS内容寻址 / D13 docker 同机 / D16 投 C+授权 spike / D12 起步 PG 表 / D7 修正(存量降级,表征不降级)。

**DP 决策(评审后更新)**:
- **DP-1 选择态单一真相源** ✅ 已拍(T1.2a 2026-07-10):归 session、不双写(迁移前实施);**迁移窗口不冻结 selection 读写**,迁移瞬间选区清空可接受,v10 迁移后首次加载 selection 为空属预期降级行为(非 bug)。详见 docs/decisions/record-schema.md §4.1。
- **DP-2 anchorModel/annotationBounds** ✅ 已拍(T1.2a 2026-07-10):**收编**——experimentalAnchors 收编为顶层 `Anchor` record(document 域,独立 id+revision;锚点对话是产品范式核心,删除与愿景矛盾);annotationBounds 收编为 annotation 节点 formal 子字段。详见 docs/decisions/record-schema.md §4.2。
- **DP-3 删画布级联对话**:服务端定级联软删语义(并入 FX-7 语义表)。
- **DP-4 身份模型对齐**:T1.4 前确认 SSO 身份载体 == 权限层假设。
- **DP-5 节点 payload 存法 ✅ 已定(采纳 review-plan-a)**:**信封列 + payload jsonb**——只拆 `id/canvas_id/type/revision/scope/is_deleted/created_at/updated_at` 及少量索引字段,其余整存 jsonb;不全量拆列,不把 jsonb 当字段级 CRDT。
- **DP-6 chat 消息 API 归属(新)**:chat 随文档域走 `/api/canvas` 子资源(messagesByScene 键随 canvas 生命周期),独立集合存储(D6),级联语义见 FX-7。
- **DP-7 两把 key 显式不迁(新)**:gatewayKey/mivoKey 留前端 strictIdb,**永不进 /api/user-state**;服务端只承接 mivo key 懒验证。
- **DP-8 tasks 归属(新,T1.2a 2026-07-10 拍)**:迁服务端 tasks registry(FX-2 per-user)+ preset demo 任务留 demo seed;document record 无 tasks 字段。详见 docs/decisions/record-schema.md §4.3。
- **DP-9 status 字段(新,T1.2a 2026-07-10 拍)**:降级 session 派生,record 不存;派生规则:task 存在→随 task 状态,task 不存在→有 asset→ready、无 asset→failed;last-known 缓存=第二真相源 split-brain 风险。详见 docs/decisions/record-schema.md §2.1。

**待 lead 输入**:D14 mivoserver 访问 + board schema(已认领,不阻塞 P1)。

## 4. 优先级任务板(v3)

### P0 · 保护网与前置(串行链 + 可并行项,阻塞 P1)

| 任务 | 内容(v3 修订) | 验收标准 |
|---|---|---|
| T0.1 auth | ✅ 已完成(#155) | — |
| T0.2 prod 野改动清零 | 服务器未提交改动抢救成分支或显式丢弃 | 服务器 `git status` 干净 |
| T0.3 `?kernel=` 开关(**扩容**) | 不止复刻 rendererMode(那是 view 层模块常量);kernel 影响 store 初始化/persist adapter/缓存命名空间/command 出口,需先写**双轨契约文档**:import order、shadow 读/单写策略、e2e 参数透传(`--kernel=new\|legacy\|both`) | 契约文档 + 单测分流 + e2e 可按 kernel 跑;默认 legacy 生产无感 |
| T0.4 表征测试(**decision-complete 化**) | 4 个明确测试文件,各模块可并行派工:①`src/canvas/actions/canvasActionModel.characterization.test.ts`(菜单结构/enable 条件/action 分发行为快照)②`src/store/authSlice.characterization.test.ts`(login/logout/hydrate/401 markUnauthenticated)③`src/store/projectsSlice.characterization.test.ts`(侧栏 CRUD 同步返 id/deleteProject 级联回落 standalone 语义)④`src/store/chatHydration.characterization.test.ts`(hydrate/settleExpiredChatMessages 回落/messagesByScene 键语义) | 表征在当前 main 全绿;**每文件在文件头记录断言数 baseline**,迁移后断言数不减、断言内容一字不改 |
| T0.5 治理文档入 git | 架构/预检/计划/连接矩阵/审查三份 提交入仓 | git 可查 |
| T0.6 清 stale 分支 | chore/pr-hygiene rebase 到 main | 无误删 |
| **T0.7 CI 门禁落地(新,review-plan-b F1)** | PR CI 增加:e2e `--renderer=both`(解决 leafer skip canvas-interactions)、`--kernel=` gate(T0.3 落地后)、visual-diff 进 workflow 并列为 required check | 迁移 PR 无法在 legacy/dom-only 绿灯下合入 |
| **T0.8 外壳 UI 像素基线(新,review-plan-c F1)** | 给侧栏 CRUD/右键菜单/确认弹窗/chat task card/设置面板/更新日志/素材库补 visual-diff 基线(可并行派工) | 迁移触及的每块 UI 都有像素基线;基线在当前 main 生成 |

### P1 · 后端底座 + 内核收口

顺序(v3 修正):T1.1 → T1.2a → T1.2 → **FX-6(硬前置)** → T1.5 → T1.3 → T1.4。资产服务端化(T1.5)提到 T1.3 之前——否则 T1.3"跨设备原样在"验收撞上资产还在本地 IDB,验收必假绿(review-plan-b F2)。

| 任务 | 内容(v3 修订) | 验收标准 |
|---|---|---|
| T1.1 PG + 数据目录 + 备份(**升级**) | docker PG + `/AIGC_Group/mivo-canvas-data` + cron pg_dump/目录快照;**补可执行 restore drill**:恢复步骤文档、验证命令、RTO/RPO 目标、演练证据归档(review-plan-c F3) | PG 可连;**restore drill 实跑一次留证**;RTO/RPO 写进文档 |
| **T1.2a record schema 定稿(新,review-plan-a F1)** | 逐字段定义 record schema 与 CRDT 映射:MivoCanvasNode 的 transform/fills/strokes/effects/asset/relations/generation/aiWorkflow/experimentalAnchors/annotationBounds 每个嵌套结构 → Y.Map/Y.Array 映射策略;CanvasDocument 的 tasks/文档内 selection 的归属(结合 DP-1/DP-2 拍板);产出 `docs/decisions/record-schema.md` | schema 文档逐字段无遗漏;DP-1/DP-2 同步拍板;成功定义 6 以此为验收依据 |
| T1.2 M1 内核收口(**澄清**) | 拆域(document→DocKernel/session→SessionStore)+ records 扁平化 + per-record revision;**client 本地 persist v10 大版本迁移(单 blob 拆三域)保留,dry-run+回滚不变**——T1.6 的"不做迁移器"仅指历史数据批量入服务端,不含本地结构迁移(review-plan-a F4) | Doc 按 T1.2a schema 映射通过;v10 本地迁移 dry-run+回滚实测;20k pan p95 不退 26.7ms(bench 可复跑已核实) |
| FX-6 缓存 per-user 化(**提为硬前置**) | IDB/localStorage key 全局静态(`mivo-canvas-demo`/`mivo-chat-demo`/`mivo-canvas-assets`)、logout 不清缓存、账号切换不一定经 logout——缓存命名空间带 userId + logout 清理 + 非 logout 切换检测 | 默认切换前必须完成;A 登出 B 登入互不见 |
| T1.5 资产服务端化(**提前**) | AssetService:save→POST /api/assets、resolve→GET;内容寻址;assetUrlLease 复用 | 图片服务端存、节点存 assetId、跨设备可显示 |
| T1.3 4 API + PersistAdapter(**边界补全**) | syncToServer 按 scope 路由;**API 面补全(review-plan-a F5)**:chat 消息按 DP-6 入 /api/canvas 子资源;/api/user-state 定 key namespace 约定;两把 key 按 DP-7 显式排除 | 换电脑登录项目/画布/图片/对话原样在;服务器重启无损 |
| T1.4 权限层(**schema 补全**) | owner/editor/viewer + 分享链接;**补 project_members / share_links 表设计**(review-plan-a F5);依赖 DP-4 | 邀请/链接按角色生效 |
| T1.6 存量手动搬迁(**runbook 补步**) | 切换日 runbook 补齐(review-plan-b F5):①恢复/提供导出导入入口(archive import UI 已移除,需临时入口或脚本)②切换窗口冻结写入③搬迁后校验(数量/抽样比对)④回滚预案⑤stale-client 处理(旧版本页面还开着的用户) | runbook 逐步可执行;协作者确认画布搬完 |
| FX-1 同步生图补 authHeaders | mivoImageClient.ts:132/173 | 与异步 tasks 鉴权一致 |
| FX-2 tasks registry per-user | 服务端按 user 隔离 | 防越权,404 语义不变 |
| FX-3 僵尸 task card 回落 | settleExpiredChatMessages 服务端复跑 | 跨设备无卡死卡片 |
| FX-4 节点级 PATCH | 1MB/413 已源码实证(jsonRequestMaxBytes=1048576);与 revision 同设计 | 几千节点保存不 413 |
| FX-5 写失败重试队列(**细化**) | durable 队列(IDB)、按 userId 分区、队列上限+溢出策略、指数退避、幂等 key、409/413/401 分支行为、超限用户可见降级提示(review-plan-c F4) | pm2 restart 窗口写入最终落库;各错误码行为有测试 |
| FX-7 软删语义表(**细化**) | 定义完整语义:project delete vs canvas delete 级联范围、chat/assets/share_links 恢复行为、保留期、purge 与 asset refcount 回收验收(review-plan-c F5,含 DP-3) | 语义表文档化;误删可恢复;purge 有验收 |

### P2 · 解耦 + 总线

| 任务 | 内容(v3 修订) | 验收 |
|---|---|---|
| T2.1 两总线契约化 | 不变 | 契约测试进 CI required |
| T2.2 编排上移 | 不变 | 编排出口全走 command |
| T2.3 command 序列化(**方案修正**) | **新增独立 `CanvasCommand` JSON union,不直接改 canvasActionModel**(其 action 是 UI closure,含 File/Blob/AbortSignal);UI intent 层(closure 可留)与 effect 层(command,可序列化)分离;最难三件(import-asset、mask edit、generation/edit)用两阶段资产(先入库拿 id)解 Blob 问题(review-plan-a F3) | CanvasCommand 序列化往返一致;UI 层零行为变化 |
| T2.4 记忆层预留 | 不变(占位不实现) | 接缝文档化 |

### 下一批 · 协作 + 记忆(不变)

N1 Yjs↔LeaferJS spike(已授权)→ N2 实时协作 + presence → N3 AI Agent 记忆(借鉴 maker agent_memory)。

### P3 · 延后(不变)

图片完整化 / skill 总线 / 删双轨 DOM / 素材库本机源。

## 5. 顺序约束(v3)

- P0 全绿才进 P1;T0.7/T0.8 可与 T0.4 并行,但都在第一个迁移 PR 前完成。
- T1.2a schema 先于 T1.2 实施;T1.2 先于 T1.3。
- **FX-6 是默认切换(kernel/服务端 persist)的硬前置**;T1.5 先于 T1.3 验收。
- FX-4 与 revision 同设计;DP 全部在对应任务动手前拍板。

## 6. 多 Agent 编排流水线(按 owner 指令更新)

**所有环节并行派多个 worker,不设数量上限;lead 挂看门狗防卡死。**

| 阶段 | 谁 | 模型/effort | 动作 |
|---|---|---|---|
| 计划评审 | 多 reviewer 并行(禁止只读,实跑验假设) | gpt-5.5/xhigh | ✅ 本轮已完成(a/b/c 三份,15 finding 全吸收为 v3) |
| 修订确认 | 原 reviewer 并行复核 v3 | gpt-5.5/xhigh | 确认 finding 已解,出 APPROVE |
| 执行 | 每 lane 一 worker、独立分支,可并行任意多 lane(同文件才串行) | glm-5.2/max | 实现 PR 切片 |
| 实现双审 | lead 读 diff + 多 reviewer 并行 | Fable + gpt-5.5/xhigh | 每 PR 合前双通过 |
| e2e | 独立 worker 按 PR 并行 | gpt-5.4/high | `--renderer=both`+`--kernel=`+visual-diff,附 artifacts |
| 合并 | 唯一串行环节 | glm-5.2/high | 合并队列一次一个,合后各 lane rebase |

看门狗:后台定时器(~25min)唤醒 lead 查 idle;>15min 无产出先催后重派;长跑 e2e/bench 不凭 idle 重派,以 artifacts 验收。

## 7. 每 PR 验证关(v3:三道 → 四道)

1. 单测/契约/表征全绿(表征断言不许改)。
2. e2e `--renderer=both`(+kernel gate)全绿,触及场景断言数不减。
3. visual-diff ≤ 阈值(含 T0.8 新增外壳基线)。
4. **性能 gate(新)**:触及 store/model/render/persist/hydrate/kernel 的 PR 必跑 20k leafer pan bench,p95 不退基线,artifact 归档(review-plan-c F2)。
- 覆盖盲区补不齐 → 显式列"未验证项+风险"。

## 8. 人工升级点 + 偏航检测(不变)

升级:表征暴露现有 bug / 无法自动证明等价 / CRDT spike 冲突 / DP 未拍 / CI 反复红 ≥3 / 任何需改 UI 才能迁移的情况。
偏航四检:动作仍服务行为等价?验证仍来自旧行为真相源?有没有为过而改表征/放宽阈值?有没有顺手改行为?任一成立停 loop 出偏航报告。
