# Tech Debt Audit — MivoCanvas

Generated: 2026-07-06 · anchor `c557c4c` (main) · 上轮 anchor `1d70a0a`（2026-07-04）· via `诊断项目`（repeat-run 增量）
方法：确定性工具（tsc / eslint / vitest / npm audit / knip / madge / depcheck / verify:logging）+ 4 路分模块子代理定性审计（render+canvas / store+model+types / app+lib / server），lead 对每条新 High/Critical 与关键 RESOLVED 声明独立核证（亲读 file:line，不只信子代理与 commit message）。
基线健康：`tsc -b` 0 错误 · `eslint` 0 告警 · `vitest` 948 passed / 12 skipped · `npm audit` 0 CVE · 生产代码 `as any`/`@ts-ignore`/`TODO` 均 0 处 · `verify:logging` 通过。

---

## 增量对账：上轮 59 条的处置

| 处置 | 数量 | ID |
|------|------|----|
| **RESOLVED**（已修，独立核证通过） | 22 | A05, V01, V02, V03, V05, V08 · S01, S02, S03, S03b, S07 · C01, C02, C03, C04, C05, C12, R01, R02, D01 · S10（cancel 分类部分）, S04（migrate 崩溃已封） |
| **OPEN**（原样未动） | 24 | V04, V06, V07, V11, V12, V14, V15, V17 · A01, A02, A03, S05, S06, S08, S09, S11, T01 · C06, C07, C08, C09, C11, A06, R03 |
| **PARTIAL**（部分缓解或范围变化） | 6 | V10, V16 · S12 · C10, C13, R02b, A04 |
| **设计裁定 / OBSOLETE**（已写入契约文档，转为有意设计） | 2 | V09（token 走 header）, V13（?token= 保 dev 兼容） |

**修复质量核证要点**：
- 数据安全五连（#81：S01/S02/S03/S03b/S04）真修到位——S01 用对象身份判据（栈顶快照引用未变才 pop）保住用户编辑与 redo 栈；S02 set 后加落地断言（`savedImages>0 且 createdNodeIds==0 → throw`）封死假成功；S03 per-canvas try/catch。
- BFF 可靠性三连（#75：V02/V03/V05）真修到位——registry 60s TTL 清扫 + idempotencyIndex 同步清；poll 连续失败计数（阈值 3）区分瞬时 5xx；30s per-request 超时贯穿全平台通道。
- 快赢包（#74：V01/C01/C02/C12/S07/S10/R03/V08/A05）核证：V01 date 白名单正则到位、C01 内联闭包已抽 hook、C02 四处 `.catch` 齐、A05 死文件已删。**唯 R03 反向复发**（见下）。

**恶化项（值得单独点名）**：
- **C06 坐标换算副本 3 → ≥6 份**：viewportMatrix 自称 canonical 但收编停滞，Leafer 接入又新增 `EditOverlayLayer.tsx:43` / `useLeaferSpikeRenderer.ts:734` 两处内联换算。
- **C07 god 函数 270 → ~438 行**：`contextMenuGroupsFor` 随右键菜单项增长膨胀。
- **C09 markup 默认点位 3 → 5+1 份**：Leafer paint 模块各拷一份。
- **A01 循环依赖不减反增**：又长出 `chatStore ↔ chatMaskEditFlow` 一条运行时值级环（新模块头部注释自认按同模式借新债）。

---

## Architectural mental model（本轮更新）

上轮的定性「src/render 是冻结的零消费契约资产」**已彻底过时**。经 30 个 Leafer PR（#91–#131），render 层从「白装、从没画过东西」变成**生产默认渲染器**：`?renderer` 默认 `leafer`，projection 被 4 个 leafer paint 模块（image/shape/line/brushStamp）真实消费，DOM 轨降为 `?renderer=dom` 应急回退。分层骨架仍优秀（app 壳 → canvas 组件+单一职责 hook → store 5-slice → render/model 纯层），类型纪律保持（生产 `as any` 仍 0）。

**本轮需写进认知的三条偏差**：

1. **render 层从「冻结资产」翻转为「双轨生产」，债的形态也翻转了**：不再是「零消费死代码」，而是 (a) 文件/命名/README 全链仍自称 *Spike*/「未接线」，代码库的**自我描述与现实双重相反**（R-09/R03）；(b) DOM 轨与 Leafer 轨的视觉等价靠三层测试守护，但 App.css 常量被硬拷进 paint 模块，改 CSS 不触发任何测试（R-10）。

2. **默认渲染路径缺 fail-visible 兜底**：Leafer init 无 try/catch/降级（R-01），而团队自己在 Pixi 侧写过完整 `failToDom` 范式——说明这个兜底该有却没接到默认轨上。叠加 0b spike 的像素探针（R-02）随默认切换进了所有生产会话。

3. **god 文件恒等式**：`LibraryWorkspace.tsx`(1316) 与 `canvasActionModel.ts`(1320) 两个真 god 文件 50 个 PR 一行未动（L01 系列全 OPEN）；新的 god hook 候选 `useLeaferSpikeRenderer.ts`(751) 把 init+camera+paint+LOD+探针挤在一处，且已抽出的 `useLeaferHost`/`useLeaferCameraSync` 两个「正式 hook」零消费（R-07，冻结资产模式在新代码里复发）。

债务集中区：`src/render`（双轨可靠性/性能/命名，最重且最新）> `src/store` mask-edit 异步流（新债簇 S-01~S-08）> `server/routes/proxy-image`（新 SSRF 面）> `src/app/LibraryWorkspace.tsx`（陈年 god 文件）。

---

## 新 Findings（本轮新增，共 40 条）

### render / canvas — Leafer 接入层（最重）

| ID | 类别 | File:Line | 严重度 | 工作量 | 描述 | 建议 |
|----|------|-----------|--------|--------|------|------|
| R-01 | 错误处理/fail-visible | render/useLeaferSpikeRenderer.ts:415,426 | High | M | 默认渲染器 `new Leafer`/`start()` 无 try/catch/日志/降级；init 抛错（WebGL/canvas 上下文失败、OOM）→ 图片/图形/markup 全静默消失（白画布）。触发概率低但后果全盘且零反馈。团队在 usePixiSpikeRenderer.ts:313 已有 failToDom 范式未复用 | 仿 pixi：init try/catch → debugLogger.error + toast + 产出 fallbackToDom，接上 useEngineSpikeRenderers 已有的 effectiveRendererMode 降级管道 |
| R-02 | 性能 | render/useLeaferSpikeRenderer.ts:235-255,697-719 | High | S | 0b spike 像素探针 `sampleNonEmptyCanvasPixels` 随默认切换进入全部生产会话：每次 paint sync 后 rAF getImageData(1×1)，空画布重试 30 轮 ×最多 1536 采样 ≈4.6 万次强制 canvas 读回/3s | DEV/e2e 门控（与 C12 同口径），生产置 pixelNonEmpty:true 跳过 |
| R-03(旧) | 文档反向漂移 | render/README.md:1-8 | High | S | README 仍写「尚未全量接线」「生产渲染零消费」，与现实完全相反（projection 已被 4 paint 模块消费 + leafer 是默认）。上轮 #74 改对过，本轮又漂回。新人首读即被误导 | headline 重写为「leafer 默认生产渲染器，DOM 为 ?renderer=dom 回退」；与 R-09 同 PR |
| R-03b | 性能 | render/useLeaferSpikeRenderer.ts:723 + leaferShapePaint.ts:353 + leaferLinePaint.ts:427 + leaferImagePaint.ts:322 | High | M | 任一节点变更（含拖拽每帧）触发全量 re-sync：所有 leafer 节点重跑 projectNode + props 重建 + 无条件 set()。per-node 签名门只在 inline loop（:629），4 个正式 paint 模块反而没有。20k 画布拖 1 节点=每帧 2 万次投影+set | 把 inline loop 的 signature 缓存下沉进各 paint 模块（entries map 已在，加 signature 字段跳过未变节点） |
| R-04 | 性能/死代码 | render/usePixiSpikeRenderer.ts:283,286 | Medium | S | Pixi 已 NO-GO 但 hook 仍无条件挂载。引擎 effect 有 `rendererMode!=='pixi'` 早退（核证：不会真 init），但 paintedNodes filter + paintedNodeSignature 的全量 JSON.stringify 每次 nodes 变化仍白跑一遍 | hook 开头对 filter/签名加 pixi 模式条件；或整删 499 行留 git 历史 |
| R-05 | 性能 | render/useLeaferSpikeRenderer.ts:194-228,342 | Medium | M | paintSignatureFor 对每个 painted 节点 JSON.stringify 全部视觉字段（brush markupPoints 可达数百点）；zoom 时 scale 每帧变→全量重算+re-sync | 改字段级浅比较或引 store 节点版本号；LOD off 时把 scale 从签名剔除 |
| R-06 | 安全/暴露 | render/useLeaferSpikeRenderer.ts:725-748 | Medium | S | `window.__MIVO_LEAFER_SPIKE__` 生产构建无条件暴露，与 C12 修复口径（DEV 门控）直接矛盾——同类问题修一处漏一处 | 加 import.meta.env.DEV 门控 |
| R-07 | 死代码/冻结资产复发 | render/useLeaferHost.ts, useLeaferCameraSync.ts | Medium | M | 两个「Phase 2b-1 正式 hook」零生产消费（仅各自 test 引用），spike hook 仍内联 init+camera。上轮「冻结契约资产」模式在新代码复发 | spike hook 切换消费这两个 hook（拆 751 行 god hook 第一步），或删除 |
| R-08 | 死代码/契约 | render/rendererAdapter.ts:27-41 | Medium | S | RendererAdapter 接口（mount/unmount/sync/…）零实现，只有 diffReconcilePlan+RendererSyncContext 被用；DomRenderer 头注释自称实现该契约但没实现 | 删接口保留被用部分，或注记「文档性契约，无实现计划」 |
| R-09 | 命名漂移 | useLeaferSpikeRenderer/leaferSpikeFilter/engineSpikeLod/…/window.__MIVO_LEAFER_SPIKE__/data-leafer-* | Medium | M | 生产默认渲染全链条命名仍是 *Spike*，叠加 R-03 README 反向漂移，代码库自我描述双重失真 | 一次机械 rename PR（含 e2e data-attr/探针名），与 R-03 同 PR |
| R-10 | 双轨一致性 | render/leaferShapePaint.ts:79-87, leaferBrushStampPaint.ts:93 | Medium | M | DOM/Leafer 视觉等价靠三层测试守护，但 App.css 常量（NOTE 阴影/圆角）被硬拷进 paint 模块，改 CSS 不触发任何测试失败→双轨静默分叉 | CSS 派生常量集中到共享 token 模块（DOM 侧同源引用），或加「App.css 关键选择器变更需人工确认」守卫 |
| R-11 | 架构/内存 | MivoCanvas.tsx:196-202 + useEngineSpikeRenderers.ts:47-53 | Medium | M | leafer 路径绕过 useCanvasVirtualization：culling 结果只喂 DOM 壳，Leafer 接 visibleNodes 全集（全量 image 持 blob lease、全量对象常驻）；shell 的 data-culling-mode=on 对 leafer 是误导性遥测 | 补决策记录明确「leafer 靠引擎自身裁剪」；或让 image lease 只对视口∪overscan 子集持有 |
| R-12 | 类型/循环 | rendererAdapter.ts:21 等 6 处 import type ViewportState | Low | S | madge 报的 4 条 render 环全由此 type-only 边闭合（编译期擦除，无运行时风险），但类型锚在 god hook 上，改成值导入即成真环 | ViewportState 挪到 rendererAdapter.ts 或独立 renderTypes.ts，环物理消失 |
| R-13 | 死代码 | render/leaferSpikeFilter.ts:156 | Low | S | filterDomNodesForLeaferSpike 兼容别名零消费 | 删除 |
| R-14 | 日志 invariant | render/rendererMode.ts | Low | S | 默认 leafer 路径不打 debugLogger（只有 dom/pixi/非法值打），渲染器身份这个最关键运行时状态在默认路径静默 | 默认分支补一条 debugLogger.log |
| R-15 | 死代码 | render/projection.ts（projectEdge/RenderEdge） | Low | S | A04 残留：projectEdge 仍零生产消费（仅测试） | 等 edge 渲染需求出现再激活，README 重写时标注状态 |
| R-16 | 性能 | src/canvas/useBrushStamp.ts:46 | Low | S | 橡皮擦每次 pointermove 对全量 nodes filter(isNodeEffectivelyLocked)，内部 O(n) find→O(n²)/move；20k 下擦除手感塌 | 拖拽开始用 lockedNodeIdSetFor 建一次 Set 缓存 |
| R-17 | 日志 invariant | render/useLeaferSpikeRenderer.ts:578-603 | Low | S | 切回 dom 模式的清空路径无日志（渲染器双轨切换是重要状态变更） | 清空分支补 debugLogger.log（含释放对象计数） |
| R-18 | 死代码/已判决 | render/textPaintMode.ts + useLeaferSpikeRenderer.ts:141-161 | Low | S | Phase 5 已判「文本永久留 DOM」(#121)，但 ?textPaint=leafer spike 分支与整个 textPaintMode.ts 仍在，只为已判死的对照实验服务 | 判决已定即可删 spike flag 链，瘦身 god hook |

### server — BFF（新 SSRF 面）

| ID | 类别 | File:Line | 严重度 | 工作量 | 描述 | 建议 |
|----|------|-----------|--------|--------|------|------|
| V-18 | 安全/SSRF | server/routes/proxy-image.ts:45-56,66-73 | High（公网条件） | M | DNS rebinding TOCTOU：isHostBlocked 先 lookup 校验 IP，随后 fetchWithTimeout(currentUrl) 用**主机名**让 Node 二次独立 DNS 解析。两次解析间攻击者可把域名从公网 IP 切到内网 IP，绕过校验访问内网。每一跳重验同窗口。**已 lead 独立核证成立** | 校验通过后用已解析 IP 直连并手动设 Host header（pin IP），或自定义 dns.lookup 复用首次解析结果 |
| V-19 | 安全 | server/routes/proxy-image.ts:60-73 | Medium | S | proxy-image 无出站域名 allowlist：任何解析到公网的 URL 都可被 BFF 代理→开放代理/流量放大/数据外带跳板；Cache-Control:public 缓存任意外链 | 若只需代理已知图源加 allowlist；否则限响应大小（已有 30MB）+ 审计日志 + 评估保留必要性 |
| V-20 | 可靠性 | server/platform/job.ts:266-272 | Medium | S | poll 成功分支尾部裸 setTimeout 不响应 abort，而 V03 新增的 waitForPollInterval 是 abort-aware 的；pending 轮询每轮最多多等一个 interval 才响应取消 | 272 行换成 waitForPollInterval(signal) 统一 abort 语义 |
| V-21 | 可靠性 | server/routes/proxy-image.ts:83-105 | Low | S | 重定向循环 parseProxyUrl(location) 对相对 Location 会 new URL 失败→误拒正常相对重定向图源 | new URL(location, currentUrl) 解析相对 Location 后再校验 |
| V-22 | 观测 | server/tasks/runner.ts:459-469,508 | Low | S | variations terminal 日志缺 quality/imgRatio/resolution 维度（generate/edit 有），排查撞线 case 信息少 | logContext 补 quality/imgRatio |
| V-23 | 错误分类 | server/routes/enhance.ts:200-211 | Low | S | callEnhanceLlm 的 response.json() 未独立 try：上游返 200 但非 JSON（HTML 错误页）时归 upstream-network，语义应是 bad-json | .json() 单独 try/catch，失败归 bad-json |

> V-24（knip 报的 server「零引用」导出）经核实全部有真实调用方或仅测试引用，**非死代码**，不列为 finding；可选收敛为模块内私有以减小 API 面。

### store / model / types — mask-edit 异步流新债簇

| ID | 类别 | File:Line | 严重度 | 工作量 | 描述 | 建议 |
|----|------|-----------|--------|--------|------|------|
| S-01 | 错误处理/日志 | src/store/chatStore.ts:228,494 | Medium | S | saveReferenceAssets 之后第二道 `if(get().isBusy) return` 静默丢弃：参考图已落盘（孤儿资产）+ 用户输入消失，无 log 无 toast（S03b 修的是 catch 分支，这条 return 漏了） | return 前补 debugLogger.warn + 按 S03b 落失败态消息或 toast |
| S-02 | 类型走私 | src/store/chatMaskEditFlow.ts:189,197,221,350 | Medium | S | S07 刚修完，新 mask 流程长出更糟的 `as never`：baselineSnapshot(unknown→cast)、errorKind(string→cast)。**已 lead 核证** | args 收窄为 MivoCanvasSnapshot\|undefined 与 ChatMessageErrorKind\|undefined，删全部 as never |
| S-05mask | 内存 | src/store/maskEditTaskRuntime.ts:29 + chatMaskEditFlow.ts:318 | Medium | M | 超时失败刻意保留 runtime record 供重试，但含 mask Blob（数 MB）+ source 节点 + payload，用户不点重试则永久驻留 Map，无 TTL 无上限，反复超时线性累积 | 加 LRU/上限（保留最近 3 条）或消息被 trim/scene 清空时同步 clearMaskEditTask |
| S-06 | 重复代码 | src/canvas/maskEditGeneration.ts:312-334 vs generationSlice.ts:189-220 | Medium | M | 无上限 poll loop + 终态映射整块复制（注释自认 inlined），两份 sleep 也重复；S05 加总时长上限须改两处 | 抽 taskPollLoop.ts 纯函数两处共用，顺手加 maxDuration 一并解 S05 |
| S-09new | 死代码 | src/store/documentSlice.ts:79-153 + chatStore.ts:766 | Medium | S | #127 删标题药丸后 renameCanvas/deleteCanvas 失去唯一 UI caller；duplicateCanvas/resetCurrentScene/clearScene 亦无非测试 caller。5 死 action + 契约测试在维护 | 跟产品确认 sidebar 项目管理是否回接；否则删 action+测试，是则留 TODO |
| S-03s | 类型走私 | src/store/chatMaskEditFlow.ts:75,119,151,225,273,403 | Low | S | `(m.generationContext as ChatGenerationContext)` 对可能 undefined 直接 cast+spread，缺字段畸形 context 写回持久层 | patch helper 对 null context 先 return（缺了即数据损坏，warn 跳过） |
| S-04t | 状态一致性 | src/store/chatMaskEditFlow.ts:121-129 | Low | S | beginMaskEditMessage 直接 append 不走 trimSceneMessages（其余路径都 trim 200/scene），mask 消息可无限突破上限 | append 包一层 trimSceneMessages（chatEnhanceFlow 已导出） |
| S-07r | 竞态 | src/store/chatMaskEditFlow.ts:362-423 | Low | S | retryMaskEditMessage 无 in-flight 防重入（chat send 路径有双保险），双击 Retry 可并发两 flow patch 同一 messageId，旧 abortController 成孤儿 | 入口检查 record 是否 in-flight，或消息 status 已非 error 即 return |
| S-08p | 持久化残留 | src/store/chatGenerationHydration.ts:16-30 | Low | S | settleExpiredChatMessages 把 in-flight settle 为 error，但不清 maskEdit.phase→'polling'/'submitting' 残留在 error 卡片 context | settle 时若有 maskEdit 则 phase 置 undefined |
| S-10gc | 持久化 GC | src/store/documentSlice.ts:115-153 vs chatStore.ts:85 | Low | S | deleteCanvas 只删 canvases，messagesByScene[sceneId]+referenceAssetUrls 永久残留 IDB 无 GC | deleteCanvas 后调 clearScene（跨 store 走小 facade），或 hydration 清理孤儿 scene key |
| S-11k | 错误分类脆弱 | src/lib/mivoTaskClient.ts:297（消费 chatStore.ts:126） | Low | S | S10 残留变体：timeout 分类靠文案 regex，server 文案改动静默弄丢「中质量重试」CTA | server task 终态加结构化 kind（BFF 改动）；短期给 regex 加契约测试锚定文案 |
| S-12c | 错误处理 | src/store/changelogStore.ts:82-107 | Low | S | loadChangelog 无并发 guard 无 AbortSignal，面板反复开关叠请求，失败重复 toast | 已 loaded 非强制刷新时 early return，或 in-flight promise 去重 |
| S-13h | 持久化健壮性 | src/app/useStoreHydration.ts:30-33 | Low | S | Promise.all 两 store rehydrate 一个 reject 即整体 catch，toast 无法区分 canvas/chat 哪个损坏 | 改 Promise.allSettled 分 store 记日志/toast |
| S-14w | 性能/写放大 | src/store/canvasPersistConfig.ts:29 + src/lib/persistIdbStorage.ts:162 | Low | M | 每次 set 触发 partialize 全量克隆全部画布 + JSON.stringify + IDB put，无 throttle；FU4-2 合法化 10k+ 节点后拖拽序列化成本变现实（R01 不覆盖 persist 路径） | bench 证无感则降观察项；否则 setItem 加 trailing debounce |

### app / lib

| ID | 类别 | File:Line | 严重度 | 工作量 | 描述 | 建议 |
|----|------|-----------|--------|--------|------|------|
| N-01 | 死代码 | src/lib/canvasArchive.ts:22-48 + snapshotValidation.ts:342-378 | Medium | S(决策)/M(接回) | 归档链生产不可达：导出侧全仓 0 调用；导入侧唯一消费者是 e2e 经 Vite dev 动态 import，UI 入口随 #127 删除。~430 行生产 + ~490 行测试守护一个用户摸不到的功能，snapshotValidation 本窗口还在增长 | 明确决策：接新 UI 入口，或整链（含 e2e 场景）移除；不要继续喂养 |
| N-02 | 错误处理/泄漏 | src/lib/assetUrlLease.ts:81-98 | Medium | S | resolveAssetUrl 拒绝时无处理：await inFlight(:96) 抛出后 leaseMap.delete(:101) 永不执行→entry 带 rejected promise 永久滞留，后续 acquire 命中 existing 再 +1 再抛，中毒缓存永不重试、refCount 永不归零。**已 lead 核证** | 两条 await 包 try/catch：拒绝时 leaseMap.delete(assetUrl) 再 rethrow |
| N-09 | god 文件苗头 | src/app/ProjectSidebar.tsx:408-478 | Low | M | 521 行、app 第二大组件：Debug Log 面板整段 portal JSX 内联，而同区 ChangelogPanel 已抽独立文件+store——同文件新旧两种组织方式并存；:269 搜索框无 state/handler、:160 settings 全 not implemented（demo 占位） | 照 ChangelogPanel 模式抽 DebugLogPanel.tsx；占位控件标注或隐藏 |
| N-03 | 死代码 | src/app/chat/ChatPanel.tsx:29,58 + ChatComposer.tsx:32-34 | Low | S | composerRef/ChatComposerHandle/useImperativeHandle 零消费（写 ref 后无人调 .focus()），实际焦点走 focusRequestId prop——两套焦点 API 一套死 | 删 handle+forwardRef，保留 focusRequestId 单通道 |
| N-04 | 一致性 | src/app/chat/ChatComposer.tsx:286 vs :97 | Low | S | file input accept 限 png/jpeg/webp，但拖拽/粘贴 addFiles 放行任意 image/*（gif/svg/bmp 可进参考图）——同功能两入口过滤口径不一 | 抽共享 ACCEPTED_TYPES 常量对齐 |
| N-05 | 死计算 | src/lib/assetStorage.ts:141-178,199-246 | Low | S | alphaBoundsFor 算裁剪矩形但唯一消费者只读 hasTransparency；所有返回路径 dimensions===sourceDimensions 恒等——透明裁剪残骸，两字段一语义 | 删裁剪矩形+padding 常量；dimensions/sourceDimensions 二选一 |
| N-06 | 日志 invariant | src/lib/assetStorage.ts:251-257 | Low | S | prepareImportedImage 失败 .catch 静默回退原文件无 debugLogger，违反「跳过不可用路径必须写日志」 | catch 补 debugLogger.warn |
| N-07 | 样式 token | src/App.css:1231 一带 + #bf3b2f 六处(358,1215,1512,1664,1721,1722) | Low | S | #126 刚引入 --panel-surface（一处改色全局），新 changelog 面板背景仍写死 rgba；错误红 #bf3b2f 无 token，新增 badge-dot 是第 6 处复制 | 补 --error token；changelog 背景改引用 panel token（alpha 用 color-mix） |
| N-08 | 一致性(cosmetic) | src/app/ChangelogPanel.tsx:46-49 | Low | S | formatCarouselDate 输出 "7-06"（月去零日不去零）混合格式 | 统一 M-D 或 MM-DD |
| N-10 | 类型 | src/lib/mivoImageClient.ts:207 | Low | S | enhance 响应 (await res.json()) as EnhanceResponse 裸断言透传 UI，degradedReason 有 'bad-json' 枚举却不校验 json 形状 | 至少校验 enhanced 字段存在，否则归 bad-json |

---

## Top 5 — 只修这些也值

1. **R-01 默认渲染器 init 无兜底 → 白屏无反馈**（useLeaferSpikeRenderer.ts:415）。leafer 是默认轨且 DOM 节点被 filter 剔除，init 一旦抛错整个画布空白且零日志零 toast——正是 fail-visible invariant 的核心反例。团队在 pixi 侧已写好 `failToDom` 范式（usePixiSpikeRenderer.ts:313），照抄接上 `effectiveRendererMode` 降级管道即可，工作量 M。

2. **V-18 proxy-image DNS rebinding SSRF**（proxy-image.ts:66）。校验用 IP、fetch 用主机名二次解析，rebinding 窗口可打内网。修法：校验通过后 pin 已解析 IP 直连（手设 Host header）。仅当 `MIVO_PUBLIC=1` 公网部署时为 High——需先确认部署面（见开放问题）。

3. **R-02 + R-03b spike 探针与全量 re-sync 进生产**（useLeaferSpikeRenderer.ts:235 像素探针 + :723 全量 re-sync）。像素探针每 3s 最多 4.6 万次 canvas 读回，纯粹是 0b spike 工装遗留；全量 re-sync 让 20k 画布拖 1 个节点=每帧 2 万次投影。探针 DEV 门控（S），re-sync 下沉 per-node 签名（M）。

4. **N-02 assetUrlLease 中毒缓存**（assetUrlLease.ts:96）。IDB 事务出错后该 asset 的 lease 永久卡死、refCount 永不归零、永不重试，直到刷新页面。两条 await 包 try/catch + 失败时 delete entry，工作量 S。

5. **A01 循环依赖持续借新债**（chatStore ↔ chatMaskEditFlow 运行时值级环 + canvasStore ↔ 5 slice）。当前靠「只在函数体内访问」侥幸不炸，但无 lint 守卫、新模块还在按同模式加环。抽 `canvasLog.ts` 打破值级环 + madge circular 纳入 CI 阻断，工作量 M。

---

## Quick wins（低工作量 × 中+严重度）

- [ ] R-03 render/README headline 重写（消除反向误导，1 处）
- [ ] R-02 像素探针加 DEV 门控（性能，生产直接跳过）
- [ ] R-06 `window.__MIVO_LEAFER_SPIKE__` 加 DEV 门控（暴露面，与 C12 同口径）
- [ ] R-14 默认 leafer 分支补 debugLogger（日志 invariant）
- [ ] N-02 assetUrlLease 拒绝分支 delete entry（防中毒缓存）
- [ ] S-02 chatMaskEditFlow 删 `as never` 收窄类型（走私）
- [ ] S-01 chatStore 第二道 isBusy return 补日志（消息丢失）
- [ ] V-20 poll 尾部 setTimeout 换 abort-aware（取消延迟）
- [ ] V-21 proxy-image 相对 Location 用 new URL(location, base)（误拒图源）
- [ ] N-06 prepareImportedImage catch 补日志（invariant）

## Things that look bad but are actually fine（必读，防误伤）

1. **madge 报 17 个循环依赖，多数是假环**：render 层 4 条全由 `import type ViewportState` 闭合（编译期擦除，无 TDZ）；store 侧 canvasStore↔{canvasGenerationHydration,canvasPersistConfig}、chatStore↔{chatEnhanceFlow,chatGenerationHydration,chatStoreMigrate}、debugLogStore↔remoteDebugReporter 的反向边全是 type-only。**真正的运行时值级环只有 canvasStore↔5 slice 和 chatStore↔chatMaskEditFlow 两族**（A01），madge 不区分 type import。别对着假环重构。
2. **documentSlice.commitGenerationResult set() 内三处静默 `return {}`** 看似 S02 复发，实为同 tick 竞态最后防线，被 :398-400 落地断言兜底（零节点落地必显式抛错带资产名）。不是假成功。
3. **DomRenderer memo 被内联 getNodeViewProps 击穿**（MivoCanvas.tsx:604）看似 C01 复发，实际无害：真正重渲染屏障在 CanvasNodeView.tsx:393 的 per-node memo，node 引用经 R01 快路径稳定。DomRenderer 本体只多跑一次 map。
4. **useLeaferSpikeRenderer inline loop 兜底画紫色占位矩形 + warn** 看似死代码，实为故意的 fail-visible 路由漂移守卫：filter 与 paint 谓词失同步时画面立刻可见紫块而非静默丢节点。
5. **canvasImageSource 无条件重编码 + O(n) 全像素 alpha 循环** 看似白烧全图，实为黑盘 bug 根治：只对 result 节点触发、失败保守回退且落 warn。
6. **ChatComposer document 级 capture pointerdown 强制 blur** 看似焦点 hack，实为 canvas 点击不参与 DOM 焦点流转的补偿，范围判断精确、有 cleanup，是 #106/#108/#111 三轮打磨的稳定形态。
7. **mergeCanvasPersistedState 硬编码 `migrate(persistedState, 9)`** 看似忘传版本，实为刻意补偿 zustand v5 version 相等时跳 migrate 只 merge 的行为，chatStore FIX-A 同源。
8. **cancelTask / createImageBitmap 空 catch** 是 advisory cancel + 有显式尺寸回退，注释说明，有意降级非遗忘。
9. **maskPng.ts 手写 PNG 编码器** 看似高危，实为 mask 结构极简（两块纯色矩形）、60 行无原生依赖、走 node:zlib、有 validateMaskSize 双上限，已被黑盘自愈链验证。
10. **12 个 skipped 测试** 全来自 `describe.skipIf(!runLive)` 的环境开关 live 契约测试，非债。

## Open questions for the maintainer

1. **proxy-image 部署面（决定 V-18/V-19 严重度）**：是否已 `MIVO_PUBLIC=1` 公网部署？仅 localhost 开发则 V-18 可降级；面向公网则应优先修。
2. **20k 生产目标是否真实（决定 R-03b/R-05/R-11 优先级）**：#128「20k leafer pan gate with line LOD」是 bench 口径还是生产口径？生产默认是 LOD off + culling 只作用 DOM 轨 + image lease 全量持有，20k 无 LOD 的性能/内存包络无基准覆盖。
3. **leafer 单选节点描边由谁画（可能是行为回归）**：paint 模块显式忽略选中态（注释称「selection stroke is a DOM overlay concern」），但未在 src 内找到 leafer 侧单选描边实现。需人工跑 `?renderer=leafer` 单选图片确认是否缺视觉反馈。
4. **5 个死 action 是债还是预留 API**（S-09new）：#127 三天前刚删 UI，sidebar 项目管理若计划回接 rename/delete/duplicate，删了又要写回。
5. **aiCanvasCommands.ts + documentModelV2 setNodeFills/Strokes/Asset/Relations**（A02/A03，~130 行传染性死代码）是 P4-a 锚点预备件还是遗留？
6. **S05/S-11 根治归属**：poll 总时长上限加客户端还是靠 server 任务 TTL？kindForFailedTask 结构化 kind 需 BFF 改动，超出 store 模块 scope。
7. **Leafer object.remove() vs destroy()**：paint 模块统一用 remove()，image blob lease 已显式释放，但 Leafer 内部纹理/位图缓存是否随 remove 释放未验证——长会话大量增删图片可能累积，建议查 Leafer 2.1 文档或加内存基准。

---

## 附：子代理判定与 lead 核证的分歧记录

| 项 | 子代理判定 | lead 核证结论 |
|----|-----------|--------------|
| R-01 Leafer init 无兜底 | Critical | **下调 High**：触发条件是环境级失败（WebGL/OOM）非常规输入，概率低；但后果全盘白屏无反馈，仍属高危 |
| R-04 Pixi hook 无条件挂载 | High（「白跑挂载」） | **下调 Medium**：引擎 effect 有 `rendererMode!=='pixi'` 早退（不会真 init），浪费的只是 paintedNodes filter + 签名 JSON.stringify |
| V-24 server knip 零引用导出 | 潜在死代码候选 | **剔除**：核实全部有真实调用方或仅测试引用，非死代码 |

核证方式：R-01 亲读 useLeaferSpikeRenderer.ts:400-455 与 usePixiSpikeRenderer.ts:305-325 对照；R-04 亲读 usePixiSpikeRenderer.ts:283-286/333/396；V-18 亲读 proxy-image.ts:45-105；N-02 亲读 assetUrlLease.ts:75-108；S-02 亲读 chatMaskEditFlow.ts:186-200；V01/V02 RESOLVED 亲读 debug-logs.ts:178-190 与 registry TTL。
