# 计划审查结果

结论：需要修改
审查领域：应用代码
审查模式：单轮
审查范围：全局矩阵

对象：`docs/plan/arch-migration-execution-plan.md`
维度：迁移顺序依赖 + 回归契约充分性
审查时间：2026-07-09

## 实跑与核对基线

| 检查面 | 结论 | 证据 |
|--------|------|------|
| 测试基线 | 通过 | `npm test` 不存在脚本；按项目等价命令跑 `npm run test:unit`，结果：101 test files passed，1249 passed / 12 skipped / 1261 total，耗时 6.63s。 |
| 回归契约盘点 | 失败 | 计划写 27 e2e + 74 单测；实际 `scripts/e2e/scenarios/index.mjs` 有 28 个场景，`leaferSkippedScenarios` 跳过 `canvas-interactions`；当前 unit 为 101 个测试文件 / 1261 tests。 |
| CI 可落地性 | 失败 | 已逐个打开 `.github/workflows/ci.yml`、`daily-changelog.yml`、`nightly-e2e.yml`、`pr-hygiene.yml`、`secret-scan.yml`；GitHub required checks 为 6 项：`lint + tsc + unit + logging`、`structure guard (anti-regression)`、`e2e prod subset (mock upstream)`、`e2e token gate (authorized)`、`e2e token gate (unauthorized)`、`secret scan (gitleaks)`。无 visual-diff required check。 |
| file:line 抽查 | 通过 | 抽查 `src/render/rendererMode.ts:26-63`、`src/lib/persistIdbStorage.ts:129-135`/`:182`、`src/lib/mivoImageClient.ts:130-178`、`src/lib/mivoTaskClient.ts:143-216`、`src/store/authSlice.ts:31-74`、`src/store/canvasPersistConfig.ts:18-38`、`src/store/chatStore.ts:836-847`、`src/lib/assetStorage.ts:3`/`:249-297`、`scripts/e2e-runner.mjs:22-37`/`:85-93`、`scripts/visual-diff.mjs:33-36`/`:435-442`。 |
| Playwright 配置 | 不适用 | 仓库未发现 `playwright.config.*`；e2e/visual-diff 均由自研 Node runner 直接调用 Playwright。 |

## 问题

### 问题 1 [P1|`docs/plan/arch-migration-execution-plan.md:136-140` / `.github/workflows/ci.yml:82-163` / `scripts/e2e-runner.mjs:22-37`] 每 PR 三道关没有落到 CI，也不会覆盖 `?kernel=new`

问题：计划把“单测/契约/表征 + e2e `--renderer=both` + visual-diff”定义为每 PR 三道关，但当前 required CI 不执行这组三道关。`ci.yml` 的 PR e2e 只跑 `npm run test:e2e:prod:subset`，而 `package.json:19` 没传 `--renderer=both`，`scripts/e2e-runner.mjs:36` 默认 `dom`；`visual:diff` 只在 `package.json:13` 是脚本，不在任何 workflow 里，也不是 required check。计划新增 `?kernel=` 后，当前 runner/CI 也没有 `--kernel=new|both` 维度，迁移 PR 可以在默认 legacy/DOM 下绿灯合入但新内核路径全坏。

证据：required checks 实查为 6 项：`lint + tsc + unit + logging`、`structure guard (anti-regression)`、`e2e prod subset (mock upstream)`、`e2e token gate (authorized)`、`e2e token gate (unauthorized)`、`secret scan (gitleaks)`；无 visual-diff。`scripts/visual-diff.mjs:35` 阈值存在（5%），但 `.github/workflows/*` 没有调用 `npm run visual:diff`。`scripts/e2e-runner.mjs:85-93` 支持 renderer=both 的逻辑存在，但 CI 没传。

影响：计划的核心成功定义“行为/UI/交互零变化”没有机器闸门；尤其 `?kernel=` 默认 legacy 时，新内核可在 PR 阶段完全未运行。后续迁移可能积累到切默认 new 时才集中爆雷。

建议修法：把 §7 改成可执行 gate 清单，并补 M0 任务：1）`e2e-runner`/`e2e-smoke` 增加 `--kernel=legacy|new|both`，URL 透传 `?kernel=`；2）PR workflow 对迁移相关 PR 至少跑触及场景的 `--renderer=both --kernel=new`，里程碑/切默认前跑全量 `--renderer=both --kernel=both`；3）新增 `visual-diff` workflow/job，上传 artifacts，并把它纳入 required checks 或明确写成 G3 手动阻塞证据；4）required check 名称写进计划，避免 branch protection 与 workflow job name 漂移。

验收：`gh api .../required_status_checks` 能看到新增 visual-diff/check 名；PR CI 日志出现 `renderer=dom`、`renderer=leafer` 和 `kernel=new`；visual-diff artifacts 有 report/diff PNG；迁移 PR 的 checklist 禁止只贴本地手跑结果。

### 问题 2 [P1|`docs/plan/arch-migration-execution-plan.md:77-87` / `src/store/canvasPersistConfig.ts:18-38` / `src/store/chatStore.ts:836-847` / `src/lib/assetStorage.ts:3`] T1.3/T1.4/T1.5/FX-6 顺序不成立，跨设备与跨账号目标会提前验收

问题：计划把 T1.3 写成“4 个 API + PersistAdapter 服务端实现”，其中包含图片 `/api/assets`，验收又要求“换电脑登录同账号项目/画布原样在”；但真正的资产服务端化放在 T1.5。当前本地资产在独立 IDB `mivo-canvas-assets`，节点只存 `mivo-asset:<uuid>`，没有 T1.5 前跨设备显示不了图片。同时权限层 T1.4 在 T1.3 之后，意味着先建/切服务端数据 API 再补 owner/editor/viewer。FX-6 也只是 P1 修复项，未作为 T1.3 切换前硬前置；而当前 `mivo-canvas-demo`、`mivo-chat-demo`、`mivo-canvas-assets` 都是全局本地 key/DB，`authSlice.logout()` 只清 auth store 并跳 SSO logout，不清画布/chat/资产缓存。

证据：`canvasPersistConfig.ts:19` 固定 `name: 'mivo-canvas-demo'`，`chatStore.ts:836` 固定 `name: 'mivo-chat-demo'`，`assetStorage.ts:3` 固定 `DB_NAME = 'mivo-canvas-assets'`。`authSlice.ts:62-67` logout 只 `set({ user:null, status:'unauthenticated' })` 并改 `window.location.href`。`assetStorage.ts:249-297` 保存/解析资产完全走本地 IDB blob。计划 `T1.3` 同时声明 `/api/assets`，`T1.5` 又声明 AssetService server 化，边界重复且顺序冲突。

影响：按当前顺序执行，T1.3 可能在未完成资产服务端化和权限约束时被验收；B 用户登录同浏览器可能先看到 A 的本地缓存；跨设备“原样都在”会在图片、chat reference、asset lease 上失败；未授权资产/画布 API 也可能先暴露。

建议修法：重排 P1：1）把 FX-6 提升为 T1.3 默认切换前硬前置，要求 cache key/DB 带 `userId` 或在 hydrate/user-change/logout/401 时清理画布、chat、资产缓存；2）T1.3 先只做 auth-bound `/api/projects`、`/api/canvas`、`/api/user-state` 服务端 adapter，不把 `/api/assets` 计入“原样跨设备”验收；3）T1.4 权限中间件必须先覆盖 project/canvas/user-state 读写，再允许分享；4）T1.5 资产服务端化必须与权限校验同 PR 或硬前后序，完成后才验收“跨设备图片可显示”；5）FX-4 节点级 PATCH 与 T1.2 revision 不仅“同设计”，还要作为 T1.3 API 的禁止整画布 PUT 约束。

验收：新增顺序图或任务板依赖：`T1.2 revision/schema -> FX-4 PATCH API -> T1.3 adapter (auth-bound, user cache namespace) -> T1.4 sharing permissions -> T1.5 assets with permission`；新增 A 登出/B 登录、本地缓存隔离、跨设备图片显示、未授权 asset 403/404 的测试。

### 问题 3 [P1|`docs/plan/arch-migration-execution-plan.md:27-39` / `:64-65` / `scripts/e2e/scenarios/index.mjs:30-68`] P0 表征测试目标不是 decision-complete，且计划里的覆盖数字已失真

问题：T0.4 只说“给零测试的 canvasActionModel、authSlice、薄测试 UI 交互录当前行为”，没有列出必须冻结的行为面、文件名、断言类型和迁移后不可改规则。计划里的“27 e2e + 74 单测”也不是当前事实：实际 unit 是 101 个测试文件 / 1261 tests；e2e 场景是 28 个，且 leafer 跳过 `canvas-interactions`。`canvasActionModel.ts` 1320 行和 `authSlice.ts` 75 行确实没有直接单测文件，但 `scripts/e2e-smoke.mjs:172-197` 只做 action model 源码字符串守卫，不是行为表征；`authClient.test.ts` 覆盖 fetchMe，不覆盖 `useAuthStore` 的 hydrate/login/logout/markUnauthenticated 状态机。

证据：`wc -l` 确认 `src/canvas/actions/canvasActionModel.ts` 1320 行、`src/store/canvasStore.contract.test.ts` 864 行、`src/store/authSlice.ts` 75 行。`find src server scripts -name '*.test.ts*' | rg 'canvasActionModel|authSlice'` 未发现直接测试。`npm run test:unit` 实跑 101 files / 1261 tests。`scenarioOrder.length` 实测 28，`leaferSkippedScenarios` 为 `canvas-interactions`。

影响：M1/M3 最重的 command 形式化会改 `canvasActionModel` 和 store action 出口；没有精确表征清单时，worker 容易只补少量 happy path 后继续迁移，后续“行为一致”无法客观判断。覆盖数字失真也会让 gate 的断言数增减失去基线。

建议修法：把 T0.4 拆成可验收子任务：1）`canvasActionModel.characterization.test.ts`：blank/single/multi 选择上下文、quick toolbar/context menu 分组、capability 到 action 映射、生成/编辑/排列/锁定/隐藏/删除/markup 创建位置与默认样式、download/import label 与回调；2）`authSlice.characterization.test.ts`：hydrate 200/401/500、login/logout URL、markUnauthenticated 幂等、无 persist、本地状态清理约束；3）`persist-adapter.characterization.test.ts`：现有 partialize shape、IDB fallback、未来 user namespace/cache purge；4）UI 薄区按实际现状校正：Changelog 已有 e2e，LibraryWorkspace 已被 `archive-assets` 部分覆盖但没有独立 unit/contract；列缺口而不是笼统“弱-无”；5）把当前真实数字写入计划，并规定迁移 PR 不得降低测试/场景断言数。

验收：新增测试文件名和断言清单进入任务板；在当前 main 上先全绿；迁移 PR diff 中若修改这些表征测试必须触发偏航升级；`npm run test:unit` 和 e2e 场景计数在计划中更新为真实值。

### 问题 4 [P2|`docs/plan/arch-migration-execution-plan.md:21-24` / `:64` / `src/render/rendererMode.ts:26-63`] `?kernel=` 不能只“复刻 rendererMode.ts”，需要定义状态内核双轨契约

问题：`rendererMode.ts` 是模块加载时解析一次 URL 的 view-layer 常量，默认 `leafer`，并通过 `.canvas-shell data-renderer-mode` 供 e2e 验证。这个模式适合渲染器双轨，但 `?kernel=` 会影响 Zustand store 初始化、persist adapter、server sync、command 出口、缓存命名空间和迁移 merge。计划只写“复刻 rendererMode.ts（URL param+env）”，没有说明 import order、双轨写入策略、legacy/new 是否 shadow compare、默认 legacy 时如何持续测试 new、以及新旧内核共存期间哪些文件允许双写。

证据：`rendererMode.ts:61` 导出 `rendererMode` 常量，`scripts/e2e-smoke.mjs:75` 只拼 `?renderer=${rendererMode}`，`scripts/e2e-runner.mjs` 无 kernel 参数。`persistIdbStorage.ts:129-135` 的 `syncToServer` 目前无参数空实现，`canvasStore.ts:77-88` 在模块装配时直接创建 store。

影响：如果 M0 只复制一个 `kernelMode.ts`，后续 worker 仍可能在 store 已初始化后才读 flag，或只测试 legacy 默认路径；双轨维护成本会从计划外溢到每个 slice/action，导致迁移行为不可比。

建议修法：T0.3 增加“kernel flag RFC/contract”：`kernelMode` 的解析时机、默认值、env/URL 优先级、DOM/debug 暴露、e2e 透传、store factory 注入点、legacy/new 单写还是 shadow read compare、缓存 key 后缀、禁止运行时切换。并把 “default legacy but CI touches new” 写入 §7。

验收：`kernelMode.test.ts` 覆盖默认/非法/new/legacy；e2e 可通过 `--kernel=new` 验证页面 `data-kernel-mode`；store/persist 初始化只从同一个 kernel contract 读取；计划列出双轨删除条件。

### 问题 5 [P2|`docs/plan/arch-migration-execution-plan.md:80` / `scripts/e2e/scenarios/archive-assets.mjs:127-140` / `src/lib/canvasArchive.ts:22-47`] T1.6 切换日 runbook 不可操作，手动 JSON 搬迁路径缺入口、冻结和回滚

问题：D7 原口径是“存量 IDB→服务端迁移器带 dry-run+回滚”，当前 T1.6 已降级为“不做迁移器，切换日各自用 Mivo JSON 导出/导入手动搬”。降级本身可以成立，但计划没有补偿性的 runbook：谁导出、从哪个版本导出、是否冻结写入、如何确认资产嵌入、如何导入到 new kernel、失败怎么回滚、老 `mivo-asset` 空占位如何列清单。更关键的是，当前 e2e 注释明确“Import JSON 的 UI 入口随药丸移除”，测试只能直接调用 `parseCanvasSnapshot + restoreCanvasImportAssets + replaceSnapshot`；`rg` 也没找到 `stringifyCanvasArchive` 的 UI 调用。

证据：`canvasArchive.ts:22-44` 有 `createCanvasArchive/stringifyCanvasArchive`，`snapshotValidation.ts:342-378` 有 import parser，`archive-assets.mjs:127-140` 注释并绕过 UI 直接调 store 管线。计划 T1.6 的验收只有“协作者确认需要的画布已搬；接受老 mivo-asset 引用变空占位”，不足以指导切换日。

影响：切换日可能发现用户没有可用导出/导入入口；长活旧标签页仍按旧 schema 写回服务端（`unknowns-map.md:57-59` 已点名版本偏斜）；手动搬迁失败时没有冻结点和回退路径，会产生不可逆数据丢失或重复导入。

建议修法：把 T1.6 改成独立 runbook gate，用运营 dry-run/rollback 取代 D7 迁移器的技术 dry-run/rollback：切换前 legacy 导出入口/脚本可用并验证资产嵌入；切换窗口冻结写入或显示只读提示；new kernel 导入入口/脚本可用；导入后校验项目/画布/chat/资产数量和空占位列表；保留 legacy 只读观察窗；加 schema version header 或 stale-client 拒写/刷新提示；明确 rollback：默认 kernel 切回 legacy + 服务端写入暂停/数据快照恢复。

验收：一次 dry-run 记录导出文件、导入日志、校验清单、失败回滚演练；至少覆盖一个含本地 `mivo-asset`、chat 记录、生成 task 历史的画布。

## 剩余风险

- `unknowns-map.md` 的 B1（嵌套字段粒度）和 B4（长活标签页版本偏斜）虽不是本维度主审，但会影响 T1.2/T1.3 验收，建议在数据模型 reviewer 的共识清单中合并。
- 当前分支工作区已有多份未跟踪治理材料和计划文件；本审查只新增 `history/plan-review/review-plan-b.md`，未修改计划或源码。

verdict: REQUIRES_CHANGES
