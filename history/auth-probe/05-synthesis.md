# MivoCanvas 登录鉴权 · 功能与代码清单（Phase 2 合成）

> 依据：01-login-flow / 02-gateway-key / 03-settings-ui / 04-mivo-side 四份探底报告（均带 file:line 证据，lead 已抽验核证）。
> 目标：飞书登录 → 个人身份；每用户两把 key（XD 网关 `sk-` key + mivo MCP `mivo_` key）；第一版设置界面可换 2 个 key。

## 一、事实基线（已核证）

| 事实 | 证据 |
|---|---|
| MivoCanvas access gate 为单 token 三方案门禁（Bearer/Basic/X-Mivo-Bff-Token），无用户概念，本地未配 token 时 no-op | server/app.ts:77-91 |
| BFF→mivo 平台凭证全部来自服务端 env（MIVO_PLATFORM_KEY / MIVO_IMAGE_API_KEY / LLM_API_KEY），平台 session token 为模块级全局单例缓存 | server/lib/config.ts:75-77, server/platform/state.ts:19-22 |
| MivoCanvas 前端零鉴权设施、无用户 slice；BFF 无任何 DB | package.json（无 prisma/sqlite）、server/ 目录 |
| maker 服务端有完整飞书 OAuth+JWT（Express，逻辑可逐行搬 Hono）：PKCE、code 交换（持 client_secret）、JWT HS256 1h、refresh hash 轮换 | XDMaker apps/server/src/routes/auth.ts, services/auth.ts, services/feishu.ts |
| maker 网关 key 语义：用户去 console.tapsvc.com 自取粘贴，登录不发 key；本地 only 不上云；test-then-save（GET llm-proxy.tapsvc.com/v1/models 验 Bearer） | XdGatewayKeyDialog.tsx, useApiKey.ts:265-308, bootstrap-electron.ts:3036-3049 |
| maker 有 mivo key 云端 CRUD API（PUT/GET/DELETE /api/users/me/mivo-api-key，AES-256-GCM），但要求 maker JWT，桌面端自己未启用 | XDMaker apps/server/src/routes/mivoApiKeySync.ts |
| maker 设置 UI：useMivoApiKey（mivo_ 前缀、700ms 防抖自动保存、无 test）与 useApiKey（sk- 前缀、test-then-save）两套 hook 范式成熟 | ApiKeySection.tsx, useMivoApiKey.ts, useAutoSaveApiKey.ts |

## 二、功能清单（第一版范围）

| # | 功能 | 复用来源 | 判定 |
|---|---|---|---|
| F1 | 飞书登录墙：未登录进入 MivoCanvas → 飞书 OAuth（Web 标准跳转+PKCE）→ 回调 → BFF 签 JWT（httpOnly cookie）→ 进应用 | maker services/feishu.ts + auth.ts 逻辑移植 | 逻辑搬+载体换 |
| F2 | 会话管理：JWT 过期重登、登出、前端 /api/auth/me 水合用户信息（姓名/头像） | maker jwt.ts + authenticate.ts | 逻辑搬 |
| F3 | 设置界面 v1：新增"设置"入口（侧栏），含「账号」（当前飞书身份+登出）与「API Keys」两区 | maker SettingsView IA 简化为 2 tab | 借鉴重写 |
| F4 | 网关 key 管理：sk- 前缀校验 + 掩码显示 + test-then-save（BFF /api/keys/test 代测 llm-proxy /v1/models）+ 换 key + 「打开控制台」外链 | XdGatewayKeyDialog + useApiKey 链路 | 直接搬（去 Electron） |
| F5 | mivo MCP key 管理：mivo_ 前缀 + 防抖自动保存 + 状态徽标 | useMivoApiKey + useAutoSaveApiKey | 直接搬 |
| F6 | BFF 调用链 per-user 化：generate/edit/enhance/tasks 从请求头取用户 mivo key（无则 fallback env），平台 session token 缓存按 key 指纹分桶（修 P0 串 token 隐患） | 新建（改 state.ts + routes） | 新建 |
| F7 | access gate 升级：JWT cookie 成为第一公民（原 MIVO_BFF_TOKEN 方案保留为兼容/应急通道） | 扩展 server/app.ts:77-91 | 改造 |

非目标（第一版明确不做）：refresh token 轮换（JWT 7d 直接重登）、多设备 key 云同步、账号切换防污染广播、i18n、网关 key 的实际业务接线（只做存储+测试+透传就绪）。

## 三、代码清单（源 → 目标）

**直接搬（逻辑层，Express→Hono 语法级改写）**
- feishu OAuth code 交换 + user_info（services/feishu.ts → server/lib/feishuAuth.ts）
- JWT 签发/验证（services/auth.ts jwt 部分 → server/lib/jwt.ts）
- PKCE 生成/校验（authManager.ts PKCE 段 → 前端 src/lib/pkce.ts）
- test 连通逻辑（bootstrap-electron.ts:3036-3049 → server/routes/keys.ts /test）
- sk-/mivo_ 前缀校验、末 4 位掩码、keyHash 对账（providerSecrets.ts → src/lib/keyFormat.ts）

**改造复用（UI 层，去 Electron/Tailwind 适配 MivoCanvas 样式体系）**
- XdGatewayKeyDialog → src/app/settings/GatewayKeyDialog.tsx
- ApiKeySection（Mivo 子卡）→ src/app/settings/MivoKeySection.tsx
- useApiKey test-then-save / useMivoApiKey 防抖自动保存 → src/store/settingsSlice.ts（Zustand 化）
- ProvidersSection XD 行的 masked chip + 换 key 交互 → 设置面板复用

**新建（MivoCanvas 特有）**
- server/routes/auth.ts（Hono：/api/auth/login /callback /me /logout）
- server/lib/authGate.ts（JWT cookie 校验中间件，与旧 token 方案并存）
- state.ts 平台 token 按 key 指纹分桶改造
- 前端登录墙（App.tsx/main.tsx 挂守卫 + LoginPage）
- 设置入口挂 ProjectSidebar（现有 stub 位）

## 四、架构决策

**已定（探底证据充分，不再摇摆）**
1. 飞书 OAuth 走 Web 标准跳转 + BFF callback（Electron 拦截方案不适用）
2. JWT 放 httpOnly Secure cookie（浏览器无 safeStorage，localStorage 存 JWT 是降级）
3. mivo key 语义与 maker 完全一致（mivo_ 前缀、懒验证），设置 UI 两套 hook 范式照搬
4. 平台 session token 必须按用户/key 分桶（P0）

**需拍板（两个）**
- 决策A · 身份体系：A1 自建轻量（BFF 自己做 OAuth 交换 + 自签 JWT，零 DB 零外部依赖，需申请/复用一个飞书应用的 client_secret 配到 BFF env）vs A2 依赖 maker server（转调 maker /api/auth/login，共享 JWT_SECRET，用户体系与 maker 打通，但引入跨项目运维耦合 + 需 maker 侧配合）
- 决策B · key 存储：B1 浏览器侧（Zustand persist→IDB，请求头透传给 BFF，BFF 无状态零 DB；XSS 可读是已知代价，与 maker"本地 only"哲学一致）vs B2 BFF+SQLite AES-256-GCM（跨设备同步 + 服务端可控，但给无状态 BFF 引入 DB 与密钥管理）vs B3 mivo key 透传 maker 云 API（依赖决策 A 选 A2）
