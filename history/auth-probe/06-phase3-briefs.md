# Phase 3 执行任务书（已拍板：A2 身份依赖 maker server + B1 key 存浏览器侧）

> 派发目标：glm-5.2 max（claude-code agent）。两个执行 worker 并行，各自 worktree，lead 负责合并。
> 状态：待 Orca 通道恢复后派发。

## 共同上下文（两个 worker 都要给）

- 目标仓：/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas（Vite+React19+TS 前端 + server/ Hono BFF），基线 main @ 3d527cf
- 参考仓（只读）：/Users/praise/AI-Agent/Claude/projects/Project XDMaker
- 必读材料：history/auth-probe/01~05 五份报告（05 是合成清单，含功能 F1-F7 与代码三档清单）
- 架构决策（不可偏离）：
  - A2：身份依赖 maker server——MivoCanvas 不自建用户体系，登录经 maker /api/auth/login 拿 JWT；BFF 校验 JWT 用共享 JWT_SECRET（env 注入）；用户信息以 JWT claims + maker /api/user/me 为准
  - B1：两把 key（sk- 网关 key + mivo_ MCP key）存浏览器 Zustand persist→IDB，每次请求经 header 透传 BFF，BFF 无状态零 DB
  - 平台 session token 缓存（server/platform/state.ts:19-22 全局单例）必须按 key 指纹分桶（P0，防多用户串 token）
- 已知集成缺口（worker E1 处理）：maker OAuth callback 是桌面/移动桥（302→xdmaker://），无 web clientType。E1 需读 maker server 源码确认最小通路；若必须改 maker，则在 XDMaker 开分支 feat/web-client-auth 做最小补丁（callback 支持 web 回跳白名单 + /login 认 clientType:'web'），不合 main，交 lead 审
- 开发/e2e 需要免真人飞书扫码的通路：镜像 maker /dev-login 模式做 DEV-only 假登录门（生产构建剔除）
- 工程门槛：npm run build（tsc -b）、npm run lint、npm run test:unit 全绿；遵循 docs/development-logging.md（debugLogger + toastFeedback）；禁 push main；分支 feat/auth-feishu-login（E1）/ feat/auth-settings-keys（E2）
- 产出要求：send_to_lead 汇报变更文件清单 + 验证命令输出摘要 + 未决问题

## Worker E1 · 鉴权骨干（feat/auth-feishu-login）

范围（清单 F1/F2/F7）：
1. server/lib/jwt.ts：JWT 验证（HS256，共享 JWT_SECRET env），claims 解析
2. server/routes/auth.ts（Hono）：
   - GET /api/auth/login-url：生成 PKCE(S256)+state，返回飞书 authorize URL（redirect_uri 按 E1 读码结论定）
   - GET/POST /api/auth/callback：接 code+state → 转调 maker /api/auth/login {code, codeVerifier, deviceId, clientType} → 拿 JWT → Set-Cookie httpOnly Secure SameSite=Lax → 302 回应用
   - GET /api/auth/me：验 cookie JWT → 返回用户信息（必要时代理 maker /api/user/me）
   - POST /api/auth/logout：清 cookie（+ 尽力转调 maker /logout）
   - DEV-only：POST /api/auth/dev-login（镜像 maker dev-login，生产剔除）
3. server/app.ts access gate 升级（F7）：JWT cookie 为第一公民；保留 MIVO_BFF_TOKEN 三方案为兼容通道；/healthz 与 /api/auth/* 白名单
4. 前端鉴权状态（⚠️ 2026-07-07 用户改需求：**不做硬登录墙/独立 LoginPage**，应用未登录可用，入口在侧栏用户 chip——见 E2 第 2 项）：src/store/authSlice.ts（useAuthStore：user/status/login()/logout()，/api/auth/me 水合；login() = 请求 /api/auth/login-url 后整页跳转飞书）；BFF gate 只保护 AI/生图/资产类 API，/api/auth/* 与画布本地功能不拦，未登录调受保护 API 返回 401 → 前端 toast 提示登录
5. PKCE 工具：src/lib/pkce.ts（Web Crypto 实现，逻辑搬 maker authManager PKCE 段）
6. maker 侧最小补丁（若读码证实必需）：XDMaker 分支 feat/web-client-auth，改动最小化并附理由
7. 单测：jwt 验证、gate 白名单/兼容通道、callback state 校验、dev-login DEV 门控

## Worker E2 · 设置界面 + key 链路（feat/auth-settings-keys）

范围（清单 F3/F4/F5/F6）：
1. src/store/settingsSlice.ts（Zustand persist→IDB）：两把 key 的存取（sk-/mivo_ 前缀校验、末 4 位掩码、keyHash 对账——搬 maker providerSecrets/keyFormat 逻辑到 src/lib/keyFormat.ts）
2. 设置入口 = 侧栏左下角用户 chip（⚠️ 2026-07-07 用户改需求，maker 同款，替换旧设置入口）：
   - **整块替换** ProjectSidebar.tsx 底部 settings-area（settings-row 按钮 + settingsMenuItems stub 菜单 + handleSettingsMenuItem，约 :53/:112/:150-152/:354/:456-479）——旧设置入口和配置不再需要，删除
   - 新组件 UserChip（放原 settings-area 位置）：未登录 → 「Log In」行，样式与侧栏底部现有行系列（settings-row 类样式）一致；已登录 → 圆形头像 + 姓名 + 副行「XD.Inc · v<版本>」（对照 maker 底部用户 chip 截图范式），数据来自 E1 的 useAuthStore
   - 点击行为：未登录 → useAuthStore.login()（跳飞书）；已登录 → 打开 SettingsPanel
   - src/app/settings/SettingsPanel.tsx：两区——「账号」（头像/姓名/飞书身份 + 登出按钮；接口约定 useAuthStore 的 user/logout）与「API Keys」
   - GatewayKeyDialog.tsx：改造 maker XdGatewayKeyDialog（sk- 校验 + Eye 掩码 + test-then-save + Loader + 成功关窗 + 「打开控制台」外链 console.tapsvc.com）
   - MivoKeySection.tsx：改造 maker ApiKeySection Mivo 子卡（mivo_ 前缀 + 700ms 防抖自动保存 useAutoSaveApiKey 模式 + 状态徽标）
3. server/routes/keys.ts：POST /api/keys/test——BFF 代测网关 key（GET https://llm-proxy.tapsvc.com/v1/models 验 Bearer，401→「Key 无效」），搬 maker bootstrap-electron.ts:3036-3049 逻辑
4. BFF 调用链 per-user 化（F6）：
   - 前端 mivoTaskClient 等请求注入 X-Mivo-Api-Key（+ 网关 key 预留 X-Gateway-Key 透传位，暂不接线业务）
   - server routes（generate/edit/enhance/tasks）优先取 header key，无则 fallback env（兼容现有部署）
   - server/platform/state.ts：session token / chat session 缓存按 key 指纹（sha256 前 16 位）分桶，含并发 promise 去重与 reset 测试钩子改造
5. 单测：keyFormat 校验、state 分桶（不同 key 不串 token）、keys/test 路由（mock fetch）、settingsSlice 持久化
6. UI 样式贴 MivoCanvas 现有面板体系（参考 ChangelogPanel/InspectorPanel），不引入 Tailwind

## 接口契约（E1↔E2 汇合点，lead 合并时验证）

- useAuthStore：{ user: {id,name,avatar}|null, status, logout() }（E1 出，E2 消费）
- 请求头：Cookie（JWT，浏览器自动带）+ X-Mivo-Api-Key（E2 注入）
- app.ts 只在 E1 动 gate 段、E2 动路由注册段，合并冲突点集中在 app.ts route mount 区
