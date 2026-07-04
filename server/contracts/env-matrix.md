# BFF 启动契约 — 环境变量矩阵

> 源:`vite.config.ts` defineConfig L1617-L1629 + 模块级常量(L9/L138/L257/L409)。
> P1-c BFF 必须复刻这些 env 的语义(默认值 / 必填性 / 生效端点)。
> 标注 `dev` = 当前 dev middleware 读取;`P1-c/d 新增` = 计划 §6.1 列出但 dev middleware 尚未实现,BFF 需新增。

## dev middleware 现有 env

| 变量 | 默认值 | 必填性 | 生效端点 | 备注 |
|------|--------|--------|---------|------|
| `MIVO_IMAGE_API_KEY` | `''` | llm-proxy 路径必填 | generate(llm-proxy)/ edit(llm-proxy) | `readImageApiKey` L192-L196,空则抛 `MIVO_IMAGE_API_KEY is not set` → 500 |
| `MIVO_LLM_API_KEY` | `''` | enhance 必填(否则降级) | enhance | L1621:**fallback 到 `MIVO_IMAGE_API_KEY`**;两者皆空 → enhance 返回 200 `{enhanced:false,degradedReason:'no-key'}`(L1312-L1315) |
| `MIVO_PLATFORM_KEY` | `''` | 平台通道必填 | generate(平台模型)/ edit(无 mask 平台模型) | L1623;必须以 `mivo_` 开头(L885/L962),否则 500 `MIVO_PLATFORM_KEY 未配置...`。与 llm-proxy `sk-` key 严格分离(只 Node 层读,不进 bundle) |
| `MIVO_PLATFORM_ENDPOINT` | `https://aigc.xindong.com` | 可选 | 平台通道 | L1624;去尾斜杠。token/chat/submit/poll/signUrl/upload 都走此 base |
| `MIVO_ASSET_DIR` | `~/Desktop/Images` → `~/Desktop/images` | 可选 | local-assets(列表+文件) | L137-L148;多候选按顺序取第一个存在的;都不存在则返回空列表 |
| `MIVO_EAGLE_API_URL` | `http://127.0.0.1:41595` | 可选 | eagle/* | L9 模块级;不可达时 status 返回 `{connected:false,...}`,其余 502/404 |
| `MIVO_DEBUG_LOG_DIR` | `<cwd>/data/debug-logs` | 可选 | debug-logs POST/GET | L257;JSONL 按日文件 `<date>.jsonl` |
| `MIVO_DEBUG_VIEW_TOKEN` | `''`(未设) | 可选 | debug-logs GET | L409;**未设 = GET 开放**(L410 `return true`);设了则必须 header `x-mivo-debug-token` 或 query `?token=` 携带 |

## P1-c/d 新增(BFF 启动契约,dev middleware 无)

> 计划 §6.1 §6.2 列出。dev middleware 不读这些;BFF 必须实现。

| 变量 | 默认 | 必填性 | 生效 | 备注 |
|------|------|--------|------|------|
| `MIVO_BFF_TOKEN` | `''` | 公网必填 | 访问门(全部端点) | 缺省=dev/prod 全兼容;设了则裸请求 401。`Authorization: Bearer <token>` 或 `X-Mivo-Bff-Token: <token>` header 携带(实现见 `server/app.ts:40-51`);**禁止进前端 bundle** |
| `MIVO_ENABLE_LOCAL_ASSETS` | `false`(prod) | 可选 | local-assets | 生产默认关(读服务器本机文件=泄露面);启用需 localhost 绑定或管理 token |
| `MIVO_ENABLE_EAGLE_PROXY` | `false`(prod) | 可选 | eagle/* | 同上;生产默认关 |
| `VITE_MIVO_DEBUG_ENDPOINT` | — | 客户端 | (前端 remoteDebugReporter) | `VITE_` 前缀=进 bundle;仅前端用,非 middleware env |

> V08 契约漂移修正:① 删除已不存在的 `MIVO_API_MODE` 行(P1-d 回滚阀已下线,BFF 不再读);② token 携带方式修正为 header(`server/app.ts` 读 `Authorization`/`X-Mivo-Bff-Token`,不经 cookie);③ 以下 env 在 `server/lib/config.ts`(`getEnvConfig()`)或 `server/index.ts`/`server/lib/env.ts` 集中读取,原矩阵遗漏,补遗如下。

## BFF config.ts / 启动期 env(矩阵补遗)

| 变量 | 默认 | 读取位置 | 用途 |
|------|------|----------|------|
| `MIVO_PORT` | `8080` | `server/index.ts:9` | BFF 监听端口 |
| `MIVO_PUBLIC` | 未设=`''` | `server/index.ts:10`/`server/lib/env.ts:26`/`server/routes/debug-logs.ts:37` | `=1` 监听 `0.0.0.0`(公网)并强制 `MIVO_BFF_TOKEN`,否则 `127.0.0.1`;同时收紧 debug-logs GET(无 view token → 403) |
| `MIVO_DEBUG_ALLOWED_ORIGINS` | localhost | `server/routes/debug-logs.ts:47` | debug-logs POST origin allowlist(CORS);逗号分隔 |
| `MIVO_DEBUG_POST_RATE_LIMIT` | `60` | `server/routes/debug-logs.ts:40` | debug-logs POST 每 IP 每分钟上限 |
| `MIVO_EAGLE_TIMEOUT_MS` | 内置 | `server/lib/eagle.ts:13` | eagle 代理请求超时 |
| `MIVO_IMAGE_API_BASE` | `https://llm-proxy.tapsvc.com/v1/images` | `server/lib/config.ts:83` | llm-proxy 图片生成/编辑 endpoint |
| `MIVO_LLM_API_BASE` | `https://llm-proxy.tapsvc.com/v1` | `server/lib/config.ts:84` | llm-proxy enhance endpoint |
| `MIVO_UPSTREAM_TIMEOUT_MS` | `240000` | `server/lib/config.ts:86` | 上游 generate 总超时 |
| `MIVO_EDIT_UPSTREAM_TIMEOUT_MS` | `180000` | `server/lib/config.ts:87` | 上游 edit 总超时 |
| `MIVO_ENHANCE_PRIMARY_TIMEOUT_MS` | `8000` | `server/lib/config.ts:88` | enhance 主模型超时 |
| `MIVO_ENHANCE_FALLBACK_TIMEOUT_MS` | `8000` | `server/lib/config.ts:89` | enhance fallback 超时 |
| `MIVO_PLATFORM_POLL_INTERVAL_MS` | `2500` | `server/lib/config.ts:97` | 平台任务轮询间隔 |
| `MIVO_PLATFORM_POLL_DEADLINE_MS` | `0`(覆盖) | `server/lib/config.ts:72` | 平台轮询截止(同时覆盖 1K/2K);`0` 走分分辨率默认 |
| `MIVO_PLATFORM_POLL_DEADLINE_1K_MS` | `240000` | `server/lib/config.ts:74` | 1K 分辨率轮询截止 |
| `MIVO_PLATFORM_POLL_DEADLINE_2K_MS` | `300000` | `server/lib/config.ts:75` | 2K 分辨率轮询截止 |
| `MIVO_IMAGE_REQUEST_MAX_BYTES` | `41943040` | `server/lib/config.ts:100` | 图片(multipart)请求体上限 |
| `MIVO_JSON_REQUEST_MAX_BYTES` | `1048576` | `server/lib/config.ts:99` | JSON 请求体上限 |
| `MIVO_VARIATIONS_CONCURRENCY` | `4` | `server/lib/config.ts:102` | 变体批并发上限(e2e 可降到 1 强制串行) |

## key 分离不变量

- `MIVO_PLATFORM_KEY`(`mivo_` 前缀)与 `MIVO_IMAGE_API_KEY`/`MIVO_LLM_API_KEY`(`sk-` 前缀,llm-proxy)**严格分离**:平台 key 只在 Node 层(vite middleware / BFF)读取,绝不进客户端 bundle。CI 应断言 bundle 无真实 key。
- `MIVO_LLM_API_KEY` 缺失时 fallback 到 `MIVO_IMAGE_API_KEY`(L1621)——BFF 必须保持此 fallback 语义。

## 生产安全模型(默认收紧)

- `local-assets` / `eagle/*`:生产默认 404/403(`MIVO_ENABLE_*` 默认 false)。e2e 断言"prod 默认不可用,显式启用后才可用"。
- `debug-logs` GET:生产必须配 `MIVO_DEBUG_VIEW_TOKEN`(dev 默认开放是 gap,见 debug-logs.json discrepancy)。
- `debug-logs` POST:生产限 origin/rate/body(dev 无 origin 限制,见 debug-logs.json discrepancy)。
- BFF 默认 bind `127.0.0.1`;`MIVO_PUBLIC=1` 才监听公网且强制 `MIVO_BFF_TOKEN`。
