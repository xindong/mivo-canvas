# G2.1 返修复审 REQUIRES_CHANGES（第二轮，lead+sol3 共识，2026-07-12）
F2/F3/F4 已 CLOSED 别动。四条如下（复审方均有独立复现，lead 抽核 #2/#4 属实）。

## R2-1 [P1][F1] 启动 gate 只覆盖 persist backend，permission/asset 域可被绕过
assertStrictOwnerMigrationComplete 只收 PersistBackend；share_links.created_by 与 AssetRecord.ownerFp/references/uploaders 只有 runbook 文字 checkbox。persist=0 但 permission/asset 全 legacy 时 gate 放行。G2.2 若只补 PG persist detector 即可绕过其余两域。
修法：gate 改为三域共同判定——接收 persist+permissions+assets 三 backend（或统一 migration receipt），任一 detector 缺失即 fail-closed；.env.example/runbook"机械检测"措辞随之修正为三域。
验收：补测试"persist=0、permission>0 → 拒启动""persist=0、asset>0 → 拒启动""任一 detector 缺失 → 拒启动"；首轮验收的 seed 四表+asset→迁移→strict 可见 场景至少以打桩迁移函数落一条端到端测试；不可映射 no-go 测试。

## R2-2 [P1] strict proof 非最前置边界：存在性 oracle + 未鉴权先解析
strict+无 proof：已存 project GET=401、未知=404（存在性泄漏）；非法 body POST=400、tasks multipart/mask 处理先于 401（未鉴权消耗昂贵解析）。根因：projects.ts:112-127 / tasks.ts:42-244 / projectAuthz.ts:40-62 / canvas.ts:104-124 都先查 owner/读 body 再 resolveActor。
修法：owner-scoped 且无 share token 的路由，strict 模式下在任何 body 解析/DB lookup 前统一验 proof（middleware 或 authz 入口前置分支）；token-scoped 分支显式豁免。
验收：strict 无 proof 下 known/missing/invalid/oversized body/各 task POST 一律 401，且断言 parser/backend 未被调用（spy/计数）。route matrix 的覆盖标注修正（现为假阳性）。

## R2-3 [P2][F5] Option A 复刻不精确（结构化 getResponse + header 合并缺失）
Hono 默认走 `"getResponse" in err` duck-type + `c.newResponse(res.body,res)`（保留 pre-error c.header）；现实现 instanceof HTTPException + 直接 return，丢 structural HTTPResponseError 与上下文 header。且零 parity 测试。
修法：优先改 Option B（SsoAuthError extends HTTPException 走默认 handler，401 JSON 契约用 res 构造保持）；坚持 A 则按结构化 duck-type + c.newResponse 精确复刻。两者都必须加参数化 parity 测试（普通 Error / HTTPException / structural HTTPResponseError × 默认 vs custom，含 pre-error header 保留），Hono 升级漂移时测试报警。

## R2-4 [P2][F6] debug-logs 独立防护不成立（XFF 绕过已复现）
rate key 取客户端可控 XFF 首项（rate=1 时轮换 XFF 三连 200）；无 Origin 无条件放行；rateBuckets 无淘汰（内存增长）；JSONL 无磁盘 quota/retention；生产 Origin 未要求配置。
修法（保持 system-scoped 的话）：rate key 改可信来源（要求网关覆盖/清洗 XFF 并写进网关验收清单，或用 remote addr）+ bucket 淘汰 + 磁盘 quota/retention；生产 MIVO_DEBUG_ALLOWED_ORIGINS 配置列入硬前置；或 strict prod POST 直接要求 gateway proof（dev 豁免）。二选一并测试。
