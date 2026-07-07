# XDMaker 飞书登录端到端流程探底报告

> 仓库：`/Users/praise/AI-Agent/Claude/projects/Project XDMaker`（pnpm monorepo）
> 路径前缀：相对 XDMaker 根。例 `apps/desktop/src/main/authManager.ts:748` = `authManager.ts:748`
> 模式：只读探底，未修改任何源文件。
> 日期：2026-07-07

## 0. 一图概览

```
[Renderer: LoginPage 按钮]
   │ useLogin → useAuth → authService(薄 IPC 壳)
   │ ipcRenderer.invoke('auth:login')
   ▼
[Main: authManager.login()]
   │ 1. 生成 PKCE(code_verifier/code_challenge S256) + state
   │ 2. new BrowserWindow → loadURL(accounts.feishu.cn/.../authorize)
   │ 3. webContents 'will-redirect' 拦截 REDIRECT_URI，取 code+state，关窗
   │ 4. POST SERVER_URL/api/auth/login  body={code, codeVerifier, deviceId, clientType:'desktop'}
   ▼
[Server: routes/auth.ts POST /api/auth/login]
   │ 5. authService.login → exchangeCodeForToken(code, codeVerifier)
   │    → POST open.feishu.cn/.../authen/v2/oauth/token (grant_type=authorization_code,
   │       client_id+client_secret+code+code_verifier+redirect_uri)
   │ 6. getFeishuUserInfo(feishuAccessToken) → /authen/v1/user_info → open_id/name/avatar/email
   │ 7. prisma.user.upsert(by feishuId=open_id)
   │ 8. signAccessToken(JWT HS256, sub=userId, device=deviceId, exp=1h)
   │ 9. generateRefreshToken → hashToken → prisma.refreshToken.upsert(by userId+deviceId)
   │ 10. 返回 {accessToken, refreshToken, user, feishuAccessToken, feishuRefreshToken,
   │          feishuExpiresIn, grantedScopes, migration}
   ▼
[Main: authManager.login() 续]
   │ 11. accessToken(主 JWT) → 内存模块级变量
   │ 12. app refreshToken → safeStorage 加密文件 refresh_token.enc
   │ 13. feishu AT → 内存(lizi-mcps FeishuService);feishu RT → safeStorage feishu_refresh_token.enc
   │ 14. scheduleRefresh(JWT.exp - 300s)
   │ 15. broadcastToRenderers('auth:state-change', {user, isAuthenticated, migration, deviceId})
   ▼
[Renderer: AuthContext] 更新 user/isAuthenticated/migration/deviceId
```

---

## 1. 登录入口 UI

- 登录页组件：`apps/desktop/src/renderer/components/login/LoginPage.tsx:9`
  - 单按钮「飞书登录」(`login.feishuLogin` 文案)，`onClick=handleLogin`：`LoginPage.tsx:55-77`
  - DEV 模式额外渲染「本地模拟登录」按钮(`showDevLogin = import.meta.env.DEV`)：`LoginPage.tsx:79-97`
  - 无扫码、无 QR。飞书侧是标准 OAuth authorize 跳转，由用户在弹出的 BrowserWindow 内完成飞书账号登录与授权勾选。
- 入口 hook：`apps/desktop/src/renderer/hooks/useLogin.ts:13`
  - `handleLogin` → `useAuth().login`；`handleDevLogin` → `useAuth().devLogin`：`useLogin.ts:60-66`
  - 错误码映射：`USER_CANCELLED / STATE_MISMATCH / FEISHU_AUTH_FAILED / FEISHU_UNAVAILABLE / FEISHU_SCOPE_INCOMPLETE / NETWORK_ERROR / SERVICE_UNAVAILABLE`：`useLogin.ts:27-51`
- AuthContext：`apps/desktop/src/renderer/contexts/AuthContext.tsx:49`
  - `AuthProvider` 在 `App.tsx` 中位于 `RouterProvider` 之外，故不用 `useNavigate`，路由分发下沉到 `<MigrationGate/>`：`AuthContext.tsx:25-33`
  - `login/devLogin` 调 `authServiceRef.current.login()` 后 set user/isAuthenticated/migration：`AuthContext.tsx:150-162`
  - session 过期监听 `window.electronAPI.onAuthSessionExpired` → 弹确认框 → 清 state：`AuthContext.tsx:130-148`
- authService(渲染进程侧只是薄 IPC 壳)：`apps/desktop/src/renderer/lib/authService.ts:72`
  - 注释明确：「all auth logic (token management, refresh scheduling, OAuth window, PKCE) lives in the main process authManager」：`authService.ts:68-71`
  - `login()` = `window.electronAPI.authLogin()` → 抛 `ApiError(result.code, statusCode, message)`：`authService.ts:99-108`

## 2. 飞书 OAuth/授权完整链路

### 2.1 前端发起（主进程）
- `authManager.login(parentWindow)`：`apps/desktop/src/main/authManager.ts:702`
- PKCE 生成（Node crypto，S256）：`authManager.ts:234-241`、调用点 `authManager.ts:708-709`
- 构造 authorize URL，`client_id=VITE_FEISHU_APP_ID`，`redirect_uri=SERVER_URL+/api/auth/callback`，`response_type=code`，`state`，`code_challenge`，`code_challenge_method=S256`，`scope` 一大串(含 `offline_access` + docx/bitable/wiki/drive/im/calendar/contact/minutes/vc/task 等)：`authManager.ts:711-720`
- authorize 端点：`https://accounts.feishu.cn/open-apis/authen/v1/authorize`：`authManager.ts:720`
- `SERVER_URL` 默认 `http://localhost:3333`（`VITE_API_BASE_URL` 覆盖）：`authManager.ts:40`
- `REDIRECT_URI = SERVER_URL + '/api/auth/callback'`：`authManager.ts:42`

### 2.2 OAuth 弹窗 + 回调拦截
- `openOAuthWindow(parentWindow, authUrl, expectedState)`：`authManager.ts:292-341`
  - `new BrowserWindow({width:600,height:740, modal:false, webPreferences:{nodeIntegration:false, contextIsolation:true}})`：`authManager.ts:298-308`
  - 关键：监听 `webContents.on('will-redirect')` 与 `'will-navigate'`，**当 URL 以 `REDIRECT_URI` 开头时拦截**，从 URL 解析 `state`/`code`，校验 `state===expectedState`，然后 `authWindow.close()`：`authManager.ts:313-327`
  - 即：桌面端**不让请求真正打到 server 的 `/api/auth/callback`**，而是在 BrowserWindow 内截获重定向、取出 code 后直接关窗，再由主进程显式 POST `/api/auth/login`。Server 的 `/callback` GET 路由是为 mobile 准备的（见 §4）。
  - 关窗/Escape/浏览器后退的输入兜底：`installOAuthWindowInputFallbacks` `authManager.ts:343-376`
- 拿到 `code` 后：`POST /api/auth/login`，body `{ code, codeVerifier, deviceId, clientType: 'desktop' }`：`authManager.ts:730-734`

### 2.3 服务端换取凭证
- 路由：`apps/server/src/routes/auth.ts:73`（`POST /api/auth/login`，pre-auth IP 限流 20/min）
- 服务端 login：`apps/server/src/services/auth.ts:69`
  1. `exchangeCodeForToken(code, codeVerifier, {allowMissingRefreshToken: isMobileClient})`：`services/auth.ts:78`。desktop 严格校验 refresh_token + 全量 scope；mobile 放宽。
  2. `exchangeCodeForToken` 实现：`apps/server/src/services/feishu.ts:191`
     - `POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`，body `{grant_type:'authorization_code', client_id, client_secret, code, code_verifier, redirect_uri}`：`feishu.ts:198-212`、端点常量 `feishu.ts:40`
     - `redirect_uri` 用 `config.feishu.redirectUri`（env `FEISHU_REDIRECT_URI`）：`feishu.ts:206`、`config.ts:78`
     - 返回 `{accessToken, refreshToken, expiresIn, scope}`（飞书 user_access_token / refresh_token）：`feishu.ts:283-289`
  3. scope 完整性校验（仅 desktop）：`findMissingRequiredScopes(grantedScopes, isMobileClient)`，缺失抛 `feishuScopeIncomplete`：`services/auth.ts:93-97`
  4. `getFeishuUserInfo(feishuToken.accessToken)` → `GET https://open.feishu.cn/open-apis/authen/v1/user_info` (Bearer) → `{open_id, name, avatar_url, email}`：`feishu.ts:291-330`
  5. `prisma.user.upsert({where:{feishuId: userInfo.openId}, ...})`：`services/auth.ts:101-120`。**`user.feishuId` 存的是飞书 open_id**（`authManager.ts:55-67` 注释明确）
  6. `signAccessToken({sub: user.id, device: deviceId})` — 主 app JWT(HS256, 1h)：`services/auth.ts:122`、`apps/server/src/lib/jwt.ts:9-16`
  7. app refresh token：`generateRefreshToken()` + `hashToken()` + `prisma.refreshToken.upsert(by {userId, deviceId})`，过期 `refreshExpiresDays`(默认 365 天)：`services/auth.ts:123-131`、`config.ts:133-134`
  8. 返回 `LoginResult`：`{accessToken, refreshToken, user, feishuAccessToken, feishuRefreshToken, feishuExpiresIn, grantedScopes, migration}`：`services/auth.ts:157-178`

### 2.4 拿到的凭证汇总
| 凭证 | 用途 | 颁发方 | 桌面端存储位置 |
|---|---|---|---|
| `accessToken`（主 JWT） | 调 XDMaker server 所有受保护 API | XDMaker server（HS256） | 主进程内存（`authManager.ts:159`） |
| `refreshToken`（app） | 续主 JWT | XDMaker server | safeStorage 加密文件 `refresh_token.enc`（`authManager.ts:749` / `208-222`） |
| `feishuAccessToken` | 调飞书数据 API（IM/Bot/日历等，用户身份） | 飞书 | 内存（lizi-mcps FeishuService） |
| `feishuRefreshToken` | 续飞书 user token | 飞书 | safeStorage `feishu_refresh_token.enc`（`feishu.ts:17,41-59`） |
| `grantedScopes` | 客户端自校验授权完整性 | 飞书 | 内存（随 login 响应丢弃，不持久化） |
| `user{id,name,avatar,email,feishuId,role,isCanary,...}` | 身份展示 | XDMaker server | 主进程 `currentUser` + 广播给 renderer |

## 3. 登录成功后 session/身份的建立、存储、过期、刷新、登出

### 3.1 建立（main）
- `accessToken` 置模块级变量：`authManager.ts:748`
- `writeSafe('refresh_token', refreshToken)`：`authManager.ts:749`
- `getFeishuService().token.storeFeishuToken({accessToken, refreshToken, expiresIn})`：`authManager.ts:770-774`
- `getFeishuService().token.setJwt(accessToken)` — 把主 JWT 同步给 feishu service，使其 401 时能触发 `onJwtRefreshNeeded`：`authManager.ts:777`、回调定义 `feishu.ts:130`
- `scheduleRefresh(accessToken)`：`authManager.ts:779`
- `getProviderSecretStore().reconcileOwner(user.id)` — 换账号清旧 provider key：`authManager.ts:782`
- `notifyRenderer()` + `notifyAuthListeners()`：`authManager.ts:783-784`

### 3.2 存储（逐项）
- 主 JWT：**仅内存**，不落盘。冷启动靠 refresh 重建。
- app refreshToken：**safeStorage 加密文件** `userData/safe-storage/refresh_token.enc`（`authManager.ts:194-222`）。`safeStorage` = Electron 提供的 OS keychain 加密（macOS Keychain / Windows DPAPI / Linux secret-service）。
- 飞书 RT：safeStorage `feishu_refresh_token.enc`（`feishu.ts:17,21-67`）。
- 飞书 AT：内存。
- deviceId：`machineIdSync()`（或 `XDT_DEVICE_ID_OVERRIDE` 覆盖），非鉴权凭证，仅同账号下区分设备：`authManager.ts:163-170`

### 3.3 过期与刷新
- `scheduleRefresh(token)`：解析 JWT `exp`，`delay = (exp - 300) * 1000 - Date.now()`，到点调 `refresh()`；`delay<=0` 立即刷新：`authManager.ts:380-398`。提前 5 分钟。
- `refresh()`：`authManager.ts:833`
  - `POST /api/auth/refresh` body `{refreshToken, deviceId}`，`timeoutMs:0`（token-rotating 端点不设超时，避免 abort 后用旧 token 重试导致永久登出）：`authManager.ts:845-849`
  - 服务端 `services/auth.ts:237`：`hashToken` 查库 → 校验 `deviceId` 一致 → 校验未过期 → **删旧 token + 生成新 token + 写库（轮换）** → 新 JWT → 返回 `{accessToken, refreshToken, preferences, migration}`：`services/auth.ts:241-311`
  - 失败分类（`authRefreshFailure.ts`）：确定性凭据失效(`INVALID_REFRESH_TOKEN` / `REFRESH_TOKEN_EXPIRED` / `DEVICE_MISMATCH` / 410 等) → `clearAuth` + `notifySessionExpired`；瞬时失败(429/5xx/断网) → 60s 后重排 `scheduleRefreshRetryAfterTransientFailure`：`authManager.ts:410-415,850-865`
- 冷启动 `initialize()`：`authManager.ts:560`
  - 已登录快路径（内存命中）直接返回，零网络：`authManager.ts:568-575`
  - relogin marker（自动更新后强制重登）→ 清持久化 token：`authManager.ts:582-592`
  - 读 `refresh_token.enc` → `runRefreshWithTransientRetry` → 成功则 `writeSafe` 轮换 + `setJwt` + `GET /api/user/me` 拿 user → `scheduleRefresh`：`authManager.ts:594-689`
- 系统休眠恢复：`handleResume()`，JWT 剩余 <5min 则 refresh：`authManager.ts:921-933`、注册点 `bootstrap-electron.ts:4075`
- 飞书 token 刷新：`POST /api/auth/refresh-feishu`（受 `authenticate` 保护 + per-user 限流 30/min），body `{feishuRefreshToken}` → `refreshFeishuTokenForUser` → `refreshFeishuToken`（先 v2 端点，失败回退 v1 `/authen/v1/refresh_access_token` 带 app_access_token）：`routes/auth.ts:149-163`、`services/auth.ts:320-345`、`feishu.ts:332-547`

### 3.4 登出
- 渲染端 `useAuth().logout` → IPC `auth:logout`：`authService.ts:121-123`
- 主进程 IPC handler 在调 `authManager.logout()` **之前**先做一堆 teardown（顺序敏感）：`bootstrap-electron.ts:2292-2357`
  - cancel skillhub in-flight、resetScheduler、stopEmbeddingHost、resetChatEmbedderCache、resetLearnController、`releaseDeviceLinkOwnershipBeforeLogout`、`lifecycleDbClientManager.dispose('logout')`（关闭本地用户 DB）、然后才 `authManager.logout()`
- `authManager.logout()`：`authManager.ts:894`
  - `closeLocalDb()` → `clearAuth()` → 若有 `currentAccessToken` 则 `POST /api/auth/logout` body `{deviceId}`（fire-and-forget `.catch(()=>{})`）：`authManager.ts:901-914`
- `clearAuth()`：清内存 AT/currentUser/migration、清 refreshTimer、`removeSafe('refresh_token')`、`canaryFlagStore.clear()`、`getFeishuService().token.clearFeishuTokens()`、并清 Google/Jira/Slack 等 MCP 的 OAuth state：`authManager.ts:492-521`
  - **provider key（XD/Mivo key）不在登出时清**——同账号重登保留，换账号由 `reconcileOwner` 处理：`authManager.ts:502-505`
- 服务端 `services/auth.ts:313`：`prisma.refreshToken.deleteMany({userId, deviceId})`
- session 过期推送：`notifySessionExpired` → renderer `onAuthSessionExpired` → 弹「登录已过期」确认 → 清 state 回登录页：`authManager.ts:454-456`、`AuthContext.tsx:130-148`

## 4. 服务端在登录流程中的角色与端点

Server（`apps/server`，Express，端口默认 3333）扮演**飞书 token 交换 + 用户入库 + 主 JWT 颁发 + refresh token 轮换**的 BFF 角色。飞书 `client_secret` 只在 server 侧（`config.feishu.appSecret`），从不下发客户端。

挂载：`app.use('/api/auth', authRouter)`：`apps/server/src/app.ts:116`

| 方法 | 路径 | 鉴权 | 限流 | 作用 | 证据 |
|---|---|---|---|---|---|
| GET | `/api/auth/callback` | 无 | 无 | **Mobile OAuth 桥**：把飞书回调的 `code/state/error` 302 重写到 `xdmaker://auth` scheme（桌面端在 BrowserWindow 内截获，不走此路由） | `routes/auth.ts:52-71` |
| POST | `/api/auth/login` | 无 | IP 20/min | 入参 `{code, codeVerifier, deviceId, clientType}`；飞书换 token + user_info + upsert + 签 JWT + 建 refresh | `routes/auth.ts:73-107`、`services/auth.ts:69-179` |
| POST | `/api/auth/dev-login` | 无 | IP 20/min | 仅 `XDT_DEV_AUTH_ENABLED=1` 时可用；造 dev user + 签 JWT | `routes/auth.ts:109-127`、`services/auth.ts:181-235` |
| POST | `/api/auth/refresh` | 无 | IP 60/min | 入参 `{refreshToken, deviceId}`；轮换 refresh + 新 JWT；返回 preferences + migration | `routes/auth.ts:129-147`、`services/auth.ts:237-311` |
| POST | `/api/auth/refresh-feishu` | JWT | IP 120/min + user 30/min | 入参 `{feishuRefreshToken}`；刷新飞书 user_access_token（v2→v1 回退） | `routes/auth.ts:149-163`、`services/auth.ts:320-345` |
| POST | `/api/auth/logout` | JWT | IP 120/min + user 30/min | 入参 `{deviceId}`；删该 (userId,deviceId) 的 refresh token | `routes/auth.ts:165-179`、`services/auth.ts:313-318` |
| GET | `/api/user/me` | JWT | — | 冷启动 `initialize()` 拿 user 全量信息（含 feishuId/role/isCanary/dept） | `authManager.ts:646`、`routes/user.ts`、`routes/me.ts` |

限流设计要点：pre-auth 按 IP 分桶（key 不含 deviceId，防攻击者换 deviceId 绕桶）；post-auth per-user 分桶（`req.user.id`）。`req.ip` 准确性依赖 `trust proxy = ['loopback','linklocal','uniquelocal']`：`app.ts:57`

## 5. 主进程 / 渲染进程 / 服务端 三方通信契约

### 5.1 Renderer ↔ Main（Electron IPC）
- preload 桥：`apps/desktop/src/preload/preload.ts`
  - `authInitialize/authLogin/authDevLogin/authLogout` → `ipcRenderer.invoke('auth:...')`：`preload.ts:898-907`
  - `onAuthStateChange / onAuthSessionExpired`：`preload.ts:202-203,908-909`（用 `createIpcFanOut` 做多 listener 扇出）
- 主进程 handler 注册：`apps/desktop/src/main/bootstrap-electron.ts:2278-2361`
  - `auth:initialize` → `authManager.initialize()`
  - `auth:login` → `authManager.login(getWindow())`
  - `auth:dev-login` → `authManager.devLogin()`
  - `auth:logout` → 先 teardown 链，再 `authManager.logout()`（见 §3.4）
  - `auth:refresh` → `authManager.refresh()`
- Main → Renderer 推送：`broadcastToRenderers(channel, payload)` 遍历所有未销毁 BrowserWindow `webContents.send`：`authManager.ts:433-452`
  - `auth:state-change` payload = `{user, isAuthenticated, migration, deviceId}`：`authManager.ts:444-452`
  - `auth:session-expired` payload = `{message}`：`authManager.ts:454-456`
  - 广播全部窗口（不是 `[0]`）的踩坑说明见 `authManager.ts:419-432`（voice overlay 会 prewarm hidden window，`[0]` 会被它占）

### 5.2 Main ↔ Server（HTTP，`net.fetch`）
- `apiFetch<T>(apiPath, {method, body, token, timeoutMs})`：`authManager.ts:253-282`
  - 默认 15s 超时（`AbortController`）；`timeoutMs:0` 关闭（refresh 端点必关）
  - 带 `Authorization: Bearer <token>` 头
- 所有路径见 §4 表格；基址 `SERVER_URL`（`VITE_API_BASE_URL || http://localhost:3333`）
- 业务请求里 JWT 自动附加：`bootstrap-electron.ts:3077`（`token = authManager.getAccessToken()`）、401 → `authManager.refresh()` 再重试一次：`bootstrap-electron.ts:3107`

### 5.3 Renderer ↔ Server
- 渲染进程**不直接**持有 token、不直接打鉴权 API。所有需要 JWT 的请求都走 main 进程的 serverApiClient（`bootstrap-electron.ts:3055` 注释：renderer `uses fetch() directly. Token is auto-attached from authManager.`）。
- `meService.getMe()`（合并 role）是渲染进程唯一直接的 `me` 拉取，但仍经 main 的 fetch 代理：`AuthContext.tsx:82`、`authManager.ts:135-155`

---

## 6. 复用判定素材（面向 MivoCanvas：Vite+React+Hono BFF，无 Electron）

> MivoCanvas 目标：飞书登录 → 发个人网关 key。拓扑 = 浏览器前端 + Hono BFF（无 Electron）。
> 区分「逻辑可移植」(framework-agnostic, 换载体即可用) 与「载体绑定」(Electron 专属，必须替换)。

### 6.1 逻辑可移植（直接搬到 Hono BFF + 浏览器）

| 代码/模式 | 证据 | 搬迁要点 |
|---|---|---|
| **服务端 login 主体** `exchangeCodeForToken` + `getFeishuUserInfo` + user upsert + 签 JWT + refresh token 轮换 | `services/auth.ts:69-179,237-318`、`feishu.ts:191-330` | Express→Hono 几乎逐行可搬；`prisma` 可保留或换 Drizzle/Prisma；逻辑与 Web 框架无关。这是 MivoCanvas BFF 的核心。 |
| **飞书 v2 token 交换 + v1 回退刷新** | `feishu.ts:191-289,332-547` | 纯 fetch + 错误码分类，框架无关。`FEISHU_OAUTH_SERVICE_ERROR_CODES` / `FEISHU_REFRESH_REAUTH_REQUIRED_CODES` 等错误码集合可直接复用。 |
| **PKCE 生成与校验** | `authManager.ts:234-241`（crypto.randomBytes+sha256+base64url） | 搬到 BFF 或浏览器 `crypto.subtle` 均可。MivoCanvas 推荐 BFF 侧生成+存 session，浏览器只跳转。 |
| **JWT 签名/校验**（jose HS256） | `lib/jwt.ts:9-34` | Hono 直接用 `jose`/`hono/jwt`。`sub=userId, device=deviceId, 1h` 结构可沿用。 |
| **refresh token 轮换（hash 存储 + 删旧建新）** | `services/auth.ts:241-272`、`lib/crypto.ts(hashToken/generateRefreshToken)` | 经典 rotating refresh token，框架无关。BFF 用 DB 存 hash 即可。 |
| **scope 清单与完整性校验** | `authManager.ts:718`、`services/feishuScopes.ts`(`findMissingRequiredScopes`) | MivoCanvas 若也要直连飞书数据 API，scope 列表直接借；若只需身份，可砍到 `offline_access contact:user.email:readonly` 等最小集。 |
| **refresh 调度逻辑**（JWT.exp - 300s 触发） | `authManager.ts:380-398` | 搬到 BFF：JWT 放 httpOnly cookie，BFF 在请求拦截/定时器里续命；浏览器侧不用管。 |
| **确定性 vs 瞬时失败分类** | `authRefreshFailure.ts`(`isDefinitiveRefreshFailure`/`runRefreshWithTransientRetry`) | 很好的失败分类设计，建议直接搬：瞬时失败保留 token 重试，确定性失败才清登录。 |
| **`clientType` 严格度分流** | `services/auth.ts:31-56,77-94` | MivoCanvas 是「真相端」(直连飞书发 key)，按 `desktop` 严格分支即可，砍掉 mobile 分支。 |
| **dev-login 占位** | `services/auth.ts:181-235` | 本地开发免飞书，直接搬，Hono 侧 gate `XDT_DEV_AUTH_ENABLED`。 |

### 6.2 载体绑定（Electron 专属，MivoCanvas 必须替换）

| 代码/模式 | 证据 | 为什么不能用 | Web 侧替代 |
|---|---|---|---|
| **BrowserWindow OAuth 拦截重定向取 code** | `authManager.ts:292-341`(`will-redirect`/`will-navigate` 截 REDIRECT_URI) | 浏览器无法在弹窗里拦截跨域重定向 URL 读取参数（CORS/安全策略）。 | 标准 Web OAuth：① 顶层跳转到飞书 authorize → server `/callback` 处理 → 设 httpOnly cookie → 302 回前端；或 ② `window.open` popup + `postMessage` 回传。 |
| **`safeStorage` 加密文件存 refresh token** | `authManager.ts:194-222`、`feishu.ts:17-67` | 浏览器无 OS keychain，无文件系统。 | refresh token 存 **BFF 的 httpOnly + Secure + SameSite=Lax cookie**；前端 JS 永远读不到。飞书 RT 存 BFF 侧 DB/KV（按 userId 切片）。 |
| **主 JWT 内存 + deviceId 绑定** | `authManager.ts:159,163-170`(`machineIdSync`) | 浏览器无稳定 machineId。 | JWT 存 httpOnly cookie（短期）；deviceId 用首次访问时种下的随机 cookie 值，或弱化为「浏览器会话」不绑设备。 |
| **IPC `auth:*` handler + `auth:state-change` 广播** | `bootstrap-electron.ts:2278-2361`、`authManager.ts:433-452` | 无 IPC、无多窗口。 | 前端用 React Context + `GET /api/auth/me` 初始化；登录态变更靠 BFF 响应/cookie。无 broadcast 需求（单窗口）。 |
| **`net.fetch` + `app.getPath('userData')`** | `authManager.ts:269,194` | Electron API。 | BFF 用 node/undici `fetch`；路径用 BFF 侧 data dir。 |
| **`/api/auth/callback` → `xdmaker://auth` deep link** | `routes/auth.ts:52-71` | 自定义 scheme 是桌面/移动 App 专属。 | Web 直接 `/callback` 处理完 → 302 回前端 URL（如 `/auth/success`）。 |
| **登出前的 device-link / scheduler / embedding-host / localDb teardown** | `bootstrap-electron.ts:2292-2357` | 全是 Electron 桌面专属子系统。 | BFF 登出 = 清 cookie + 删 refresh token 记录，一行。 |
| **`releaseDeviceLinkOwnershipBeforeLogout` / `closeLocalDb`** | `bootstrap-electron.ts:2347,2354`、`authManager.ts:901-905` | 桌面多设备仲裁 + 本地 SQLite。 | 无对应物，删。 |
| **`handleResume`（powerMonitor）** | `authManager.ts:921-933`、`bootstrap-electron.ts:4075` | Electron 电源事件。 | 浏览器用 `visibilitychange`/`focus` 触发 BFF 续命，或干脆让 cookie 过期自然重登。 |

### 6.3 给 MivoCanvas 的最小可行移植清单

1. **BFF(Hono) 端**：直接搬 `services/auth.ts` + `services/feishu.ts` + `lib/jwt.ts` + `lib/crypto.ts` + `feishuScopes.ts`，Express router 换 Hono router，`prisma` 保留或换。端点保留 `/api/auth/login` `/refresh` `/logout` `/refresh-feishu`；`/callback` 改成「处理飞书重定向 → 设 cookie → 302 回前端」。
2. **凭据存储**：主 JWT + refresh token + 飞书 RT 全部放 BFF 侧（JWT = httpOnly cookie，refresh = DB hash，飞书 RT = DB 按 userId 切片）。前端零 token。
3. **前端**：一个「飞书登录」按钮 → `window.location.href = '/api/auth/feishu-authorize'`（BFF 生成 state+PKCE 存 session，302 到飞书 authorize）。回调回来后 BFF 设 cookie，前端 `GET /api/auth/me` 拿 user。
4. **发个人网关 key**：复用 `routes/apiKeySync.ts` / `mivoApiKeySync.ts` 模式（`app.ts:122-141` 受 authenticate 保护的 per-user key 存取），把「网关 key」当 Mivo key 那条线做即可——该模式已是「本地 only + 服务端不发 key」的契约（`authManager.ts:284-288` 注释说明 XD/Mivo key 均 local-only），MivoCanvas 的网关 key 若要服务端代发，则需新增一条 BFF 端签发 + 下发 httpOnly 的路径。
5. **scope**：若 MivoCanvas 只为发网关 key + 读身份，把 `authManager.ts:718` 的 scope 砍到 `offline_access contact:user.email:readonly contact:contact.base:readonly` 之类最小集，飞书后台应用配置同步收紧。

---

## 7. 附：关键文件清单（便于后续深挖）

- 渲染：`apps/desktop/src/renderer/components/login/LoginPage.tsx`、`hooks/useLogin.ts`、`contexts/AuthContext.tsx`、`lib/authService.ts`、`lib/meService.ts`、`components/auth/MigrationGate.tsx`
- 主进程：`apps/desktop/src/main/authManager.ts`（核心 941 行）、`bootstrap-electron.ts:2278-2361`（IPC 注册）、`authRefreshFailure.ts`、`mcp-integrations/feishu.ts:1-140`（飞书 token store）、`secrets/providerSecretStore.ts`（网关 key 本地存储）、`canaryFlagStore.ts`
- 服务端：`apps/server/src/routes/auth.ts`、`services/auth.ts`、`services/feishu.ts`、`services/feishuScopes.ts`、`lib/jwt.ts`、`lib/crypto.ts`、`middleware/authenticate.ts`、`config.ts:76-78,131-134,162-180`、`app.ts:57,116`
- 数据模型：`prisma schema` 的 `User.feishuId` / `RefreshToken.{userId,deviceId,tokenHash,expiresAt}`（见 `services/auth.ts:101-131,241-272` 用法）
