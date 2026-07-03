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
| `MIVO_BFF_TOKEN` | `''` | 公网必填 | 访问门(全部端点) | 缺省=dev/prod 全兼容;设了则裸请求 401。header 或 cookie 携带;**禁止进前端 bundle** |
| `MIVO_API_MODE` | `bff` | 可选 | dev 接线开关 | `dev-middleware` 回退到原 vite middleware(P1-d 回滚阀) |
| `MIVO_ENABLE_LOCAL_ASSETS` | `false`(prod) | 可选 | local-assets | 生产默认关(读服务器本机文件=泄露面);启用需 localhost 绑定或管理 token |
| `MIVO_ENABLE_EAGLE_PROXY` | `false`(prod) | 可选 | eagle/* | 同上;生产默认关 |
| `VITE_MIVO_DEBUG_ENDPOINT` | — | 客户端 | (前端 remoteDebugReporter) | `VITE_` 前缀=进 bundle;仅前端用,非 middleware env |

## key 分离不变量

- `MIVO_PLATFORM_KEY`(`mivo_` 前缀)与 `MIVO_IMAGE_API_KEY`/`MIVO_LLM_API_KEY`(`sk-` 前缀,llm-proxy)**严格分离**:平台 key 只在 Node 层(vite middleware / BFF)读取,绝不进客户端 bundle。CI 应断言 bundle 无真实 key。
- `MIVO_LLM_API_KEY` 缺失时 fallback 到 `MIVO_IMAGE_API_KEY`(L1621)——BFF 必须保持此 fallback 语义。

## 生产安全模型(默认收紧)

- `local-assets` / `eagle/*`:生产默认 404/403(`MIVO_ENABLE_*` 默认 false)。e2e 断言"prod 默认不可用,显式启用后才可用"。
- `debug-logs` GET:生产必须配 `MIVO_DEBUG_VIEW_TOKEN`(dev 默认开放是 gap,见 debug-logs.json discrepancy)。
- `debug-logs` POST:生产限 origin/rate/body(dev 无 origin 限制,见 debug-logs.json discrepancy)。
- BFF 默认 bind `127.0.0.1`;`MIVO_PUBLIC=1` 才监听公网且强制 `MIVO_BFF_TOKEN`。
