# maker 个人网关 key(XD Gateway Key)全链路探底

> 探底对象:`/Users/praise/AI-Agent/Claude/projects/Project XDMaker`(XDMaker/maker,Electron + pnpm monorepo)
> 模式:只读探底,未修改任何源码。所有结论带 file:line 证据(相对 XDMaker 仓根)。
> 日期:2026-07-07

## 0. 速览(一句话结论)

- **key 形态**:`sk-` 前缀字符串,由用户去 `https://console.tapsvc.com/nova/#/ai-gateway?tab=keys` 控制台自取后粘贴(`XdGatewayKeyDialog.tsx:9,36`)。**登录后服务端不自动发放**——server `/api/auth/login` 只回 JWT + 飞书 token,不含 gateway key(`auth.ts:73` + grep 无 apiKey 字段)。
- **存储**:Electron `safeStorage`(OS keychain/DPAPI 加密)落到 `userData/safe-storage/api_key.enc`,base64 文本文件,**本地 only,从不上云**(`providerSecretStore.ts:52-91`、`useApiKey.ts:17-20`)。
- **使用**:① 注入 cc 子进程 `ANTHROPIC_API_KEY` env;② 注入 codex 子进程 `XDT_CODEX_API_KEY` env;③ 本地 loopback proxy 按 per-request 覆盖 `Authorization: Bearer <key>` / `x-api-key: <key>` 头(`auth-adapters.ts:318-353,943-953`、`provider-route.ts:55-96`)。
- **校验/换 key**:保存前先 `GET https://llm-proxy.tapsvc.com/v1/models` 测连通,401=「Key 无效」;test 通过才落盘(`useApiKey.ts:265-308`、`bootstrap-electron.ts:3036-3049`)。换 key = 就地重开弹窗录入。
- **与飞书登录绑定**:**服务端无绑定**(key 本地 only);客户端仅有「同机换账号清 key」边界——`reconcileOwner(user.id)`(`authManager.ts:677,782`、`providerSecretStore.ts:168-189`)。同账号重登保留,换账号清空。

---

## 1. key 形态、来源与签发方

### 1.1 形态:`sk-` 前缀

- `XdGatewayKeyDialog.tsx:36` —— `const canSave = key.startsWith('sk-') && !isSaving;`(能保存的硬门槛)。
- `useApiKey.ts:265-268` —— `if (!key.startsWith('sk-')) { setValidationError(t('logic.validation.apiKeyFormat')); return false; }`。
- key 末 4 位用于排查日志(`useApiKey.ts:30-34` `keyTail`),服务端日志用 sha256 前 12 位(`useApiKey.ts:24-29` 注释提到 `apiKeySync.ts hashForLog`)—— 单看任一条都不能还原 key。

### 1.2 来源:用户去 XD 网关控制台自取后粘贴

- `XdGatewayKeyDialog.tsx:8-9` —— `/** XD 网关控制台(与 API 密钥页同一处,用户在此创建 / 查看 key)。 */ const XD_GATEWAY_CONSOLE_URL = 'https://console.tapsvc.com/nova/#/ai-gateway?tab=keys';`
- `XdGatewayKeyDialog.tsx:83-90` —— 「打开控制台」按钮 `openExternal(XD_GATEWAY_CONSOLE_URL)`,跳到外部浏览器。
- `XdGatewayKeyDialog.tsx:18-27` 注释 —— 录入/更换就地弹窗完成,取代旧的「跳转到 API 密钥页」;启动不再强制配 key(无「暂时跳过」)。

### 1.3 签发方:XD AI Gateway(llm-proxy.tapsvc.com),**不是** maker 服务端

- 网关上游常量 `CLAUDE_UPSTREAM_ENDPOINT = 'https://llm-proxy.tapsvc.com'`(`runtime-configs.ts:101`)。
- codex 网关入口 `CODEX_GATEWAY_BASE_URL = '${CLAUDE_UPSTREAM_ENDPOINT}/v1'`(`codex-gateway-config.ts:37`)。
- **登录后不自动发 key**:`authManager.ts:720-785` 的 `login()` 走飞书 OAuth → `POST /api/auth/login`(`auth.ts:73`)→ 返回 `accessToken / refreshToken / user / feishuAccessToken`(`authManager.ts:748-773`),**响应里没有 apiKey / gateway key 字段**。grep `auth.ts` / `user.ts` 无 `apiKey` / `gateway` 字段(`auth.ts:73,109`;`user.ts:204` 只有 `feishuId`)。
- `useApiKey.ts:17-20` 注释明示:「XD 网关 key 是本地 only,从不同步/上传到服务器……这里不再有任何 `/api/users/me/api-key` 的 PUT/GET/DELETE」。
- `authManager.ts:675-677` 注释:「XD / Mivo key 均为本地 only,不再在冷启动从服务器同步到本地」。
- 即:server 侧虽保留了 `apiKeySync` 路由(`app.ts:123,130`),但 **desktop 客户端已停止调用**——key 的获取纯靠用户去控制台自取。

> 结论:key 由 XD 网关控制台签发,用户手动粘贴;飞书登录只产 JWT 身份,不发 key。

---

## 2. 客户端存储(加密方式与位置)

### 2.1 存储 SSoT:Electron safeStorage + 文件

- `providerSecrets.ts:27-28` —— `xd: 'api_key'`(safeStorage 存储键名,`.enc` 文件名前缀)。
- `providerSecretStore.ts:52-54` —— `secretDir() = path.join(app.getPath('userData'), 'safe-storage')`。
- `providerSecretStore.ts:60-91` 默认 IO:
  - `isAvailable()` = `safeStorage.isEncryptionAvailable()`(委托 OS keychain macOS/DPAPI Windows);
  - `read()` 读 `userData/safe-storage/<key>.enc`,utf-8 → `Buffer.from(content,'base64')` → `safeStorage.decryptString`(`providerSecretStore.ts:64-70`);
  - `write()` = `safeStorage.encryptString(value)` → base64 → 写 utf-8 文件(`providerSecretStore.ts:71-78`)。
- 字节级互通:renderer 经 IPC 写、main 端经本 store 读,同一批 `.enc` 文件(`providerSecretStore.ts:30-33` 注释)。

### 2.2 IPC 通道(bootstrap-electron)

- `bootstrap-electron.ts:2170-2206` `safe-storage-store` handler:校验 key 名 → safeStorage 加密 → 写文件。写入前后包了 `prepareApiKeyChangeMaybeRestartCodex / finalizeApiKeyChangeMaybeRestartCodex`(改 key 触发 codex 重建),失败回滚原文件内容(`bootstrap-electron.ts:2187-2198`)。
- `bootstrap-electron.ts:2208-2224` `safe-storage-read` handler。
- `bootstrap-electron.ts:2226-2270` `safe-storage-remove` handler(幂等,ENOENT 视为成功)。
- preload 暴露:`preload.ts:1401-1402` `testApiKeyConnection`、`preload.ts` `safeStorageStore/Read/Remove`(invoke `safe-storage-*`)。

### 2.3 本地 only,不上云

- `useApiKey.ts:54-55` —— 「本机 only —— 只读 Electron safeStorage,不再向服务器 GET。XD 网关 key 从不上云,新设备/新登录不会自动继承别处配过的 key,用户需在本机重新填入」。
- `useApiKey.ts:286-300` saveKey 成功 = `safeStorageStore` 即完成,注释:「本地 only:写入 safeStorage 即完成,不再 PUT 到服务器」。
- `useApiKey.ts:360-362` clearKey 同理:「不再 DELETE 服务器」。

### 2.4 账号边界:owner 标记 + reconcileOwner

- `providerSecretStore.ts:20` —— `OWNER_STORAGE_KEY = 'provider_secret_owner'`(非密钥,存同目录,记录「本机这批密钥归属哪个账号」)。
- `providerSecretStore.ts:103-114` 接口:`getOwnerUserId()` / `reconcileOwner(userId)`。
- `providerSecretStore.ts:168-189` 实现:owner 不存在/同 userId → 保留 + 刷标记;owner 不同(同机换账号)→ `clearAllSecrets()` 清空所有 provider 密钥再写新 owner;返回 `{ cleared }`。
- 调用点:`authManager.ts:677`(冷启动 `/me` 后)、`authManager.ts:782`(login 成功后)。
- `authManager.ts:504` 注释:「串号边界改由 login/冷启动时 providerSecretStore.reconcileOwner 处理:owner 变了才清」。

---

## 3. key 的使用(注入哪些请求/哪些模块读它)

### 3.1 读取入口(单一来源)

- `auth-adapters.ts:183-185` —— `export function readClaudeApiKey(): string | null { return getProviderSecretStore().get('xd'); }`。所有 main 侧模块(usage / title / proxy 注入)都经它读,保证来源一致。

### 3.2 注入 Claude Code(cc)子进程 env

- `auth-adapters.ts:315-369` `DesktopClaudeAuthAdapter.getAuthEnv`:
  - `credentialMode === 'gateway-key'` 或默认(无 OAuth)分支:`env.ANTHROPIC_API_KEY = apiKey`(`auth-adapters.ts:318-320,351-354`)。
  - OAuth-spawn 分支:**不**注入 `ANTHROPIC_API_KEY`(会触发 cc `shouldDisableAuth`),gateway key 改由本地 proxy 旁路按请求注入(`auth-adapters.ts:331-335` 注释)。
- `auth-adapters.ts:380-385` `getOneShotAuth`:连了订阅时的 host 直连轻任务,固定回 `{ apiKey: readClaudeApiKey(), baseURL: CLAUDE_UPSTREAM_ENDPOINT }`。

### 3.3 注入 Codex 子进程 env

- `codex-gateway-config.ts:31` —— `CODEX_GATEWAY_ENV_KEY = 'XDT_CODEX_API_KEY'`(专名,避免撞用户机器同名变量)。
- `codex-gateway-config.ts:62-75` `buildCodexProxySpawnArgs`:用 `-c` 顶层 override 注入 codex config(`model_provider="tapsvc"`、`base_url`、`wire_api="responses"`、`env_key="XDT_CODEX_API_KEY"` 或 `requires_openai_auth=true`)。key 值不进 `-c`(防 `ps` 看到),只走 env_key。
- `auth-adapters.ts:943-965` `DesktopCodexAuthAdapter.getAuthEnv`:`const apiKey = readClaudeApiKey(); if (apiKey) env[CODEX_GATEWAY_ENV_KEY] = apiKey;`(始终注入,oauth-bearer 时 codex 不读此 env_key,无害)。

### 3.4 本地 loopback proxy 按 per-request 覆盖鉴权头

- **Claude 侧**(`anthropic-compat-proxy-host.ts`):
  - `anthropic-compat-proxy-host.ts:60-62` —— `_readGatewayKey` reader 由 host 注入(`setClaudeProxyGatewayKeyReader`,实参 `readClaudeApiKey`)。
  - `anthropic-compat-proxy-host.ts:149` —— `const gatewayKey = _readGatewayKey();` 每 request 现 read(零会话、零 syscall 缓存)。
  - `anthropic-compat-proxy-host.ts:163-168` —— 请求带 `x-api-key`(gateway-spawn)→ passthrough;不带(oauth-spawn)→ `gatewayDefaultRouteDecision` 换网关 key(覆盖 bearer + 删 anthropic-beta,防订阅 token 泄漏到网关)。
- **Codex 侧**(`codex-proxy-host.ts`):
  - `codex-proxy-host.ts:94-98` —— `setCodexProxyGatewayKeyReader`(同 `readClaudeApiKey`)。
  - `codex-proxy-host.ts:341-355` `decideCodexRoute`:`codex/` 骨折模型 → `{ headerOverride: { authorization: 'Bearer ${gatewayKey}' } }`;普通模型 + oauth-bearer → 透传 codex OAuth token 打 ChatGPT 后端(`CODEX_OAUTH_UPSTREAM`, `codex-proxy-host.ts:44`)。
- **统一决策层**(`provider-route.ts:55-96` `buildRouteDecision`):
  - `gateway-key` 策略:cc = `{ 'x-api-key': gatewayKey, authorization: 'Bearer ${gatewayKey}' }`(两头都覆盖);codex = `{ authorization: 'Bearer ${gatewayKey}' }`(`provider-route.ts:68-72`)。
  - `api-key-header` 策略(自定义供应商):用用户自己的 apiKey,同样两头覆盖防泄漏(`provider-route.ts:79-96`)。

### 3.5 测连通(testApiKeyConnection)

- `bootstrap-electron.ts:3032-3051` `api-key:test-connection` handler:`net.fetch('https://llm-proxy.tapsvc.com/v1/models', { headers: { Authorization: 'Bearer ${key}' } })`;200→success;401→「Key 无效,请检查」;其它→「服务异常 (HTTP N)」;网络错→「网络连接失败」。
- 调用点:`useApiKey.ts:273`(saveKey 先 test)、`useApiKey.ts:331`(testConnection 按钮)。

### 3.6 Mivo key(另一把 key,供对比/复用)

- 形态:`mivo_` 前缀(`useMivoApiKey.ts:27`、`mivo.ts:34`)。
- 存储:safeStorage `mivo_api_key.enc`(`providerSecrets.ts:30`),本地 only(`useMivoApiKey.ts:4-9`)。
- 读取使用:`mcp-integrations/mivo.ts:39-44` `readMivoApiKey()` = `getProviderSecretStore().get('mivo')`,过滤 `mivo_` 前缀;endpoint `https://aigc.xindong.com`(`mivo.ts:33`)。
- **无廉价 ping 端点**,validity 懒验证于首次工具调用(`useMivoApiKey.ts:15-16`)。
- 服务端有 `mivoApiKeySync` 路由(PUT/GET/DELETE `/api/users/me/mivo-api-key`,AES-256-GCM 加密列 `encryptedMivoApiKey`,`mivoApiKeySync.ts:23-67`、`app.ts:133`),但 desktop 客户端已停用(`useMivoApiKey.ts:8` 注释)。

---

## 4. key 的校验/失效/更换流程

### 4.1 保存链路:test 通过才落盘

`useApiKey.ts:240-323` `saveKey`:
1. 空串 → `safeStorageRemove`(等同 clearKey)(`useApiKey.ts:245-262`)。
2. 校验 `sk-` 前缀,不过返 `validationError`(`useApiKey.ts:265-268`)。
3. `testApiKeyConnection(key)` 先测连通;失败设 `errorMessage + status='error'`,**不落盘**(`useApiKey.ts:272-284`)。
4. 成功后 `safeStorageStore(XD_STORAGE_KEY, key)` 落盘(`useApiKey.ts:286-308`)。
5. 成功后 `invalidateReconcileCache` + `broadcastApiKeyChange(key)` 通知所有 `useApiKey` 实例同步(`useApiKey.ts:292-300`)。

### 4.2 失效时 UI 反馈

- **保存时 401**:直接回显 `testResult.error`(「Key 无效,请检查」)在弹窗错误位(`XdGatewayKeyDialog.tsx:34,123-128`、`useApiKey.ts:280-283`)。
- **运行时 key 失效**:proxy passthrough 时上游返 401;`codex-proxy-host.ts:389-392` 记 `codex routing → gateway but no api key configured; passthrough (可能 401)` 诊断 warn。**网关 key 没有专门的 invalid_grant banner**——invalid_grant banner 是 OAuth 订阅 token 专属(`maker-host/index.ts:482-494` `desktopClaudeAuthAdapter.setOnInvalidatedBroadcast`,reason=`claude_oauth_refresh_invalid_grant`)。
- **send 门禁(无 key 拦截)**:`useVendorReadiness.ts:60-61` —— `connectedProvidersForAgent(providers, agent).length > 0 ? 'ready' : 'unauthenticated'`;`useVendorAuthGate.ts:165-179,228-246` —— send 前若 `unauthenticated` 弹确认对话框 + `navigate('/settings?tab=providers')` 引导去配 key。
- **reconcile 防误判**:mount 时 `isReconciling=true`,避免 reconcile 完成前误判「没 key」(`useApiKey.ts:167,177-197`)。

### 4.3 换 key 完整交互

- 入口:供应商页 XD 行「连接 / 更换 key」按钮 → `setKeyDialogOpen(true)`(`ProvidersSection.tsx:710,730-737`)。
- 弹窗:`XdGatewayKeyDialog` 就地录入,「打开控制台」取新 key → 粘贴 → 保存(test-then-store)(`ProvidersSection.tsx:752-760`)。
- 保存成功 `onSaved` 回调:关弹窗 + `onChanged()` refetch `listProviders` 刷新连接态(`ProvidersSection.tsx:755-758`)。
- 断开:`handleDisconnect` → 确认对话框 → `clearKey()`(`ProvidersSection.tsx:692-702`)。
- 跨实例同步:`broadcastApiKeyChange`(`useApiKey.ts:97-105`)让其它挂载的 `useApiKey` 实例(设置页/Gate/ChatInput pre-check)同步刷新,避免「一处保存另一处按钮没反应」(`useApiKey.ts:83-94` 注释)。
- 切账号防残留:`handleAuthStateChangeForApiKey` 订阅 `onAuthStateChange`,登出立即广播 `null`,登入重 reconcile(`useApiKey.ts:115-130`)。
- codex 改 key 触发 host 重建:`bootstrap-electron.ts:2177,2189,2237,2258` `prepareApiKeyChangeMaybeRestartCodex / finalizeApiKeyChangeMaybeRestartCodex`(`codex-credential-switch.ts` 限制:credential family 变了不能复用进程,`codex-credential-switch.ts:56,83,127`)。

---

## 5. key 与飞书登录身份的绑定关系

### 5.1 登录链路(飞书 OAuth → server → JWT + 飞书 token)

- `authManager.ts:720-734` —— `authUrl = https://accounts.feishu.cn/open-apis/authen/v1/authorize?...` → `openOAuthWindow` → 拿 `code` → `POST /api/auth/login`(body `{ code, codeVerifier, deviceId, clientType: 'desktop' }`)。
- `authManager.ts:748-773` —— 响应回 `accessToken`(JWT)、`refreshToken`、`user{id,name,avatar,email,defaultModel,defaultEffort,isCanary,feishuId,role}`、`feishuAccessToken/RefreshToken/ExpiresIn`。
- `authManager.ts:669,762,820` —— `feishuOpenId = user.feishuId ?? null`(server DB `user.feishuId`,登录必经飞书 OAuth 故理论非空,`authManager.ts:57-65`)。

### 5.2 key 与身份:服务端无绑定,客户端本地边界

- **服务端不发 key、不存 key**(XD key):`useApiKey.ts:17-20`、`authManager.ts:675-677`。server `apiKeySync` 路由虽在,desktop 不调。
- **唯一「绑定」是本机 owner 标记**:`authManager.ts:677,782` login/冷启动成功后调 `reconcileOwner(user.id)`:
  - 同 user 重登(会话过期重登)→ owner 相同 → **保留**本机 key,不必重填(`providerSecretStore.ts:168-189`、测试 `providerSecretStore.test.ts:157-166`)。
  - 同机换 user → owner 不同 → **清空**所有 provider key + 写新 owner(防串号,`providerSecretStore.test.ts:168-180`)。
- 即:key 不与飞书身份做服务端关联,只靠本机文件归属做「同账号留、换账号清」的物理隔离。新设备登录同一账号也**不会**自动恢复 key,需本机重填(`useApiKey.ts:54-55`)。

### 5.3 Mivo key 同款逻辑

- `authManager.ts:675-677` 注释:「XD / Mivo key 均为本地 only」——两把 key 走同一套 safeStorage + reconcileOwner 边界,服务端均不参与(尽管 server 留了 `mivoApiKeySync` 备用路由)。

---

## 6. 复用判定素材(MivoCanvas 视角)

> MivoCanvas = 浏览器前端 + Hono BFF,**无 Electron**。目标:飞书登录后提供「个人网关 key + 另一个 mivo MCP api key」。

### 6.1 可直接搬的逻辑/UI 模式

| maker 逻辑 | 证据 | 搬到 MivoCanvas 的形态 |
|------|------|------|
| **sk- 前缀 + 末 4 位日志** 的 key 形态约定 | `XdGatewayKeyDialog.tsx:36`、`useApiKey.ts:30-34` | 直接照搬:前端校验 `sk-` 前缀 + `keyTail` 排查日志。mivo key 同款 `mivo_` 前缀(`useMivoApiKey.ts:27`)。 |
| **test-then-store 保存链路** | `useApiKey.ts:265-308`、`bootstrap-electron.ts:3032-3049` | BFF 实现 `GET /v1/models`(`Authorization: Bearer <key>`)探针,401=「Key 无效」;前端 saveKey 先调探针再落盘。 |
| **XdGatewayKeyDialog 就地弹窗录入 / 更换 / 打开控制台** | `XdGatewayKeyDialog.tsx:8-9,83-90` | UI 模式整套可搬:控制台外链 + password 输入 + eye toggle + 错误位 + confirm/cancel pill 按钮。 |
| **ProvidersSection XD 行:连接/断开/更换 key + masked key chip** | `ProvidersSection.tsx:685-762` | ProviderCell + ConnectedPill + maskedKey chip + 断开确认对话框,可直接复刻。 |
| **跨实例广播(saveKey/clearKey 后同步刷新)** | `useApiKey.ts:83-105,97-105,292-300` | 前端用同款 module 级 listener Set 广播,避免多处 hook 实例状态发散。 |
| **send 门禁 readiness gate** | `useVendorReadiness.ts:60-61`、`useVendorAuthGate.ts:165-179,228-246` | 前端 send 前判 `hasSavedKey`,无 key 弹确认 + 跳设置页。 |
| **reconcileOwner 账号边界语义**(同留换清) | `providerSecretStore.ts:103-189`、`authManager.ts:677,782` | BFF 侧存 key 时带 userId 标记;同 user 覆盖、换 user 清空。语义可直接照搬。 |
| **mivo key 懒验证**(无廉价 ping 时) | `useMivoApiKey.ts:15-16`、`mivo.ts:39-44` | mivo MCP api key 若无探针端点,同款「首次工具调用懒验证 + 失败让用户重填」模式。 |
| **keyHash + tail 排查对账**(服务端 sha256 前 12 / 客户端末 4) | `useApiKey.ts:24-29`、`mivoApiKeySync.ts:18-20` | BFF 存 key 时存 sha256 前 12 位用于日志对账,前端日志打末 4 位。 |

### 6.2 必须重做(依赖 Electron 或 maker 专属服务)

| maker 机制 | 证据 | 为什么不能搬 / 怎么改 |
|------|------|------|
| **Electron safeStorage(OS keychain/DPAPI)加密落盘** | `providerSecretStore.ts:52-91`、`bootstrap-electron.ts:2170-2270` | 浏览器**没有** safeStorage。必须重做:① BFF 侧存(Hono + DB,参考 maker server `mivoApiKeySync.ts` 的 AES-256-GCM + HKDF,`lib/crypto.ts:31-32`);或 ② 浏览器侧用 WebCrypto + IndexedDB(但浏览器密钥保护弱于 OS keychain,不推荐存网关 key)。**建议 BFF 存**——MivoCanvas 已是「飞书登录后提供 key」的形态,服务端 per-user 加密存储正合适。 |
| **`ANTHROPIC_API_KEY` / `XDT_CODEX_API_KEY` env 注入子进程** | `auth-adapters.ts:318-353,943-953`、`codex-gateway-config.ts:31` | 浏览器不 spawn 子进程。MivoCanvas 调网关走 BFF fetch,在 BFF 请求里带 `Authorization: Bearer <key>` 头即可,无需 env。 |
| **本地 loopback proxy + per-request headerOverride** | `anthropic-compat-proxy-host.ts:149-168`、`provider-route.ts:55-96`、`codex-proxy-host.ts:341-355` | 无 Electron proxy 进程。MivoCanvas BFF 直接做网关代理:BFF 读 per-user key → 注入 `Authorization`/`x-api-key` 头转发 `llm-proxy.tapsvc.com`。`provider-route.ts` 的「两头都覆盖」策略(cc 同时覆盖 `x-api-key` + `authorization` 防泄漏)可作 BFF 转发规则参考。 |
| **codex `-c` config override + host 重建 on key change** | `codex-gateway-config.ts:62-75`、`bootstrap-electron.ts:2177,2189`、`codex-credential-switch.ts` | 无 codex 子进程。不用搬。 |
| **maker server `apiKeySync` 路由已停用** | `app.ts:123,130`、`useApiKey.ts:17-20` | maker desktop 走本地 only,server 路由成死代码。MivoCanvas 反而要**新写** BFF 侧 per-user key 持久化(参考 `mivoApiKeySync.ts` 的服务端实现,它就是现成模板:`saveMivoApiKey/readMivoApiKey/removeMivoApiKey` + `User.encryptedMivoApiKey` 列,`mivoApiKeySync.ts:23-67`)。 |
| **OAuth invalid_grant banner / cc 子进程 401 回调** | `maker-host/index.ts:482-494`、`auth-adapters.ts:398-409` | MivoCanvas 无 OAuth 订阅链路(只发网关 key),不需要 invalid_grant 机制。运行时 key 失效走 BFF 转发 401 → 前端 toast/横幅提示重填。 |

### 6.3 关键架构决策建议(MivoCanvas)

1. **key 存哪**:浏览器前端不存网关 key(无 safeStorage 等价物)。走 BFF + DB per-user AES-256-GCM 加密列,直接复用 maker `mivoApiKeySync.ts` 的加密套路(`lib/crypto.ts` HKDF `xdt-maker/api-key-enc/v1` + `aes-256-gcm`,起一个 MivoCanvas 自己的 `info` 字符串)。
2. **两把 key 怎么分**:网关 key(`sk-`,探针 `GET /v1/models`)+ mivo MCP key(`mivo_`,懒验证)分两个 BFF 端点(PUT/GET/DELETE),复用 maker `mivoApiKeySync` 路由形状(`mivoApiKeySync.ts` route 文件)。
3. **登录绑定**:飞书登录后 BFF 拿 `user.id` 作 key 的归属主键(等价 maker `reconcileOwner(user.id)`,但放服务端而非本机)。同账号可跨设备恢复(这是 MivoCanvas 相对 maker 本地 only 的增强)。
4. **转发注入**:BFF 转发 `llm-proxy.tapsvc.com` 时按 `provider-route.ts:68-72` 的两头覆盖策略(`x-api-key` + `authorization: Bearer`)注入,防订阅类 token 泄漏逻辑虽不直接适用,但双头覆盖对兼容端点更稳。
5. **UI**:直接复刻 `XdGatewayKeyDialog` + `ProvidersSection` XD 行(去掉 Electron `openExternal`,改 `window.open` 打开控制台;去掉 `safeStorage*` IPC,改 BFF fetch)。

---

## 附录:关键文件清单(XDMaker 仓内)

| 文件 | 角色 |
|------|------|
| `apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx` | 网关 key 录入/更换弹窗 |
| `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:685-763` | XD 行连接/断开/换 key UI |
| `apps/desktop/src/renderer/hooks/useApiKey.ts` | XD key 的 reconcile/save/clear/test + 跨实例广播 |
| `apps/desktop/src/renderer/hooks/useMivoApiKey.ts` | mivo key 的本地 only 持久化(对照) |
| `apps/desktop/src/shared/providerSecrets.ts` | providerId → safeStorage 键名 SSoT |
| `apps/desktop/src/main/secrets/providerSecretStore.ts` | safeStorage 封装 + reconcileOwner 账号边界 |
| `apps/desktop/src/main/bootstrap-electron.ts:2170-2270,3032-3051` | safe-storage-* IPC + test-connection handler |
| `apps/desktop/src/main/authManager.ts:677,720-785` | 飞书登录 + reconcileOwner 调用点 |
| `apps/desktop/src/main/maker-host/auth-adapters.ts:183-185,315-369,943-965` | readClaudeApiKey + cc/codex env 注入 |
| `apps/desktop/src/main/maker-host/codex-gateway-config.ts` | codex 网关 env_key + spawn -c override |
| `apps/desktop/src/main/maker-host/provider-route.ts:55-96` | gateway-key/api-key-header 头覆盖决策 |
| `apps/desktop/src/main/maker-host/anthropic-compat-proxy-host.ts:60-62,100-174` | cc 侧 per-request gateway key 注入 |
| `apps/desktop/src/main/maker-host/codex-proxy-host.ts:94-98,341-355` | codex 侧 per-request 路由 |
| `apps/desktop/src/main/maker-host/runtime-configs.ts:101` | `CLAUDE_UPSTREAM_ENDPOINT` 网关主机常量 |
| `apps/desktop/src/main/maker-host/index.ts:465-494` | AUTH_STATE_CHANGED 失效广播 |
| `apps/desktop/src/main/mcp-integrations/mivo.ts:33-44` | mivo key 读取 + endpoint |
| `apps/server/src/services/mivoApiKeySync.ts` | 服务端 per-user AES-256-GCM key 存取模板(MivoCanvas BFF 可复刻) |
| `apps/server/src/routes/mivoApiKeySync.ts` | PUT/GET/DELETE 路由形状模板 |
| `apps/server/src/lib/crypto.ts:31-32` | HKDF + AES-256-GCM 加密 |
