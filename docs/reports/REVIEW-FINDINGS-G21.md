# G2.1 双审 REQUIRES_CHANGES — finding 全文（lead+sol 共识，2026-07-12）
3 P1 + 3 P2。lead 已核证 F2/F5/F6。安全向，逐条修。

## F1 [P1] owner.ts:160-206 strict 切换让全部 legacy owner 数据不可见，未声明 G2.2 前置
sol 隔离复现：legacy 建 project（owner=指纹）→ 翻 strict → alice 列表空。受影响持久键全清单：persist_records.owner_id / projects.owner_id / canvases.owner_id / idempotency_index.owner_id / share_links.created_by / AssetRecord.ownerFp + references[].ownerFp + .uploaders。dp4-identity-alignment.md:128 仍指 T1.6 与计划 §5 G2.2 冲突未校准。
修法：① owner.ts + .env.example + runbook 明确 MIVO_SSO_STRICT 严禁先于 G2.2 迁移；② 更新 DP-4 R-2 指向 G2.2 并附完整 owner inventory；③ 加可机械验证的 owner-migration-complete gate（如启动时检测 legacy 形态 owner 行数>0 且 strict=1 → 拒绝启动/大告警，具体形态你定但必须是机器判定不是文字约定）。
验收：seed legacy 四表+asset metadata → G2.2 映射 → 翻 strict → 同一 SSO 用户全可见、幂等 replay 命中；不可唯一映射 no-go。（G2.2 未实装前，本 gate 测试可用模拟迁移函数打桩，但 gate 机制本身必须真实。）

## F2 [P1] owner.ts:78-79 dev mode 缺双保险，public+staging 可绕过（已复现 200）
isDevMode 只查 MIVO_DEV_MODE=1 && NODE_ENV!=='production'。sol 复现：strict+dev+MIVO_PUBLIC=1+NODE_ENV=staging → 任意 x-mivo-auth-user 200，validateSsoConfig 零告警。仓内正确先例就在 auth-stub.ts:21-25（production 硬关 + MIVO_PUBLIC=1 硬关）。
修法：mirror isDevStubActive——MIVO_PUBLIC=1 恒 false；NODE_ENV 正向枚举（仅 development/test 放行，staging/空值/其他一律 false）；validateSsoConfig 把 public 当生产边界告警。
验收：public+任意 NODE_ENV+dev → 无 proof 必 401；production/staging/空值+dev → false；仅显式 development/test 且非 public 走 dev actor。负向测试全补。

## F3 [P1] sso-strict.route.test.ts:42-75 "真实网关"用例是进程内模拟，部署假设未验收
client 带正确 secret + 任意 username 即被当网关（服务端无法区分）；网关 strip client 同名 header、BFF 端口网络隔离均为部署依赖无证据。
修法：① 测试改名去掉"真实网关"误导，明确标模拟；② runbook 增加真实网关四项集成验收清单（client 伪造两 header 被剥离/已登录注入真实 username/绕网关被挡/BFF 非网关网络不可达），标注留 lead 生产实测且为翻 strict 硬前置；③ 文档评估静态共享 secret 信任根（若不可接受列 mTLS/时效签名为 G2.1b 后续项，不在本单实现）。
验收：文档/测试不再宣称已验"header 仅网关注入"；翻 strict 前置清单含真实网关证据项。

## F4 [P2] owner.ts:141-145 secret 比较非恒时
修法：两侧 SHA-256 digest 后 crypto.timingSafeEqual；.env.example 注明 secret 最小长度/轮换建议。
验收：不再直接 ===；等长/异长错误均 false；单测覆盖。

## F5 [P2] owner.ts:214-219 onError 破坏默认错误语义（origin/main 无 onError）
非 SsoAuthError 被静默（默认 Hono 会 console.error + 保留 HTTPException.getResponse）。sol 复现 consoleErrors 1→0。
修法：SsoAuthError 分支外精确复刻默认语义（保留 getResponse、console.error 普通错误、同 500 文本），或改用 Hono HTTPException 表达 401 避免全局接管。
验收：普通 Error 的 response+日志与基线一致；HTTPException 自定义状态保留；SsoAuthError 仍 401 JSON。

## F6 [P2] app.ts:97-110 "全部持久化路由"注释漏 debug-logs 写盘端点
/api/mivo/debug-logs POST 持久写 JSONL，strict 不校验 proof。
修法：二选一——strict 下 debug POST 也要 gateway proof；或明确 telemetry 为 system-scoped 并独立防护（rate/quota/审计），修正注释与 route inventory。附全 route security matrix（每个 stateful route 标 owner-scoped/token-scoped/system-scoped + 对应测试）。
验收：matrix 齐全；所选方案有测试。
