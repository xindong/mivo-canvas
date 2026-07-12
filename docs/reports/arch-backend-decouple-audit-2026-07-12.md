# 架构解耦与后端改造排查清单（2026-07-12）

> 基线：main @ c442b78。四路并行只读排查（前端解耦 / 后端完成度 / 内核双轨 / 产品化准备度），lead 已对 5 处承重证据独立核证（unwired adapter、22/27 注释、AssetBridge 全仓检索、pgConfig 回落、syncToServer 桩），全部与报告一致。
> 排查方法：代码实读 + grep 依赖追踪 + 契约测试实跑（unit 2557 tests 全绿 / lint / build PASS），不轻信文档声称。

## 总判决

**能力层全部建好且质量扎实，真实数据通路一条都没切。** 服务端 PG/权限/契约、CanvasCommand 类型系统、DocKernel record schema 都是真材实料；但客户端主数据仍 IDB-first、命令层不是唯一写出口、内核是影子工程。地基已为产品化让路，agent 化与协作还差"统一命令总线 + 服务端真相源"最后接线。

| 维度 | 完成度 | 一句话状态 |
|---|---|---|
| 前端模块解耦 | ~62% | CanvasCommand 覆盖 22/27 同步出口；交互手势/mask/chat 回灌/app 侧栏仍直捅 Zustand |
| 后端改造 | ~55% | 服务端实现扎实 + CI 真 PG 闸门；客户端 adapter 全 reject 桩，生产默认 memory |
| 内核双轨（T1.2） | 影子工程 | UI 100% 走 legacy 写路径；v11 payload 仍 legacy 形态非 record |
| 产品化准备度 | 5~6/10 | 单用户产品可演进；agent/协作平台缺 command transport 层 |

## 一、解耦现状分层清单

### ✅ 已真解耦（可依赖）

- [x] **渲染层 → store 边界**：只读投影 + subscribe，零反向写（`useLeaferSpikeRenderer.ts:399-407`，相机 React/gesture→engine 单向）
- [x] **store 六 slice 装配**：slice 间无 value-import，经同一 SliceCreator get/set 组合（`canvasStore.ts:77-88`）
- [x] **服务端权限路由覆盖**：projects/canvas/members/shareLinks/userState 全走 `resolveProjectAccess`/`authzCanvas`，无漏网（`server/app.ts:140-146`、`canvas.ts:203-690` 多点）
- [x] **内存↔PG 双后端契约一致**：接口无单侧缺失，契约套件覆盖 revision/重排/树删恢复/幂等（`backend.contract.dual.test.ts:22-284`）
- [x] **普通 chat 生图经 generationFacade 收口**（`chatStore.ts:14` → `generationFacade.ts:29-124`），不再直捅 canvas store（但未走 CanvasCommand）

### ⚠️ 半解耦（有接缝、未接线）

- [ ] **CanvasCommand 7 个异步 two-stage command 零生产 bridge**：executor 声明 `CanvasCommandAssetBridge` 接缝（`canvasCommandExecutor.ts:141,340,446-474`），全仓无生产实现/注入；生图/导入/mask 异步链路全部仍直调 runtime（`canvasActionEmitters.ts:66-76,114-123`）。**这是 agent 可序列化命令的最大断点。**
- [ ] **5 个未切 kind**（add-text-node / add-frame-node / add-ai-slot-node / select-nodes / 1-arg add-annotation-node）：卡在 #205 executor optional-arg 全量解包 vs 表征测试 strict-arity 断言，非业务问题；需 #205 契约决策后统一切（`canvasActionEmitters.ts:16-33` 注释自述）
- [ ] **canvasActionModel 残口**："view details" 闭包直调 `runtime.setActiveTool`/`generateIntoAiSlot`，未走 emitter（`canvasActionModel.ts:708-725`）
- [ ] **app 层直连 canvas store API**：LibraryWorkspace 直取 add/copy（`LibraryWorkspace.tsx:165-166,512-520`）、ProjectSidebar 直管 canvas lifecycle（`ProjectSidebar.tsx:61-66`）、ChatComposer 直读 selection/nodes（`ChatComposer.tsx:50-57`）

### ❌ 强耦合残留（产品化演进的真阻碍）

- [ ] **MivoCanvas 主交互手势直捅 store**：crop/新建 text/frame/rename/文件拖放导入全部 selector 直取写方法（`MivoCanvas.tsx:82-96,232-334`）；`useCanvasInteractionController.ts:45-95` 文本编辑直接 mutate——命令层未覆盖主交互
- [ ] **mask edit 跨层"超级流程"**：canvas hook → chat flow → canvas generation helper；chatStore ↔ chatMaskEditFlow **双向 import cycle**（`chatMaskEditFlow.ts:8-17`），直接双 store setState（`maskEditGeneration.ts:107-164,414-434`；`useMaskPointArmed.ts:143-201`）
- [ ] **领域模型反依赖 UI**：canvasDocumentModel value-import canvas 几何/node registry（`canvasDocumentModel.ts:13-17`），存在 cycle `canvasStore → canvasPersistConfig → canvasDocumentModel → canvasStore`。**不切断这条，DocKernel 成不了真内核。**

## 二、后端改造完成度清单

### ✅ 已完成

- [x] PgPersistBackend 全方法实装（`pgBackend.ts:391-1192`）+ Kysely migration + 双后端契约套件
- [x] 权限双后端（成员/分享链接/撤销/30 天恢复，`pgPermissionBackend.ts:154-280` + 契约套件）
- [x] CI PG16 service container 已 required（`ci.yml:399-491`，#210）
- [x] PG 启用缺密码 fail-fast，不静默降级（`pgConfig.ts:40-44`）

### ❌ 未接线 / 缺失（P1 风险，均已核证）

- [ ] **P1｜客户端持久化未进真实读写路径**：`serverPersistAdapter` 17 方法全 reject（`src/lib/serverPersistAdapter.ts:89-115`）、`syncToServer` 空实现（`persistIdbStorage.ts:200-206`）、writeRetryQueue inert 不接线（`writeRetryQueue.ts:7-15`）→ 主数据仍浏览器 IDB，PG 开了也没人写
- [ ] **P1｜生产默认 memory + 配置假绿**：仅精确值 `pg` 启用 PG，拼错值静默回落 memory（`pgConfig.ts:40`）；建议对非 `memory|pg` 显式值启动失败 + health 断言 backend=pg
- [ ] **P1｜项目恢复/删除跨 backend 非原子**：PersistBackend 与 PermissionBackend 两次独立写、无补偿（`projects.ts:153-156,281-285`）→ 第二步失败留下永久 revoked 分享链接（cutover-plan:64-71 已自认）
- [ ] **P1｜SSO 身份链路未实测**：无全局 auth middleware；SSO 信任失败 fallback 到 mivo-key 指纹（`owner.ts:46-97`），可能把多用户降到共享分片；需真实网关/伪造 header/绕网关三边界实测
- [ ] **P2｜资产 attach/detach 引用体系零生产调用**：`assetStore.ts:841-850,984-1012` 定义了 live-reference 授权但无调用方 → 协作者打开共享画布中 `mivo-sasset:` 资产 404；refcount 恒 0，purge 语义不成立
- [ ] **P2｜tasks registry 单进程内存**：重启即 404（`server/tasks/registry.ts:1-25`）

## 三、内核双轨（T1.2）真实状态清单

- [ ] **DocKernel 未承接真实写路径**：全部 actions 仍由 legacy slice 组成；`useKernelRead` 只是临时 MemoryDocKernel 做 compare + debug warn，无 setState/回写（`useKernelRead.ts:6-100`；`App.tsx:34-44`）
- [ ] **v11 payload 仍是 legacy 形态非 record**：docKernelPersistAdapter 不 import DocKernel/records/mapping，只做 blob→document/session 两 key 拆分（`docKernelPersistAdapter.ts:59-70`）
- [ ] **五套表示并存**：Zustand CanvasDocument / V2 归一 node / Record+revision / v10 blob+v11 split / server wire——映射存在有意丢失：tasks 固定 `[]`、status 不存、updatedAt/revision 不保（`adapters.ts:48-81`；`records.ts:6-11`）
- [ ] **shadowCompare 豁免掩盖风险**：status 跳过、tasks 不比、undefined/null/[]/{} 等价、nodes 按 index 比较（`shadowCompare.ts:24-154`）——生成态丢失不报警，CRDT reorder 语义无法证明
- [ ] **"64 字段无损"仅 4 fixture 自往返**，非 actions→persist→server 端到端（`mapping.test.ts:67-154`）
- [ ] **切主 P0 阻塞四项**：① 真实 command/write cutover；② persist 真 record 化 + tasks/session/assets/chat 归属；③ C 阶段（new 单写 + checkpoint + new→legacy→new 恢复演练，契约见 `kernel-dualtrack-contract.md:77-170`）；④ server sync（syncToServer 仍 stub，runbook:296 自认）
- [ ] **rollbackTrigger 仅 DEV console + confirm:true**（`rollbackTrigger.ts:10-15,130-177`），无生产灰度触发/指标/服务端回滚
- [ ] **e2e-kernel-gate 只证 URL 透传**（`e2e-smoke.mjs:492-500`），在影子架构下不能证明内核读写接管
- [x] Yjs 接缝为真（N1 spike 18 tests，`docs/spike/n1-yjs-mapping.md`）：record→Y.Map/Y.Array 可行、renderer 理论零改；但 CRDT 化需 DocKernel 降投影或 `setNodeFromCrdt` 绕 revision LWW，不能复用当前 upsert 仲裁；N2 前需拍 Q1-Q5

## 四、产品化演进准备度清单

| 维度 | 分 | 关键证据 |
|---|---:|---|
| agent 化接缝 | 5.5 | CanvasCommand 是扎实雏形（JSON union + 序列化 + 两阶段设计），但 deserialize 明示不校验不可信 payload（`canvasCommand.ts:430-433`）、无 server 命令端点、仅本地 apply |
| 协同预留 | 4.5 | per-record revision/409/幂等/权限矩阵是真地基；缺 websocket/SSE/presence/command log |
| 多端/新壳 | 6.0 | BFF + shared contract + render projection 有利；业务执行仍绑 Zustand runtime + React + IDB，非 headless domain core |
| 债务清理 | 4.5 | renderer/kernel/persist 三组双轨并行，删轨条件只有"P4 验收后删"一句话，无 owner/指标/终止日 |
| 迭代速度 | 6.5 | unit 2557 tests 6.77s + 多重 CI gate 保护强；PR 并行墙钟 ~20min，composer/bridge 无契约或 e2e |

**roadmap 声称 vs 代码兑现**：P0 兑现；P1 服务端兑现、客户端同步未兑现；P2 大体兑现（但 composer 需要的"忙时持久化入队"仍是 busy-drop，`chatBusyDrop.ts:1-65`，与预检 D2 决议相反）；P3 超前于旧路线图；P4 纸面/底座。

**输入框 agent 化依赖核验**：
- 快车道可复用 generationFacade/anchor/record，但工具总线前置 = CanvasCommand 服务端化（现 `/api/canvas` 只有 CRUD 无命令通道）
- 记忆层 #203 只是 seam 文档非占位实现（`memory-layer-seam.md`），接入要动 contract frozen key regex / userState route / 客户端 repository / consumer / composer 注入多处
- maker 路线 A 无硬 blocker，但它是单用户个人挂件，不能误当协作能力

## 五、下一步最该做的 3 件事（按解锁产品演进排序）

1. **CanvasCommand 升级为 command transport** — 因为：agent 主动改画布、记忆事件源、协作广播三条产品线都需要"受鉴权 + revision/幂等 + 可序列化下发"的命令通道，现在 command 只能本地 apply、deserialize 不校验不可信 payload、无服务端命令端点。范围：canvas authz submit/batch 端点 + 命令 version + 全 payload schema + idempotency/clientId + base revision/409/rebase + 审计；27 出口全走 dispatcher；AssetBridge 接生产实现。[价值: 最高]
2. **客户端接服务端真相源** — 因为：服务端 PG/权限/契约全部就绪却空转，浏览器仍 IDB-first，多用户/跨设备承诺无法兑现。范围：实现 fetch adapter + hydration/主写入/队列 executor 接同一 adapter + 409 rebase/冲突 UI + PG 灰度跨设备验收。[价值: 高]
3. **定三组双轨的删轨决议**（renderer / kernel / persist）— 因为：三组双轨叠乘让每次改动背 2×2×2 验证成本，删除条件无 owner/观察窗指标/回滚终止日。范围：每组写默认切换条件 + 观察指标 + 删除 PR + 终止日。[价值: 中高]

---

### 附：排查执行记录

- 4 路并行 worker（gpt-5.6-terra / effort high，用户点名）：arch-decouple / backend-persist / kernel-graybox / product-ready，均只读、未改文件
- 实跑验证：`npm run test:unit` 全绿（2557 tests）、`npm run lint` / `npm run build` PASS
- lead 独立核证 5 处：`serverPersistAdapter.ts:89-115`（全 reject 属实）、`canvasActionEmitters.ts:11-33`（22/27+5 未切+7 deferred 属实）、AssetBridge 全仓 grep（无生产实现属实）、`pgConfig.ts:40`（非 `pg` 值静默回落属实，缺密码 fail-fast）、`persistIdbStorage.ts:200-206`（syncToServer 空桩属实）
- 未跑全量 e2e（只读排查不占 20min+ CI 矩阵）
