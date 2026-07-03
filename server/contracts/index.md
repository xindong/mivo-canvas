# 覆盖矩阵 — 端点 × 场景(来源标注)

> L = live-captured(有 `__captures__/<name>.json` 快照);C = code-derived(附行号)。
> ⚠ = 与计划 §6.1 不符或 BFF 应主动改的项(详见各契约 JSON 的 `discrepancy` 字段)。

## /api/mivo/generate(generate.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| 非常方法 → 405 | L | generate-405 | |
| 缺 prompt → 400 | L | generate-400-no-prompt | |
| JSON >1MB → 413 意图 / ECONNRESET 实测 | L | generate-413 | ⚠ request.destroy 拆 socket |
| 平台模型无 key → 500 | L | generate-500-no-platform-key | ⚠ config 错误 500 + 泄 env 名 |
| llm-proxy 模型无 image key → 500 | L | generate-500-no-image-key | ⚠ 同上 |
| 200 平台通道 | C | | |
| 200 llm-proxy 兜底 | C | | |
| 平台 poll 超时 → 504(175s) | C | | |
| llm-proxy 上游超时 → 504(240s) | C | | |
| 平台 failed → 502 | C | | |
| 平台 download 空/失败 → 502 | C | | |
| 上游 4xx/5xx 透传 | C | | |
| 不回落不变量 | C | | |

## /api/mivo/edit(edit.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| 非常方法 → 405 | L | edit-405 | |
| 缺 image → 400 | L | edit-400-no-image | |
| 缺 prompt → 400 | L | edit-400-no-prompt | |
| multipart >40MB → 413 / ECONNRESET | L | edit-413 | ⚠ 同 generate-413 |
| 平台路径无 key → 500 | L | edit-500-no-platform-key | |
| 上传失败 → 502 脱敏 | C | | |
| 200 平台(无 mask) | C | | |
| 200 llm-proxy(mask/非平台) | C | | |
| llm-proxy 超时 → 504(180s) | C | | |
| 上游 4xx/5xx 透传 | C | | |
| 平台超时/失败(共享 runner) | C | | |

## /api/mivo/enhance(enhance.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| 非常方法 → 405 | L | enhance-405 | |
| 无 key → 200 `{enhanced:false,degradedReason:'no-key'}` | L | enhance-200-no-key | |
| 缺 prompt → 400(需 key) | C | | |
| JSON >1MB → 413(需 key;无 key 早返回) | C | | ⚠ 无 key 时不可触发 |
| 200 generate 模式 | C | | |
| 200 chat 模式 | C | | |
| 双模型失败 → 200 degraded | C | | |
| 超时语义 8s+8s | C | | ⚠ 计划写"客户端 30s"实为客户端,middleware 无 30s |
| stale 注释 | C | | ⚠ L1352 注释与常量不符 |

## /api/mivo/debug-logs(debug-logs.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| PUT/DELETE → 405 | L | debug-logs-405 | |
| POST 200 `{ok,accepted}` | L | debug-logs-post-200 | |
| POST 过滤 log 级(drop,accepted=2) | L | debug-logs-post-filter-level | |
| POST 脱敏 | C+vitest | | |
| POST >1MB → 413 / ECONNRESET | L | debug-logs-post-413 | ⚠ request.destroy |
| POST 非法 JSON → 400 | L | debug-logs-post-400 | |
| POST origin 限制 | C | | ⚠ dev 无 origin 限制 |
| GET 未设 token → 200 开放 | C | | ⚠ 开放=生产风险 |
| GET 设 token 无携带 → 403 | L | debug-logs-get-403 | |
| GET header token → 200 | L | debug-logs-get-200-header-token | |
| GET query token → 200 | L | debug-logs-get-200-query-token | |
| GET 默认近 7 天 / limit cap 1000(默认 200) | C | | ⚠ 计划漏写默认 200 |
| GET 过滤 level/clientId/sessionId/q | C+vitest | | |
| GET receivedAt desc 排序 | C | | |

## /api/mivo/local-assets(+文件)(local-assets.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| 列表 200(空根) | C | | |
| 列表 200(有资产) | L | local-assets-list-200 | |
| 文件 200(image/svg+xml, no-store) | L | local-assets-file-200 | |
| 路径越权 → 403 | L | local-assets-file-403-traversal | ⚠ lexical 非 realpath;无 Content-Type |
| 文件不存在 → 404 | L | local-assets-file-404 | |
| stat 错误 → 500 | C | | |
| 非常方法 → 同 200(无 405) | L | local-assets-list-post-200 | ⚠ 无 405 |

## /api/mivo/eagle/*(eagle.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| status 离线 → 200 `{connected:false,...}` | L | eagle-status-offline | |
| folders 离线 → 502 plain text | L | eagle-folders-502 | ⚠ 无 Content-Type |
| tags 离线 → 502 plain text | L | eagle-tags-502 | ⚠ 无 Content-Type |
| assets 离线 → 502 plain text | L | eagle-assets-502 | ⚠ 无 Content-Type |
| :id/thumbnail → 200 SVG fallback | L | eagle-assets-thumbnail-svg-fallback | |
| :id/file 离线 → 404 plain text | L | eagle-assets-file-404 | ⚠ 无 Content-Type |
| 无上游超时 | C | | ⚠ BFF 必须补超时(计划已标有意变更) |
| SSRF 边界(host 固定) | C | | |
| 非常方法 → 同 200(无 405) | C | | ⚠ 无 405 |
| 错误 shape 不一致 | C | | ⚠ status=JSON / 其余=plain text |

## /api/mivo/pinterest/status(pinterest-status.json)

| 场景 | 来源 | capture | ⚠ |
|------|------|---------|---|
| GET 200 占位 | L | pinterest-status-200 | |
| 非常方法 → 同 200(无 405) | L | pinterest-status-post-200 | ⚠ 无 405 |

## 平台通道 helpers(platform-helpers.json,内部非路由)

| 可测项 | 来源 | ⚠ |
|--------|------|---|
| token 单飞 | C | P1-c 需 mock platform 单测 |
| chatSession 单飞 | C | P1-c 需 mock platform 单测 |
| 401 → 刷 token → 只重试一次 | C | P1-c 需 mock platform 单测 |
| submit/poll/signUrl/upload/chat 统一 authRetry | C | |
| 上传失败 502 脱敏 | C | |
| 不回落不变量 | C | |
| poll 循环语义(2.5s/175s) | C | |
| download signUrl 解析 | C | |

## 汇总

- **live-captured**:33 个快照(`__captures__/`)。
- **code-derived**:~30 个场景(真实生成/LLM/平台/超时/单飞逻辑,不可安全实测)。
- **discrepancy(⚠)**:11 类,见下表。

## ⚠ 与计划 §6.1 不符 / BFF 应改项(给 lead 修正计划的重要输入)

| # | 项 | 现状 | 计划/期望 | 影响 |
|---|----|------|----------|------|
| D1 | body-limit 413 可观测性 | `request.destroy()` 拆 socket → 客户端 ECONNRESET | 干净 413 | BFF 必须发干净 413(generate/edit/debug-logs 三处) |
| D2 | local-assets 路径越权校验 | `isInsideRoot` 用 `path.resolve`(lexical),非 `fs.realpath` | 计划写"realpath 校验" | 符号链接可逃逸;BFF 应用 realpath |
| D3 | local-assets 403 无 Content-Type | plain text,无 header | 与 JSON 错误 shape 一致 | BFF 保持或统一(单列有意变更) |
| D4 | eagle 错误 shape 不一致 | status=JSON / folders·tags·assets=502 plain text / file=404 plain text,多数无 Content-Type | 计划"错误 shape 同上"未覆盖 eagle | P1-c 保持原样(不引入新 envelope),BFF 统一为后续 PR |
| D5 | eagle 无上游超时 | `requestJson`/`fetch` 无 timeout | 计划"BFF 补默认超时" | BFF 必须补(计划已标有意变更) |
| D6 | 非常方法无 405(local-assets/eagle/pinterest) | 任意方法返回 200 | 计划"统一 405 需列为有意变更" | BFF 可加 405(单列有意变更);generate/edit/enhance/debug-logs 已有 405 |
| D7 | debug-logs POST 无 origin 限制 | dev 无 origin 检查 | 计划"POST 限 origin/rate/body" | BFF 必须加 origin 门(生产安全) |
| D8 | debug-logs GET 未设 token = 开放 | `if(!token) return true` | 生产必须配 token | 生产安全风险;BFF 生产强制 token |
| D9 | generate/edit 无平台 key → 500 | 500 + 泄露 env 名 | 计划未指定 | BFF 可改 503 + 脱敏(单列有意变更) |
| D10 | enhance "客户端 30s" | middleware 无 30s(每级 8s) | 计划 §6.1 写"客户端 30s" | "客户端 30s"是 chatStore 客户端,middleware 契约=8s+8s;计划措辞需澄清 |
| D11 | enhance L1352 stale 注释 | 注释"kimi-k2.6 10s",实际 claude-haiku-4-5 8s | 计划 §6.1 与常量一致 | 迁移看常量不看注释;建议清理注释 |
