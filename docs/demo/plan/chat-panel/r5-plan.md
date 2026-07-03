# R5 生图链路接入 mivo 平台 计划（Plan Mode）

## Loop R5 七要素（用户 2026-07-03 设定）

- 目标：**image2（gpt-image-2）和 banana（gemini）两个生图模型的出图速度都明显变快**（经 mivo 平台通道）；mask 局部重绘零回归
- 状态来源：本计划文件 + docs/demo/plan/chat-panel/LOOP.md R5 节 + worker 报告 + _tmp/fix-r5-out/
- 单轮动作：双审查回收（含 GPT 通道实测）→ lead 收敛终稿 → 派 z-ai/glm-5.2(effort max) 用 goal skill 执行 → 双 gpt-5.5 xhigh 审代码+执行结果 → worker 跑 e2e+冒烟（两模型出图速度 + 多任务队列 pending 能力排查）
- 验证方式：两模型真上游耗时对比表（banana 目标 ≤45s；image2 若走 mivo GPT 通道目标较 75-204s 至少减半——通道可行性以审查 A 实测为准）；全量 e2e 绿；冒烟含并发多任务 pending 行为报告
- 停止条件：速度目标达成 + e2e/冒烟绿 + 用户真机确认
- 预算限制：glm 执行重试 ≤1；审查/冒烟真上游调用合计 ≤20 次；执行并行度由 lead 定（预设：单 worker 串行，改动集中 vite.config/chatStore 并行会互踩）
- 人工升级条件：mivo GPT 通道不可用或不比 llm-proxy 快 → 停下报用户（image2 提速需另议方案，如仅 banana 切换 + image2 维持现状）

**范围扩大说明**：原计划仅 gemini→mivo。现按用户目标扩为双模型：`gpt-image-2` 也切 mivo 平台（modelType:"GPT"），mask 局部重绘仍留 llm-proxy gpt 通道（mivo 无 mask）。GPT 通道契约（modelFormat/payload 形状/速度）待审查 A 实测回报后在终稿定案；若实测不可用则 image2 维持 llm-proxy 并升级用户。

REVIEW_DOMAIN: `app_code`
REVIEW_FOCUS: vite 中间层 mivo provider（token/会话缓存+submit+poll+下载）; 能力表双写同步与 21:9 移除; persist v1→v2 迁移; e2e NB3 断言改造; 失败/取消/超时降级语义

> 日期：2026-07-03　状态：draft
> 分支：demo/improve-hud（基线 HEAD=38f4a48 或后代）

---

## Context

用户核心痛点：出图慢（gpt-image-2 经 llm-proxy 实测 75–204s，曾致频繁超时）。已实测 mivo 平台 HTTP API 全链路（token→会话→submit→poll→signUrl 下载）：**gemini 系 1:1/1K 出图 30.4s，快 2.5–6.7 倍**。本计划把聊天生图的 gemini 通道从 llm-proxy 切到 mivo 平台，gpt-image-2 与 mask 局部重绘留在 llm-proxy（mivo 无 mask 能力），前端契约零改动。

已实测契约（不再验证）：
- `POST {EP}/api/v1/state/token` body `{id:"",sub:"<mivo_ key>",name:""}` → `{session_id,session}`（30 天）
- `POST /api/v1/message/chat {type:"freeform"}` → chatSessionId（可复用）
- `POST /api/v1/message {chatSessionId,messageType:"image",modelType:"NANOBANANA",modelFormat:{version:"gemini-3-pro-image-preview"},action:"mcp",payload:{prompt,imgRatio,resolution,n:1,images?:[fileIds]}}` → jobId
- 轮询 `GET /api/v1/message/{jobId}` → `content.status ∈ pending|processing|completed|failed`；completed 时 `content.images:["/file/image/{fileId}"]`
- 下载：`GET /api/v1/file/signUrl/{fileId}` → 临时 URL；参考图上传 `POST /api/v1/file/` multipart(file)
- mivo 比例枚举 9 档：1:1,16:9,9:16,4:3,3:4,2:3,3:2,4:5,5:4（**无 21:9**）；resolution 1K/2K/4K；**无 mask/inpaint**
- 401 → 重取 token 重试一次（惯例）

Plan agent 复核修正（已吸收）：
- NB3 e2e（e2e-smoke.mjs:3782-3824）显式断言 gemini+21:9 → **必改**为 4:3（gemini 有、gpt 无，保留"模型专属比例"测试价值）
- mask 链路 `MivoCanvas.tsx:322,330` **已硬编码 gpt-image-2**，无需新增回落逻辑
- persist 洞：老会话 `selectedModel=gemini + imgRatio=21:9` rehydrate 不重跑 clamp → 需 persist v1→v2 migrate
- `mivoImageSizeMap` 仅 gpt 使用，不动；resolution 为纯新增维度（新常量 `mivoResolutionMap`）

Lead 拍板的决策：
- D-R5a 路由：`gemini-3-pro-image` → mivo 平台（NANOBANANA/gemini-3-pro-image-preview）；`gpt-image-2` 与全部 mask edit → llm-proxy 不动
- D-R5b 默认模型切 `gemini-3-pro-image`（速度优先，选择器可切回）
- D-R5c key 缺失**明确报错**（`MIVO_PLATFORM_KEY 未配置，请配置或切换 GPT 模型`），不静默回落 gpt
- D-R5d 质量映射 `low→1K, medium→1K, high→2K`；不用 4K。"中质量重试"仍为真降档（2K→1K）。实现时实测一次 2K 耗时，据此校 poll 预算
- D-R5e token/chatSession **纯内存缓存**（不落盘、不读写 ~/.mivo，避免与 MCP 缓存互踩）

## 非目标（Non-Goals）

- 不做 mivo 视频（ARK/JIMENG）、抠图 segment、超分 super_resolution 接入 — 后续按需
- 不改 mask 三件套与 mask 的 gpt 链路 — mivo 无 mask 能力
- 不做 SSE 结果流 — GET 轮询已够（中间层实现最简）
- 不迁移历史画布数据/已生成资产 — 与 provider 无关
- 不修改 `/Users/praise/.claude/**`

## 成功标准（SC）

- [ ] SC-1：gemini 通道经 mivo 平台真出图，前端契约不变
  - verify (method: command): `curl -s -X POST http://127.0.0.1:<port>/api/mivo/generate -H 'Content-Type: application/json' -d '{"prompt":"a cat","model":"gemini-3-pro-image","imgRatio":"1:1","quality":"medium"}' | python3 -c "import sys,json;d=json.load(sys.stdin);assert d['images'][0]['b64'];print('B64_OK')"`
  - expect: `B64_OK`（且耗时 ≤120s，日志可见走 platform 路径）
- [ ] SC-2：gpt-image-2 与 mask edit 仍走 llm-proxy（零回归）
  - verify (method: test): e2e mask 流断言 `/api/mivo/edit` 请求含 `model=gpt-image-2` 且带 mask（既有断言）+ 全量 e2e 退出码 0
  - expect: `E2E smoke test passed`, exit 0
- [ ] SC-3：能力表双写同步，gemini 无 21:9
  - verify (method: assertion): modelCapabilities.ts gemini ratios 无 21:9；e2e 新断言（gemini 比例弹层含 4:3 不含 21:9）通过
  - expect: 断言通过
- [ ] SC-4：key/token/session 不进浏览器产物与响应（审查 A 扩展版）
  - verify (method: command): `npm run build && (grep -rcE "MIVO_PLATFORM_KEY|mivo_|state/token" dist/ || echo CLEAN)`；另断言平台错误响应 JSON 不含 Authorization/session/sub 字段；env 不用 VITE_ 前缀
  - expect: `CLEAN` + 错误响应脱敏断言过
- [ ] SC-5：失败/超时/取消降级正确
  - verify (method: test): mock failed → 气泡 error 文案含"生成失败"；poll 超时 → 504 → 前端 upstream-timeout + 降质重试引导出现；请求中断 → 服务端 ≤1 个 poll 周期内停轮询（日志断言）
  - expect: 三条全过
- [ ] SC-6：persist v1→v2 迁移生效（含老消息 context）
  - verify (method: test): e2e 独立 context 注入 `version:1 + gemini + 21:9 覆盖 + 含 generationContext.imgRatio=21:9 的旧 error 消息` → rehydrate 后 paramOverrides.imgRatio==='auto' 且旧消息 context 已 clamp、比例弹层无 21:9
  - expect: 断言通过
- [ ] SC-7：Step 0 探针产出与门禁执行
  - verify (method: path): `_tmp/fix-r5-out/probe/probe-results.json` 存在，含 GPT 通道判定（可用性+耗时或错误原文）、2K 耗时、分支结论；实现的分流与判定一致
  - expect: 文件存在且字段齐全
- [ ] SC-8：速度目标（loop 核心）
  - verify (method: command): 真上游计时表——banana(gemini) 1K ≤45s；image2 若走平台则耗时较 llm-proxy 基线(75-204s)至少减半，若未走平台则明确标注"维持现状+升级用户"
  - expect: 计时表满足或升级标注在案

## 实施步骤

### Step 0：env 配置 + GPT 通道探针 + 2K 计时（执行门禁）`[SC-7]`
WHERE: `.env.local`（不入 git）+ `_tmp/fix-r5-out/probe/`
WHAT:
- `.env.local` 追加 `MIVO_PLATFORM_KEY=<用户提供的 mivo_ 前缀 key，lead 派发时给出>`、`MIVO_PLATFORM_ENDPOINT=https://aigc.xindong.com`；**该值必须 mivo_ 前缀；实现中绝不回落 MIVO_IMAGE_API_KEY 作平台 sub**（审查 A 实证两者鉴权体系不同：sk- key 打平台 token 端点 401）
- 探针 A（GPT 通道，≤4 次调用）：同一 token/会话提交 `modelType:"GPT"` 生图（modelFormat 先省略、再试 `{version:"gpt-image-2"}`），轮询到终态，记录可用性/耗时/错误原文
- 探针 B（2K 计时，1 次）：NANOBANANA + resolution 2K 出图计时 → 定 high 档 poll 预算（>150s 则调 deadline 并在汇报中说明）
- **门禁分支**：GPT 通道可用且耗时 < 75s（llm-proxy 下限）→ Step 1 含 image2 平台路由；不可用或不快 → image2 维持 llm-proxy，实现继续（仅 banana 切换），汇报中标记「image2 提速需另议」触发 loop 人工升级
WHY: image2 提速是 loop 目标的一半，但 GPT 通道契约未实证；做成门禁避免计划-探针死锁
VERIFY: `_tmp/fix-r5-out/probe/probe-results.json`（含 GPT 通道判定 + 2K 耗时 + 分支结论）

### Step 1：vite.config.ts 新增 mivo 平台 provider `[SC-1, SC-5]`（审查 A 修正版）
WHERE: `vite.config.ts`（proxyMivoGenerate/proxyMivoEdit 顶部分流 + 新 helper 族）
WHAT:
- 常量 `MIVO_PLATFORM_KEY`/`MIVO_PLATFORM_ENDPOINT`（默认 aigc.xindong.com）；helper 命名拆清 `callLlmProxy*` vs `callMivoPlatform*`（避免与现 mivoImageApiBase 混淆）
- **契约取值（审查 A 实证）**：create chat 取 `response.object_id` 作 chatSessionId；create message 取 `response.object_id` 作 jobId；upload 返回 FileMeta[]，每项取 `object_id ?? _id`；**signUrl 返回纯文本 URL 不是 JSON**
- 统一 `mivoFetchWithAuthRetry`：401→单飞刷 token→重试一次，包住 createChatSession/upload/createMessage/poll GET/signUrl 全部调用；token 与 chatSession 创建都单飞防并发；重试仍 401/403 → 502，**不回落 llm-proxy**
- poll：间隔 2.5s，deadline 175s（待 2K 实测校准）；**断连清理用 AbortController 贯穿全部平台调用 + `response.on('close')` 且 `!response.writableEnded` 才 abort**（req.on('close') 在 body 读完后不可靠），poll 每轮查 signal，断连后 ≤1 间隔停
- `mivoResolutionMap {low:'1K',medium:'1K',high:'2K'}`；独立 `resolveMivoPlatformPayload(modelId,imgRatio,quality)` builder（不复用 llm-proxy 的 resolveRatioPayload/aspect_ratio）
- **分流不变量（审查 A + Step 0 门禁合成）**：`mask 文件存在 → 无条件 llm-proxy gpt-image-2`（唯一必须保留 llm-proxy 的路径）；否则按模型的平台通道开关分流——gemini→平台 NANOBANANA（无条件）；gpt-image-2→平台 GPT 通道（**仅当 Step 0 门禁通过**，否则留 llm-proxy）；edit 进平台时把主 `image` + 全部 `reference[]`/`reference` 按表单顺序合并上传进 `payload.images`（**主图第一位，不许丢**）（覆盖 canvasStore.ts:2418-2430/2528-2538 的聊天/槽位路径）
- 平台通道开关建议实现为 `const MIVO_PLATFORM_CHANNELS = {'gemini-3-pro-image': {modelType:'NANOBANANA', version:'gemini-3-pro-image-preview'}, ...(Step 0 通过则加 'gpt-image-2': {modelType:'GPT', version:<探针结果>})}`，单点真相源
- 失败语义：本地参数错 400；平台 submit/upload/sign/poll 非 2xx 或 failed → 502（文案取 content.error||error||message 后**脱敏**，不回显 Authorization/session/sub）；deadline → 504；key 缺失 → 500 仅 gemini 平台路径报错，**不影响 gpt/mask llm-proxy 路径**
- 响应归一化 `{images:[{b64}]}` 前端契约不变
WHY: 核心链路；字段取值/分流不变量/断连写法是审查 A 实证的必错点
VERIFY: SC-1 curl + 断连日志 ≤1 poll 间隔停 + 三路由断言（gemini text→平台；gemini no-mask edit 的 payload.images 含主图+参考图；gpt mask 与 gpt no-mask 都不触达平台）
Hard-stop: 平台契约与实测漂移（status/images/object_id 字段不符）→ 停，回报 lead

### Step 2：能力表双写去 21:9 `[SC-3]`
WHERE: `src/lib/modelCapabilities.ts`（gemini ratios）+ `vite.config.ts` `mivoModelRatioMap`（SYNC NOTE 双写点）
WHAT: gemini-3-pro-image ratios → `['1:1','16:9','9:16','4:3','3:4','2:3','3:2','4:5','5:4']`
WHY: enhance prompt 注入与服务端 clamp 均以此为真相源；漏改 vite 侧 = 静默错误
VERIFY: tsc 过；RatioPopover gemini 无 21:9

### Step 3：默认模型切 gemini + persist v1→v2 `[SC-6]`（审查 B 修正版）
WHERE: `src/store/chatStore.ts`（selectedModel 默认值；persist version+migrate；retryMessage 入口）
WHAT: 默认 `'gemini-3-pro-image'`（persist 老用户保留自己已选模型，仅空 storage 新用户吃新默认——语义明确不加"强切"标记）；新增 `clampChatGenerationContext(context, modelCapabilities)` helper：migrate v1→v2 时 ① paramOverrides gemini+21:9→'auto' ② 遍历 messagesByScene 对每条消息的 generationContext/requestedImgRatio 做同 clamp（enhance.imgRatio 保留作历史展示）；`retryMessage` 开头也过同一 helper（防未来能力表变更再漏）
WHY: 审查 B 实证——重试直接用旧 context.imgRatio（chatStore.ts:460-461）、参数卡优先展示 context（EnhanceParamCard.tsx:17-19），只迁 overrides 会让 21:9 从老消息复活
VERIFY: SC-6 e2e 注入断言（含老消息 context clamp 断言）

### Step 4：e2e 改造 `[SC-2, SC-3, SC-5, SC-6]`（审查 B 修正版）
WHERE: `scripts/e2e-smoke.mjs`
WHAT: ① NB3 21:9→4:3（注释/错误文案同步去掉 aspect_ratio/no-size 等 llm-proxy 语义）② 新增 gemini 比例弹层断言（含 4:3 无 21:9）③ **persist 迁移用例用独立 browser context/page，不挂全局 localStorage.clear 的 addInitScript**（否则注入的 v1 数据被清、测成空 storage 假阳性——e2e:256 全局 clear），addInitScript 注入 v1 结构后首次 goto 触发 rehydrate ④ 失败/超时降级用例：**gemini high 超时→出现「中质量重试」且第二次请求 quality=medium；gemini medium 超时→不出现降质按钮、文案为"稍后重试/换比例"**（超时引导条件化，见 Step 4b）⑤ 确认 localStorage.clear 后默认 gemini 不破既有段落 ⑥ 加能力表双写同步断言（MODEL_CAPABILITIES vs mivoModelRatioMap 源码比对）
WHY: NB3 不改必红；迁移假阳性与降质语义是审查 B 实证的洞
VERIFY: 全量 `MIVO_E2E_PORT=<port> npm run test:e2e` 退出码 0（直接读退出码，禁管道 tail）

### Step 4b：超时引导条件化 + 质量标注 `[SC-5]`（审查 B 新增）
WHERE: `src/app/chat/ChatMessageList.tsx`（已有 high 条件）、`src/lib/mivoImageClient.ts:24-25`（超时文案）、`src/app/chat/RatioPopover.tsx`（质量段选 title）
WHAT: 超时文案条件化——effective quality 为 high(2K) 时才建议降质，「中质量重试」按钮 title 注明"降到 1K"；medium/low 超时文案改"稍后重试、换比例或减少参考图"；RatioPopover 质量项 title 标注 高(2K)/中(1K)/低(1K)（gemini 下）
WHY: gemini 映射 low/medium 同为 1K，"降质"对 medium 是假话——文案诚实
VERIFY: Step 4 的 ④ 双向断言

### Step 5：真机验收 + 2K 实测校预算 `[SC-1, SC-4]`
WHERE: 运行时验证（证据 `_tmp/fix-r5-out/`）
WHAT: 真上游各 1 次：gemini 1K 文生图（计时）、gemini 2K high（计时→若 >150s 调 poll 预算并回报）、gemini 带参考图 i2i、gpt-image-2 一次（零回归）、mask 局部重绘一次（仍走 gpt）；`grep dist` 验 key 不泄漏；截图入 _tmp
WHY: D-R5d 的 2K 预算需数据定案；SC-4 防泄漏
VERIFY: 计时表 + 截图 + grep CLEAN

## 边界与失败模式

- 必须处理：failed→502 中文原因；signUrl 404→502「结果文件已失效」；上传失败→502「参考图上传失败」；poll 超时→504；key 缺失→500 明确文案；401→刷 token 重试一次；断连停轮询
- 明确不处理：多 dev server 实例共享会话并发语义（单人 demo，jobId 天然隔离，记录假设）；SSE 流式进度（v2）
- 风险与防护：R1 NB3 冲突→Step 4；R2 双写漏改→Step 2 + SYNC NOTE；R3 轮询空跑→close 清理；R4 persist 21:9 复活→Step 3 migrate；R5 与 MCP ~/.mivo 互踩→D-R5e 纯内存；R6 2K 超预算→Step 5 实测定案；R8 key 缺失→D-R5c 明确报错

## 测试计划

- 单元：无独立单元层（demo 惯例），逻辑断言全走 e2e + 脚本
- 集成/E2E：Step 4 全量绿（含 4 类新增用例）
- 真机：Step 5 五连测 + 计时表
- 暂不执行：mivo 视频/抠图/超分接入测试

## 双审结论与采纳记录

- 审查 A（服务端，gpt-5.5 xhigh）：REQUIRES_CHANGES ×2 轮，5 条阻塞全采纳（object_id 取值/edit 分流不变量/AbortController 断连/统一 authRetry/env 命名与不回落）；GPT 通道与 2K 实测因 env 无平台 key 未完成 → 转为 Step 0 执行门禁
- 审查 B（前端/测试，gpt-5.5 xhigh）：REQUIRES_CHANGES ×2 轮（第二轮带真机实证：v1 storage 注入复现 21:9 复活），3 条阻塞全采纳（消息级 migrate/独立 context 迁移测试/降质引导条件化）；非阻塞 5 条采纳（双写断言/独立 builder/NB3 注释/默认语义/质量标注）
- 基线实证：build/lint/全量 e2e 于 38f4a48 全绿（双审各自实跑）

## 待确认

无（质量映射、key 缺失策略、image2 门禁分支均已定；GPT 通道可行性由 Step 0 探针在执行期定案，不阻塞计划批准）。

## 实施前 Review Checklist

- [x] 双审 8 条阻塞全部合入（Step 0/1/3/4/4b）
- [x] NB3 e2e 冲突已纳入步骤（Step 4）
- [x] 双写点（modelCapabilities + mivoModelRatioMap）均在 Step 2 + 同步断言
- [x] persist 迁移覆盖 paramOverrides + messagesByScene 两层（Step 3）
- [x] mask 链路确认无需改动（已硬编码 gpt，mask 存在→无条件 llm-proxy）
- [x] 504/502/500 语义与降质重试链路兼容且条件化（Step 1 + 4b）
- [x] key 仅 Node 层读；MIVO_PLATFORM_KEY 独立命名不回落；SC-4 扩展防泄漏断言
- [x] 执行方式（Loop R5）：派 z-ai/glm-5.2（effort max）+ goal skill **单 worker 串行**（vite.config/chatStore 集中改动，并行必互踩）；commit 粒度 Step0 探针记录 + Step1-4b 一个 `feat(demo-r5)` + e2e 并入；执行完 → 双 gpt-5.5 xhigh 审代码+执行结果 → worker 跑 e2e+冒烟（双模型速度 + 多任务队列 pending 排查）→ lead 真机终审
