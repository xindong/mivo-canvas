# MivoCanvas BFF (server/)

基于 Hono + `@hono/node-server` 的独立 BFF:同源托管 `dist/` 静态产物、`/healthz` 探活、`/api/mivo/*` 全量端点(P1-c 已从 `vite.config.ts` dev middleware 平移完生成组 / debug-logs / 资产组)。

## 启动

```bash
# 1. 先构建前端产物(server/ 同源托管 dist/)
npm run build

# 2. 启动 BFF(默认 127.0.0.1:8080)
npm run start:server
```

启动后日志形如:

```
[mivo-bff] listening on http://127.0.0.1:8080 [local 127.0.0.1, open (no MIVO_BFF_TOKEN)]
```

### dev 接线(P1-d)

`vite.config.ts` 现有双模式开关:

| 变量 | 默认 | 作用 |
|------|------|------|
| `MIVO_API_MODE` | `bff` | `bff`=`npm run dev` 通过 `server.proxy` 转发 `/api/mivo/*` 到本地 BFF; `dev-middleware`=继续走 `vite.config.ts` 里旧 middleware |
| `MIVO_BFF_DEV_URL` | `http://127.0.0.1:${MIVO_PORT:-8080}` | `bff` 模式下 Vite proxy 的目标地址; 未设时跟随 `MIVO_PORT` 推导 |

推荐的本地开发编排(两个终端):

```bash
# 终端 A: BFF(API)
MIVO_PORT=8080 npm run start:server

# 终端 B: 前端 dev server(默认 bff 模式)
MIVO_API_MODE=bff npm run dev
```

回滚到旧开发链路(不删 middleware,只改一个 env):

```bash
MIVO_API_MODE=dev-middleware npm run dev
```

生产部署 / 容器示例见 [docs/bff-deployment.md](../docs/bff-deployment.md)。

请求日志(服务端 stdout,只记方法/路径/状态/上游 tag/latency,**禁记 API key / 原图 blob / 完整 prompt**):

```
[mivo-bff] rid=550e8400-... POST /api/mivo/generate -> 200 upstream=ok latency=847ms
```

## 环境变量

### 启动 / 访问门

| 变量 | 默认 | 作用 |
|------|------|------|
| `MIVO_PORT` | `8080` | 监听端口 |
| `MIVO_PUBLIC` | 未设置 | 设为 `1` 时监听 `0.0.0.0`(公网);**此时强制要求 `MIVO_BFF_TOKEN`,否则启动即退出** |
| `MIVO_BFF_TOKEN` | 未设置 | 访问门 token。未设置=门禁关闭(本地开放);设置后除 `/healthz` 外所有请求必须携带 token |

Token 携带二选一:`Authorization: Bearer <token>` 或 `X-Mivo-Bff-Token: <token>`。`/healthz` 始终免鉴权。未授权 → `401 {"error":"unauthorized"}`(脱敏,不回显 token)。

> 访问门=内部门禁/防滥用,非用户鉴权(真实鉴权 P4 对接 mivoserver)。

### 上游密钥(dev middleware 同款)

| 变量 | 默认 | 生效端点 |
|------|------|---------|
| `MIVO_IMAGE_API_KEY` | `''` | generate(llm-proxy)/ edit(llm-proxy) |
| `MIVO_LLM_API_KEY` | fallback 到 `MIVO_IMAGE_API_KEY` | enhance(两者皆空 → `200 {enhanced:false,degradedReason:'no-key'}`) |
| `MIVO_PLATFORM_KEY` | `''` | generate/edit 平台通道(必须 `mivo_` 前缀,否则 `500 MIVO_PLATFORM_KEY 未配置…`) |
| `MIVO_PLATFORM_ENDPOINT` | `https://aigc.xindong.com` | 平台通道 base(去尾斜杠) |

### 测试专用覆盖(默认与 dev 一致,仅供测试改小)

> 这些 env 让 240s/180s/175s 等长超时与远端上游可在本地 mock 测试覆盖。**生产不要设**。

| 变量 | 默认 | 作用 |
|------|------|------|
| `MIVO_IMAGE_API_BASE` | `https://llm-proxy.tapsvc.com/v1/images` | llm-proxy 图像 base(generate/edit) |
| `MIVO_LLM_API_BASE` | `https://llm-proxy.tapsvc.com/v1` | llm-proxy chat base(enhance) |
| `MIVO_UPSTREAM_TIMEOUT_MS` | `240000` | generate llm-proxy 超时 → 504 |
| `MIVO_EDIT_UPSTREAM_TIMEOUT_MS` | `180000` | edit llm-proxy 超时 → 504 |
| `MIVO_ENHANCE_PRIMARY_TIMEOUT_MS` | `8000` | enhance 主模型超时(claude-haiku-4-5) |
| `MIVO_ENHANCE_FALLBACK_TIMEOUT_MS` | `8000` | enhance 兜底模型超时(gpt-5.4-mini) |
| `MIVO_PLATFORM_POLL_DEADLINE_MS` | `175000` | 平台 poll 上限 → 504 |
| `MIVO_PLATFORM_POLL_INTERVAL_MS` | `2500` | 平台 poll 间隔 |
| `MIVO_JSON_REQUEST_MAX_BYTES` | `1048576` | JSON body 上限 → 413(D1:干净 413,非 ECONNRESET) |
| `MIVO_IMAGE_REQUEST_MAX_BYTES` | `41943040` | multipart body 上限 → 413 |

## 端点(P1-c 生成组)

| 端点 | 方法 | 行为 |
|------|------|------|
| `GET /healthz` | GET | `200 {"status":"ok"}`,免鉴权 |
| `POST /api/mivo/generate` | POST(非 POST → 405) | 模型分流:gemini-3-pro-image / gpt-image-2 → 平台 submit→poll→download;其余 → llm-proxy。平台失败不回落。JSON 1MB→413;上游 240s→504 |
| `POST /api/mivo/edit` | POST(multipart,非 POST → 405) | 无 mask + 平台模型 → 平台(主图 index 0);有 mask 或非平台模型 → llm-proxy gpt-image-2。multipart 40MB→413;上游 180s→504;上传失败固定 502 脱敏 |
| `POST /api/mivo/enhance` | POST(非 POST → 405) | 降级链 claude-haiku-4-5(8s) → gpt-5.4-mini(8s);无 key → `200 {enhanced:false,degradedReason:'no-key'}`;双失败 → `200 {enhanced:false,degradedReason}`;从不 5xx |
| `GET/POST /api/mivo/debug-logs` | GET/POST | POST 记录远端 debug 日志; GET 读取最近记录。保留 token gate / 过滤 / 默认 7 天窗口; D1/D7/D8 见 `server/contracts/debug-logs.json` |
| `ALL /api/mivo/local-assets` | ALL(dev 兼容,无 method guard) | 本地图像列表; 本地模式默认开,`MIVO_PUBLIC=1` 时默认关,可用 `MIVO_ENABLE_LOCAL_ASSETS=1` 显式打开 |
| `ALL /api/mivo/local-assets/:id` | ALL | 本地图像文件读取; symlink escape 用 realpath 守卫; 403/404 明文错误的 `text/plain` header 属 framework diff |
| `ALL /api/mivo/eagle/*` | ALL(dev 兼容,无 method guard) | Eagle 状态 / 文件夹 / 标签 / 资产 / 缩略图 / 原图; 本地模式默认开,`MIVO_PUBLIC=1` 时默认关,可用 `MIVO_ENABLE_EAGLE_PROXY=1` 显式打开 |
| `ALL /api/mivo/pinterest/status` | ALL | 固定占位 `{connected:false,mode:'prototype'}` |
| `/*` | GET | serveStatic(`dist/`)+ SPA history fallback |

每个响应带 `X-Request-Id` header(uuid),服务端日志同步 rid。

## 目录结构

```
server/
├── app.ts              # Hono app:healthz + 访问门 + 全量 /api/mivo 路由 + serveStatic + SPA fallback
├── index.ts            # 入口:bind + 公网守卫 + serve()(app 在 app.ts,测试可单独 import)
├── routes/
│   ├── generate.ts     # POST /api/mivo/generate
│   ├── edit.ts         # POST /api/mivo/edit
│   ├── enhance.ts      # POST /api/mivo/enhance + helpers(system prompt / parse / normalize)
│   ├── debug-logs.ts   # GET/POST /api/mivo/debug-logs
│   ├── local-assets.ts # /api/mivo/local-assets*
│   ├── eagle.ts        # /api/mivo/eagle/*
│   └── pinterest.ts    # /api/mivo/pinterest/status
├── platform/
│   ├── state.ts        # 内存 token/chatSession 缓存 + 单飞 + 401 authRetry(mivoPlatformFetch)
│   └── job.ts          # channels + submit/poll/download/upload + runMivoPlatformImageJob
├── lib/
│   ├── config.ts       # 静态模型表 + getEnvConfig()(惰性读 env,测试可覆盖)
│   ├── upstream.ts     # fetchUpstreamWithTimeout / readUpstreamError / 错误类
│   ├── images.ts       # normalizeMivoImages / resolveRatioPayload / normalizeMivoQuality
│   └── request.ts      # readBodyWithLimit(干净 413)/ readJsonBody / parseMultipartBody / requestId / logRequest
├── __tests__/
│   ├── mockUpstream.ts # 本地 fixture server(平台 + llm-proxy mock)
│   └── p1c.test.ts     # mock 测试(平台链/401 重试/单飞/超时/4xx5xx/413/降级…)
└── contracts/          # P1-b 契约基线 + capture + live diff 套件
```

## 测试

```bash
# 单元 + mock(默认,无 LIVE)
npm run test:unit

# 仅 P1-c mock 套件
npx vitest run server/__tests__/p1c.test.ts

# live 契约 diff(对 BFF)
MIVO_PORT=18080 npm run start:server &
npm run contract:diff -- --target=http://127.0.0.1:18080

# live 契约基线(对 dev middleware → 临时 vite dev server,脚本强制 MIVO_API_MODE=dev-middleware)
npm run contract:diff -- --target=dev
```

## 有意变更(相对 dev middleware,各带测试)

| # | 项 | dev 现状 | BFF 改为 | 测试 |
|---|----|---------|---------|------|
| D1 | body 超限 413 可观测性 | `request.destroy()` 拆 socket → 客户端 ECONNRESET | `readBodyWithLimit` 流式上限抛 `RequestBodyTooLargeError` → 干净 413 | `p1c.test.ts` generate/edit 413 用例 |
| D11 | enhance L1352 stale 注释 | 注释 "kimi-k2.6 10s" 与常量不符 | 迁移用常量 + 修正注释(claude-haiku-4-5 @ 8s) | 注释在 `routes/enhance.ts` |

**未改(平移保 diff=0)**:D9(无平台 key 仍 `500`+原文案)、D6(方法语义 405)、错误 shape(`{error}` / `{ok,error}` / 上游透传)、降级链语义、poll 2.5s/175s、单飞/401 重试一次/不回落。

## 类型检查

`server/`(含 `__tests__`、`contracts`)由 `tsconfig.server.json` 纳入 `tsc -b` 项目引用,`noEmit`,不污染前端 bundle。

## 回滚

P1-d 不删 `vite.config.ts` middleware。回滚 dev 接线只需:

```bash
MIVO_API_MODE=dev-middleware npm run dev
```

如需连带撤销 P1-c BFF 路由代码,再另行 `git revert` 对应提交。
