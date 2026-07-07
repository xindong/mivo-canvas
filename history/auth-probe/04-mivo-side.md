# MivoCanvas 登录鉴权接入 — 落地侧现状底图

> 双仓只读探底 | 产出时间: 2026-07-07 19:00 GMT+8
> 仓库A (maker): `/Users/praise/AI-Agent/Claude/projects/Project XDMaker`
> 仓库B (目标): `/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas`
> 每条结论带 file:line 证据,标注所属仓库(`[Mivo]` / `[Maker]`)。

---

## 1. MivoCanvas 现有鉴权面 — BFF access gate

### 1.1 认证方案(三种,任一匹配即放行)

`server/app.ts` 的 access gate 在 `app.use('*', ...)` 中间件里统一处理(`[Mivo] server/app.ts:77-91`):

| 方案 | 提取位置 | 说明 |
|------|---------|------|
| Bearer Token | `[Mivo] server/app.ts:54-56` | `Authorization: Bearer <token>`,程序化客户端 |
| HTTP Basic Auth | `[Mivo] server/app.ts:42-52` | `Authorization: Basic <base64("user:pw")>`,取密码部分作 token(PR #136/#144) |
| 自定义 Header | `[Mivo] server/app.ts:82` | `X-Mivo-Bff-Token: <token>`,程序化客户端 |

- 提取函数 `extractBearerToken()`: `[Mivo] server/app.ts:39-59`
  - Basic 分支: base64 解码后按**第一个冒号**分割,取冒号后部分作 token(`:47-49`),username 被忽略(注释 `:31-35`)
  - 未知 scheme 整个 header 忽略(`:57-58`)
- 比较用 `timingSafeEqual` 防时序攻击: `[Mivo] server/app.ts:24-29`
- 401 响应带 `WWW-Authenticate: Basic realm="mivo-canvas"`,触发浏览器原生登录框: `[Mivo] server/app.ts:87`

### 1.2 配置来源

| 环境变量 | 读取位置 | 行为 |
|---------|---------|------|
| `MIVO_BFF_TOKEN` | `[Mivo] server/app.ts:78` | 未设置 → gate 完全 no-op(本地开发默认无鉴权);设置 → 除 `/healthz` 外所有路由必带凭证 |
| `MIVO_PUBLIC` | `[Mivo] server/lib/env.ts:25` | 部署模式标志,影响 local-assets / eagle 代理默认值 |

### 1.3 路由覆盖范围

- **受保护**: 除 `/healthz` 外全部请求(`[Mivo] server/app.ts:77-91`),含 `/api/mivo/*` 与静态资源/SPA fallback
- **豁免**: `/healthz`(`[Mivo] server/app.ts:66` 与 `:80`)
- **没有按路由分级**: gate 是 `app.use('*', ...)`,全量拦截;没有"公开读 / 鉴权写"分层

### 1.4 测试覆盖

`[Mivo] server/__tests__/access-gate.test.ts`: 覆盖 Bearer / Basic 正确与错误密码 / 自定义 header / 缺 token / healthz 豁免等场景。

> **小结**: access gate 是**单一共享 token** 模式(`MIVO_BFF_TOKEN`),不是 per-user 鉴权。它解决"公网部署别被随便访问"的问题,不解决"哪个用户在用"的问题。Basic Auth 分支的存在纯粹是为了让浏览器 GET / 时能弹原生登录框(`:71-76` 注释)。

---

## 2. BFF → mivo 平台调用链(凭证怎么走)

### 2.1 凭证分层

BFF 调 mivo 用**两层凭证**,都从环境变量读,硬编码在服务端:

```
MIVO_PLATFORM_KEY  ─→ platformCtx.platformKey   (换 session token)
MIVO_PLATFORM_ENDPOINT ─→ platformCtx.platformEndpoint
MIVO_IMAGE_API_KEY ─→ imageApiKey   (llm-proxy 生图/编辑)
MIVO_LLM_API_KEY   ─→ llmApiKey     (enhance, fallback 到 IMAGE_API_KEY)
```

读取集中点: `[Mivo] server/lib/config.ts:75-102`(`getEnvConfig()`)

### 2.2 Mivo 平台 token 生命周期(核心文件 `server/platform/state.ts`)

| 步骤 | 函数 | 位置 | 说明 |
|------|------|------|------|
| 读 platformKey | — | `[Mivo] server/lib/config.ts:80` | `process.env.MIVO_PLATFORM_KEY` |
| 换 session token | `mivoPlatformRefreshToken()` | `[Mivo] server/platform/state.ts:38-56` | POST `${endpoint}/api/v1/state/token`,body 里 `sub: ctx.platformKey`(`:44`) |
| 单飞缓存 | `mivoPlatformEnsureToken()` | `[Mivo] server/platform/state.ts:58-66` | 模块级变量 `mivoPlatformToken` + `mivoPlatformTokenPromise` 防并发(`:19-22`) |
| Bearer 注入 + 401 重试 | `mivoPlatformFetch()` | `[Mivo] server/platform/state.ts:94-111` | `Authorization: Bearer ${token}`(`:101`);401 → 清缓存重刷重试一次(`:103-108`) |

> **关键**: 这层 token 是**服务端单例缓存**,与最终用户无关。所有用户共享同一个 platformKey 换来的 session token。模块级状态意味着水平扩展需换共享存储(`:2-4` 注释已标注 P4 待办)。

### 2.3 所有调 mivo 平台的位置

统一走 `mivoPlatformFetch()`(`[Mivo] server/platform/state.ts:94-111`),实际调用点在 `server/platform/job.ts`:

| 操作 | 位置 | 方法 | 端点 |
|------|------|------|------|
| 提交 job | `[Mivo] server/platform/job.ts:~163` | POST | `/api/v1/message` |
| 轮询 job | `[Mivo] server/platform/job.ts:~233` | GET | `/api/v1/message/{jobId}` |
| 下载(signUrl) | `[Mivo] server/platform/job.ts:~298` | GET | `/api/v1/file/signUrl/{fileId}` |
| 上传参考图 | `[Mivo] server/platform/job.ts:~334` | POST | `/api/v1/file/` |

### 2.4 llm-proxy 调用点(另一路凭证)

| 路由 | 调用点 | 端点 | 凭证 |
|------|--------|------|------|
| `/api/mivo/generate` | `[Mivo] server/routes/generate.ts:~98` | `/generations` | `Bearer ${imageApiKey}` |
| `/api/mivo/edit` | `[Mivo] server/routes/edit.ts:~148` | `/edits` | `Bearer ${imageApiKey}` |
| `/api/mivo/enhance` | `[Mivo] server/routes/enhance.ts:~191` | `/chat/completions` | `Bearer ${llmApiKey}` |

### 2.5 "mivo MCP api key" 要替换/注入的位置

如果未来要把现在硬编码的 `MIVO_PLATFORM_KEY` / `MIVO_IMAGE_API_KEY` 改成"按登录用户注入的 mivo MCP api key",改动点:

1. **platformKey 来源**: `[Mivo] server/lib/config.ts:80` — 从 `process.env` 改为按请求/用户解析
2. **platformCtx 构造**: `[Mivo] server/routes/generate.ts:~49` 与 `edit.ts:~54` — 把 platformCtx 从全局单例改成 per-request(携带用户 key)
3. **token 缓存键**: `[Mivo] server/platform/state.ts:19-22` 的模块级单例要改成按 key 分桶(否则多用户会串 token)
4. **token 注入**: `[Mivo] server/platform/state.ts:101` 的 `Authorization: Bearer ${token}` — token 本身由 platformKey 换得,改 key 即可,这行不用动
5. **imageApiKey 注入**: `[Mivo] server/routes/generate.ts:~98` / `edit.ts:~148` / `enhance.ts:~191` 的 `Bearer ${imageApiKey}` — 改成 per-user key

> 注意 maker 侧 mivo key 的格式正是 `mivo_*` 前缀(`[Mivo] server/platform/state.ts:34` 的 sanitize 正则印证),与 `MIVO_PLATFORM_KEY` 同一概念。

---

## 3. MivoCanvas 前端现状(身份 / 设置 / 登录墙挂点)

### 3.1 用户身份概念 — 完全缺失

- Zustand store 无 user/auth/identity slice: `src/store/` 下只有 canvasStore / chatStore / documentSlice / generationSlice / projectsSlice 等业务 slice
- HTTP 客户端无鉴权头: `[Mivo] src/lib/mivoTaskClient.ts` 仅发 `Content-Type` + `Idempotency-Key`,无 Authorization(`:~132-133`)
- IndexedDB 仅存画布文档: `[Mivo] src/lib/persistIdbStorage.ts`(DB名 `mivo-canvas-persist`,`:~28`),无 token / 用户信息
- localStorage 仅 `mivo.sidebar.collapsedProjects`: `[Mivo] src/app/sidebar/useCollapsedProjects.ts`
- 类型系统无 User/Session/Auth 类型: `[Mivo] src/types/mivoCanvas.ts`

> **结论**: 前端是匿名无状态使用方式,零鉴权基础设施。

### 3.2 设置界面雏形 — UI 框架在,逻辑是 stub

- 设置菜单项定义: `[Mivo] src/app/ProjectSidebar.tsx:53-84` — 5 项(Preferences / Appearance / Keyboard shortcuts / Theme / Help and feedback)
- 菜单渲染区: `[Mivo] src/app/ProjectSidebar.tsx:354-481`(`.settings-area` section,含 Changelog / Debug Log / Settings 按钮 + 菜单)
- 点击处理: `[Mivo] src/app/ProjectSidebar.tsx:~150-152` — `handleSettingsMenuItem` 只 `debugLogger.warn('Settings', '${label} is not implemented yet')`,全是 stub
- 菜单展开状态: `[Mivo] src/app/ProjectSidebar.tsx`(`settingsOpen` useState,`:~470-480`)

> 可直接把 settingsMenuItems 里某一项改成"登录/账户"入口,或把整个 Settings 按钮升级为 modal SettingsPanel。

### 3.3 可挂登录墙的位置

| 位置 | 文件:行 | 适配度 |
|------|--------|--------|
| 全局入口(最早阻截) | `[Mivo] src/main.tsx:~19-33` | ★★★★★ — root 挂载前检查认证,未登录渲染 LoginPage |
| App hydration 后 | `[Mivo] src/App.tsx:~213-215`(`if (!hydrated) return 占位`) | ★★★★☆ — Zustand 重水合后、UI 挂载前插登录门,UX 友好 |
| 侧栏 header(用户卡片/登出) | `[Mivo] src/app/ProjectSidebar.tsx:~220-234` | ★★☆☆☆ — 仅适合放用户菜单,不适合登录墙 |

### 3.4 前端 → BFF 通信模式

- 直接 fetch 相对路径,无统一 client / 无 baseURL env: `[Mivo] src/lib/mivoTaskClient.ts:~126-154`(`/api/mivo/tasks/{generate,edit,variations}`)、`[Mivo] src/lib/mivoImageClient.ts`(`/api/mivo/image`)
- 无 `VITE_API_BASE_URL` 之类变量;同源部署,BFF 即 origin
- 挂鉴权头的位置:在 `mivoTaskClient` / `mivoImageClient` 的 fetch header 里加 `Authorization: Bearer ${token}`,或新建 `src/lib/authClient.ts` 统一注入

### 3.5 侧栏扩展参考(PR #142)

PR #142 把 maker 项目目录管理复刻到侧栏,模式可复用做"账户/设置"持久化:
- 纯派生 model: `[Mivo] src/app/sidebar/projectSidebarModel.ts`(`buildSidebarModel`)
- 折叠持久化 hook: `[Mivo] src/app/sidebar/useCollapsedProjects.ts`(localStorage + React hook)
- 主侧栏容器: `[Mivo] src/app/ProjectSidebar.tsx`

---

## 4. maker 侧(仓库A)— mivo key 管理 / 飞书 OAuth / 可被 BFF 调用的 API

### 4.1 mivo key 凭证管理现状

**存储(双轨,但 server 端未启用):**

- Desktop 本地 only(Electron safeStorage,OS keychain 加密):
  - 读取: `[Maker] apps/desktop/src/main/mcp-integrations/mivo.ts:39-44`(`readMivoApiKey()`)
  - 底层: `[Maker] apps/desktop/src/main/secrets/providerSecretStore.ts:~126-135`
  - 键名映射: `[Maker] apps/desktop/src/shared/providerSecrets.ts:~30`(`'mivo' → 'mivo_api_key'`)
- Server 端(已实现但**未被调用**): Prisma User 表 `encryptedMivoApiKey` 字段,AES-256-GCM 加密
  - 服务层: `[Maker] apps/server/src/services/mivoApiKeySync.ts:~23-67`(`saveMivoApiKey` / `readMivoApiKey` / `removeMivoApiKey`)

**隐私设计**: mivo key 只存本地 safeStorage,不同步服务器,新设备需本机重填 — `[Maker] apps/desktop/src/renderer/hooks/useMivoApiKey.ts:~4-9` 注释明示

### 4.2 maker server 的 mivo key HTTP API(已就位,可直接被 MivoCanvas BFF 调用)

路由文件: `[Maker] apps/server/src/routes/mivoApiKeySync.ts`

| 方法 | 路径 | 入参 | 出参 | 鉴权 |
|------|------|------|------|------|
| PUT | `/api/users/me/mivo-api-key` | `{ mivoApiKey: string }` | `{ saved: true }` | JWT Bearer(`authenticate`) |
| GET | `/api/users/me/mivo-api-key` | — | `{ mivoApiKey: string \| null }` | JWT Bearer |
| DELETE | `/api/users/me/mivo-api-key` | — | `{ removed: true }` | JWT Bearer |

- 路由注册(挂 authenticate + per-user 限流): `[Maker] apps/server/src/app.ts:133-140`
- 服务层用 `req.user!.id` 作 userId(`[Maker] apps/server/src/routes/mivoApiKeySync.ts:19,29,39`)

> **关键发现**: 这套 API 要求**调用方持 maker 的 JWT access token**。MivoCanvas BFF 不能拿自己的服务凭证直接调,必须代表某个已登录用户调(用户在 maker 登录拿到的 JWT 透传过来)。即 MivoCanvas 要么自己走 maker 的飞书登录链拿 JWT,要么让用户在 MivoCanvas 里贴 maker 的 token。

### 4.3 maker 鉴权栈(飞书 OAuth + JWT)

- 框架: Express + Prisma(`[Maker] apps/server/src/app.ts`)
- 飞书 OAuth + JWT 颁发,路由文件: `[Maker] apps/server/src/routes/auth.ts`,挂载: `[Maker] apps/server/src/app.ts:116`(`app.use('/api/auth', authRouter)`)

| 方法 | 路径 | 入参 | 出参 | 鉴权 |
|------|------|------|------|------|
| GET | `/api/auth/callback` | `?code=&state=` | 302 → `xdmaker://auth?...` | 无(移动端 OAuth 回调) |
| POST | `/api/auth/login` | `{code, codeVerifier, deviceId, clientType}` | `{accessToken, refreshToken, user, feishuAccessToken, feishuRefreshToken, migration}` | 无(IP 限流 20/min) |
| POST | `/api/auth/dev-login` | — | 同 login | `XDT_DEV_AUTH_ENABLED=1` 时才开放(`[Maker] apps/server/src/routes/auth.ts:~111`,`config.ts:164`) |
| POST | `/api/auth/refresh` | `{refreshToken, deviceId}` | `{accessToken, refreshToken, preferences, migration}` | 无(IP 限流 60/min) |
| POST | `/api/auth/refresh-feishu` | `{feishuRefreshToken}` | Feishu token | JWT |
| POST | `/api/auth/logout` | `{deviceId}` | `{success: true}` | JWT |

- JWT 签发: `[Maker] apps/server/src/services/auth.ts:~122`(`signAccessToken({sub, device})`),refresh token 哈希存 DB(`:~123-130`)
- 认证中间件: `[Maker] apps/server/src/middleware/authenticate.ts`(验 Bearer,填 `req.user`)
- 飞书 OAuth env: `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_REDIRECT_URI`(`[Maker] apps/server/src/config.ts:59-64`,均 `requireEnv`)

### 4.4 maker 与 mivo 平台的集成(MCP 通道)

- MCP 工厂: `[Maker] packages/lizi-mcps/src/mivo/service.ts:~29-76`
  - 懒加载 MivoClient,按 api-key 值缓存
  - `getApiKey: readMivoApiKey`(`:~125`,来自 desktop safeStorage)
  - 端点硬编码 `https://aigc.xindong.com`(`:~33`)— 与 MivoCanvas 默认 `MIVO_PLATFORM_ENDPOINT` 同一地址
  - token 缓存: `userData/lizi-mivo/tokens/`
- MCP 工具集: `[Maker] packages/lizi-mcps/src/mivo/tools/`(genImage / gen3d / genVideo / genMusic / pollResult 等)

> maker 与 MivoCanvas 调的是**同一个 mivo 平台**(`aigc.xindong.com`),都用 `mivo_*` 格式的 platform key。maker 的 key 来自用户本机 safeStorage,MivoCanvas 的 key 来自 `.env.local`。

---

## 5. 环境变量 / 配置清单(两边对照)

### 5.1 MivoCanvas 侧

`.env.local` 实存 5 行(`[Mivo] .env.local:1-5`): `MIVO_IMAGE_API_KEY` / `MIVO_PLATFORM_KEY` / `MIVO_PLATFORM_ENDPOINT` / `MIVO_PORT` / `MIVO_EDIT_UPSTREAM_TIMEOUT_MS`

`server/lib/config.ts:75-102` 读取的全部 env:

| env | 行 | 必填 | 用途 |
|-----|----|----|------|
| `MIVO_IMAGE_API_KEY` | `:75` | ✅ | 图像 API key(生成/编辑) |
| `MIVO_LLM_API_KEY` | `:76` | ❌ | LLM key(fallback 到 IMAGE_API_KEY) |
| `MIVO_PLATFORM_KEY` | `:77` | ✅ | 平台 key(`mivo_*`) |
| `MIVO_PLATFORM_ENDPOINT` | `:78` | ❌ | 默认 `https://aigc.xindong.com` |
| `MIVO_IMAGE_API_BASE` | `:80` | ❌ | 默认 `https://llm-proxy.tapsvc.com/v1/images` |
| `MIVO_LLM_API_BASE` | `:81` | ❌ | 默认 `https://llm-proxy.tapsvc.com/v1` |
| `MIVO_UPSTREAM_TIMEOUT_MS` / `EDIT_*` / `ENHANCE_*` | `:82-85` | ❌ | 超时 |
| `MIVO_PLATFORM_POLL_DEADLINE_*` | `:72-75,96` | ❌ | 轮询超时(按分辨率分级) |
| `MIVO_PLATFORM_POLL_INTERVAL_MS` | `:96` | ❌ | 轮询间隔(默认 2500) |
| `MIVO_JSON_REQUEST_MAX_BYTES` / `IMAGE_REQUEST_MAX_BYTES` | `:97-98` | ❌ | body 大小限制 |
| `MIVO_VARIATIONS_CONCURRENCY` | `:102` | ❌ | 变体并发(默认 4) |

特性开关(`[Mivo] server/lib/env.ts`): `MIVO_PUBLIC`(`:25`)、`MIVO_ENABLE_LOCAL_ASSETS`(`:26`)、`MIVO_ENABLE_EAGLE_PROXY`(`:26`)
BFF 鉴权: `MIVO_BFF_TOKEN`(`[Mivo] server/app.ts:78`)— `.env.local` 里**未配置**,故当前本地开发 gate 是 no-op

### 5.2 maker (XDMaker) 侧

`apps/server/.env.example` 鉴权相关:

| env | 用途 |
|-----|------|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_REDIRECT_URI` | 飞书 OAuth(`config.ts:59-64` requireEnv) |
| `JWT_SECRET`(raw) | JWT 签名(`config.ts:68` requireEnv) |
| `JWT_ACCESS_EXPIRES` / `JWT_REFRESH_EXPIRES_DAYS` | token 过期(`config.ts:96,98`) |
| `API_KEY_ENC_SECRET` | mivo key AES-256-GCM 加密密钥(`config.ts:123`) |
| `XDT_DEV_AUTH_ENABLED` | 开 `/api/auth/dev-login`(`config.ts:164`) |
| `DATABASE_URL` | Prisma(`config.ts:69`) |

其他: OSS / Slack / Jira / GitHub App / Skill Hub S2S 等(与本任务无直接关系)。

### 5.3 两边重叠

- **完全不重叠**: MivoCanvas 用 `MIVO_*` 族(13 个),maker 用 `FEISHU_*` / `JWT_*` / `API_KEY_ENC_SECRET` 族
- **共享概念但独立**: 两边都调 `aigc.xindong.com`,都认 `mivo_*` key,但各自管各自的 key 来源(maker 用户本机 / MivoCanvas 服务端 env)

---

## 6. 接入点建议

### 6.1 登录鉴权应该挂在 MivoCanvas 哪些代码点

**方案 A — 复用 maker 飞书登录(推荐,统一身份)**:

1. **前端登录墙**: `[Mivo] src/main.tsx:~19-33` 或 `src/App.tsx:~213-215` 挂登录守卫,未登录渲染 LoginPage;LoginPage 走 maker 的 `/api/auth/login`(`[Maker] apps/server/src/routes/auth.ts:73`)拿 JWT access token
2. **前端 token 存储**: 新建 `src/store/userSlice.ts` + `src/lib/authClient.ts`,token 存 localStorage(参考 `[Mivo] src/app/sidebar/useCollapsedProjects.ts` 的 localStorage 模式)
3. **前端鉴权头注入**: `[Mivo] src/lib/mivoTaskClient.ts:~132-133` 与 `src/lib/mivoImageClient.ts` 的 fetch header 加 `Authorization: Bearer ${userJwt}`
4. **BFF access gate 扩展**: `[Mivo] server/app.ts:77-91` — 现在只认 `MIVO_BFF_TOKEN`;扩展为也认用户 JWT(可调 maker `/api/auth/refresh-feishu` 或自验 JWT,需 maker 共享 `JWT_SECRET`)。或在 gate 之上加一层新中间件把 `req.user` 注入到 platformCtx
5. **账户入口 UI**: `[Mivo] src/app/ProjectSidebar.tsx:~456-480` 的 Settings 区,加"账户/登出"项;或 `[Mivo] src/app/ProjectSidebar.tsx:~220-234` header 加用户卡片

**方案 B — MivoCanvas 自建鉴权(独立于 maker)**: 自己接飞书 OAuth,自己颁 JWT。重造 maker 已有的轮子,不推荐。

### 6.2 两个 key 的存储与注入建议

MivoCanvas 涉及两个 key 概念,别混淆:

| key | 是什么 | 现状 | 建议存储 | 建议注入点 |
|-----|-------|------|---------|-----------|
| **① 用户登录凭证**(maker JWT access token) | 用户身份,调 maker API 用 | 无 | 前端 localStorage + 服务端短期缓存 | 前端: `mivoTaskClient` header;BFF: 透传给 maker `/api/users/me/mivo-api-key` |
| **② mivo 平台 key**(`mivo_*`,即"Mivo MCP api key") | 调 mivo 生图用,等价于现在的 `MIVO_PLATFORM_KEY` | `[Mivo] .env.local:2` 全局共享 | **per-user**:从 maker `/api/users/me/mivo-api-key` GET 拿(`[Maker] apps/server/src/routes/mivoApiKeySync.ts:27`),服务端 per-request 缓存(替换 `[Mivo] server/platform/state.ts:19-22` 的全局单例) | `[Mivo] server/routes/generate.ts:~49` 与 `edit.ts:~54` 构造 platformCtx 时用用户 key;token 缓存键按 userId 分桶 |

> **关键取舍**: 现在的 `MIVO_PLATFORM_KEY` 是"团队共享一把 key",改成 per-user 后,`server/platform/state.ts:19-22` 的模块级 token 单例必须改成 `Map<userId, tokenPromise>`,否则多用户会串 token(单飞语义会缓存第一个用户的 token 给所有人用)。`MIVO_IMAGE_API_KEY` 同理,`generate/edit/enhance` 路由里的 `Bearer ${imageApiKey}` 要改成 per-user。
>
> **退路**: 若短期不做 per-user,MivoCanvas BFF 也可直接复用 maker server 的 mivo key API — 让用户在 MivoCanvas 设置面板里填一次 key,BFF 透传给 maker `PUT /api/users/me/mivo-api-key` 存储,后续 GET 取用。这样 key 的真值只落在 maker DB(已 AES-256-GCM 加密),MivoCanvas 不落地。

### 6.3 最小化上线路径(三步)

1. `[Mivo] src/main.tsx` / `src/App.tsx`:挂登录墙,走 maker `/api/auth/login` 拿 JWT
2. `[Mivo] src/lib/mivoTaskClient.ts:~132`:注入 `Authorization: Bearer ${userJwt}`;`[Mivo] server/app.ts:77-91`:gate 扩展认 JWT
3. `[Mivo] server/platform/state.ts` + `routes/generate.ts:~49`:platformCtx 改 per-user,key 来源从 `.env.local` 切到 maker `GET /api/users/me/mivo-api-key`

---

## 附:鉴权/凭证相关文件清单

**MivoCanvas 侧**:
- `[Mivo] server/app.ts` — access gate
- `[Mivo] server/__tests__/access-gate.test.ts` — gate 测试
- `[Mivo] server/lib/config.ts` — env 读取
- `[Mivo] server/lib/env.ts` — 特性开关
- `[Mivo] server/platform/state.ts` — mivo token 缓存/注入(核心)
- `[Mivo] server/platform/job.ts` — 平台调用实现
- `[Mivo] server/routes/{generate,edit,enhance}.ts` — 路由 + 凭证注入
- `[Mivo] src/lib/mivoTaskClient.ts` / `mivoImageClient.ts` — 前端 HTTP client(无鉴权)
- `[Mivo] src/app/ProjectSidebar.tsx` — 设置入口/可挂账户 UI

**maker 侧**:
- `[Maker] apps/server/src/routes/auth.ts` — 飞书 OAuth + JWT 登录
- `[Maker] apps/server/src/services/auth.ts` — JWT 签发
- `[Maker] apps/server/src/middleware/authenticate.ts` — JWT 验证
- `[Maker] apps/server/src/routes/mivoApiKeySync.ts` — mivo key CRUD API
- `[Maker] apps/server/src/services/mivoApiKeySync.ts` — mivo key AES 加解密
- `[Maker] apps/desktop/src/main/mcp-integrations/mivo.ts` — 本地 mivo key 读取
- `[Maker] packages/lizi-mcps/src/mivo/service.ts` — mivo MCP 工厂
