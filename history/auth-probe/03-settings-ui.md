# 03 — XDMaker(maker)设置界面与 key 管理 UI 探底报告

> 探底对象：`/Users/praise/AI-Agent/Claude/projects/Project XDMaker`
> 桌面端设置目录：`apps/desktop/src/renderer/components/settings/`
> 任务：只读摸清设置界面 IA + key 管理 UI + 状态/持久化 + 组件依赖 + 复用判定。
> 日期：2026-07-07。所有结论带 file:line 证据。

---

## 1. 设置界面整体信息架构

### 1.1 入口与路由

- 设置是独立路由视图 `SettingsView`，渲染在主布局右侧内容列。
  - `apps/desktop/src/renderer/components/settings/SettingsView.tsx:47` `export function SettingsView()`。
  - 通过 URL search param `?tab=<id>` 切换分区，`general` 为默认（无 `tab` 参数）。
  - `SettingsView.tsx:66-74` `activeTab` 从 `searchParams.get('tab')` 解析，含 legacy 别名映射（`remote`/`devices` → `remote-control`，`feishu-bot`/`slack-bot` → `im-bot`）。
  - `SettingsView.tsx:76-89` `handleSelectTab` 用 `setSearchParams(..., { replace: true })` 切换，不产生历史栈。
- 左侧是 sticky 内侧栏（tab list），右侧是滚动内容列（`max-w-[920px]` 居中）。
  - `SettingsView.tsx:128-175` aside（宽 `menuWidth`，默认 260px，`SettingsView.tsx:41`）+ nav tablist。
  - `SettingsView.tsx:181-452` 内容列按 `activeTab` 条件渲染各 tabpanel。
- deep-link：`?section=collaboration|notifications` → 滚动到 general tab 内某 section。
  - `SettingsView.tsx:108-119`。
- 返回：左上角 `ArrowLeft` 按钮 `navigate('/')`。`SettingsView.tsx:136-148`。

### 1.2 全部 section（tab）清单

tab id 与职责文件（`apps/desktop/src/renderer/lib/tabLabels.ts:5-21` 定义 16 个 tab；`SettingsView.tsx:183-450` 对应渲染）：

| tab id | 职责文件（settings/） | 职责 |
|---|---|---|
| `general` | `UserProfileCard` + `AppearanceSection` + `LanguageSection` + `NotificationSection` + `WindowBehaviorSection`(mac/win) + `CollaborationSection` + `ExperimentalSection` + `LogoutSection` | 通用偏好聚合；`SettingsView.tsx:183-252` |
| `personalization` | `UserPromptSection` + `MemorySection` + `CompactionSection` + `TerminalShellSection` + `LinkOpenSection` + `TipsSection` | 个性化/记忆/压缩；`SettingsView.tsx:254-284` |
| `providers` | `ProvidersSection.tsx` | **模型供应商管理（含 XD 网关 key）**；`SettingsView.tsx:336-346` |
| `api-keys` | `ApiKeySection.tsx` | **API 密钥页（Mivo key + Brave/Tavily 搜索 key）**；`SettingsView.tsx:286-297` |
| `voice-input` | `VoiceInputSection.tsx` (81KB) | 语音输入；`SettingsView.tsx:299-309` |
| `shortcuts` | `KeyboardShortcutsSection.tsx` | 快捷键改绑；`SettingsView.tsx:311-322` |
| `connections` | `ConnectionsSection.tsx` (32KB) | 飞书/Slack/Google 等外部连接；`SettingsView.tsx:324-334` |
| `remote-control` | `RemoteControlSection.tsx` + `RemoteHostDetail.tsx` | 远程机器/设备互联；`SettingsView.tsx:348-358` |
| `tina` | `TinaSection.tsx` | Tina；`SettingsView.tsx:360-366` |
| `builtin-tools` | `BuiltinToolsSection.tsx` | 内置工具；`SettingsView.tsx:368-378` |
| `computer-use` | `ComputerUseSection.tsx` (73KB) | 电脑操作；`SettingsView.tsx:380-390` |
| `agent-island` | `AgentIslandSection.tsx` (仅 macOS)；`SettingsView.tsx:392-402` |
| `import` | `SessionImportSection.tsx`；`SettingsView.tsx:404-414` |
| `im-bot` | `ImBotSection.tsx` | IM 机器人（飞书/Slack 合并）；`SettingsView.tsx:416-426` |
| `help` | `HelpSection.tsx` + `HelpAssistantPanel.tsx`；`SettingsView.tsx:428-438` |
| `about` | `AboutSection.tsx`；`SettingsView.tsx:440-450` |

> 注：`AddTokenAccountDialog.tsx`、`CustomProviderDialog.tsx`、`XdGatewayKeyDialog.tsx`、`SshKeySetupDialog.tsx`、`GoogleScopePickerDialog.tsx`、`SlackAccessLevelDialog.tsx` 等是各 section 触发的弹窗，不是独立 tab。

---

## 2. key 类 section 的 UI 细节

### 2.1 XdGatewayKeyDialog（XD 网关 key 录入弹窗）

文件：`apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx`。

- 触发：供应商页 XD 行「连接 / 更换 key」按钮 → `setKeyDialogOpen(true)`。
  - `ProvidersSection.tsx:690` `const [keyDialogOpen, setKeyDialogOpen] = useState(false);`
  - `ProvidersSection.tsx:752-760` 渲染 `<XdGatewayKeyDialog onClose onSaved />`。
- 表单校验：
  - `XdGatewayKeyDialog.tsx:36` `canSave = key.startsWith('sk-') && !isSaving`。仅做 `sk-` 前缀本地校验，真正有效性靠 `testApiKeyConnection`。
  - 保存按钮 `disabled={!canSave}`。`XdGatewayKeyDialog.tsx:152`。
  - Enter 键提交：`XdGatewayKeyDialog.tsx:47-55`。
- 掩码显示：`type={showKey ? 'text' : 'password'}` + Eye/EyeOff 切换按钮。`XdGatewayKeyDialog.tsx:95-119`。
- 保存/测试连通性/报错交互：
  - 复用 `useApiKey()` 的 `saveKey()`，链路是「**先 test 通过才落盘**」。`XdGatewayKeyDialog.tsx:31,42-45`。
  - test 失败：`useApiKey.ts:274-284` 设 `errorMessage` + `status='error'`，不写 safeStorage。
  - 报错展示：`XdGatewayKeyDialog.tsx:34` `errText = validationError || errorMessage`；`123-128` CircleAlert + 文案。
- 成功反馈：
  - `useApiKey.ts:296` `setSaveSuccess(true)`；1.5s 后复位（`useApiKey.ts:305-307`）。
  - `saveSuccess` 翻 true → `useEffect` 调 `onSaved()` 关弹窗 + 刷新供应商连接态。`XdGatewayKeyDialog.tsx:38-40`。
  - toast `apiKeySaved`。`useApiKey.ts:300`。
- 「打开控制台」外链：`XdGatewayKeyDialog.tsx:9` `XD_GATEWAY_CONSOLE_URL = 'https://console.tapsvc.com/nova/#/ai-gateway?tab=keys'`，`85` `window.electronAPI.openExternal(...)`。
- 按钮形态：次操作（关闭）= 描边 pill 在左；主操作（保存）= 实心 pill 在右；保存中 Loader2 spin。`XdGatewayKeyDialog.tsx:133-166`。

### 2.2 ProvidersSection（多供应商连接管理）

文件：`ProvidersSection.tsx`（37.6KB）。每行一个 `ProviderCell`，trailing 按供应商走不同 Row 组件：

- `AnthropicRow`（OAuth 登录/登出，`useCodexAuth` 同类通道）：`ProvidersSection.tsx:453-534`。
- `OpenAiRow`（OAuth，`useCodexAuth()`）：`ProvidersSection.tsx:539-592`。
- `XaiRow`（OAuth）：`ProvidersSection.tsx:594-676`。
- `XdGatewayRow`（**API key 录入型**，弹窗）：`ProvidersSection.tsx:684-763`。
- `CustomProviderRow`（用户自定义供应商，编辑/删除）：见 2.4。
- `AddCustomRow`（新增自定义供应商入口）：`ProvidersSection.tsx:925`、`1025`。

**XD 网关行交互**（`ProvidersSection.tsx:684-763`）：
- 已连接：trailing = `ConnectedPill` + `PillButton(断开)`（`704-708`），detail 行展示 masked key chip（`714` `maskKey` = `sk-••••••<末4位>`，`678-682`）+ 「更换 key」文字按钮（`730-737`）。
- 未连接：trailing = `PillButton(连接)`，点击开 `XdGatewayKeyDialog`（`710`）。
- 断开：confirm dialog → `clearKey()`。`692-702`。

### 2.3 ApiKeySection（Mivo + 搜索 key 页）

文件：`ApiKeySection.tsx`。三个并列子卡，用 `<div role="separator">` 分隔。`ApiKeySection.tsx:127-156`。

- `MivoApiKeySubsection`（`ApiKeySection.tsx:162-326`）：
  - 用 `useMivoApiKey()`。`162-174`。
  - 校验：`isMivoKeyComplete = startsWith('mivo_') && length >= 12`（`107-109`），validationError 由 hook 算（`useMivoApiKey.ts` `validationError = key.length>0 && !startsWith('mivo_')`）。
  - **自动保存**（无「测试连接」）：`useAutoSaveApiKey`（`44-105`）——输入后 700ms 防抖或 blur 时调 `saveKey()`，`canAutoSave` 过完整性检查才提交；失败清 lastSubmitted 允许重试（`67-73`）。
  - 掩码输入 + Eye 切换：`241-272`。
  - 状态徽标：`needs-config`/`saved` + 颜色 dot。`212-233`、`24-32`。
  - 清除：Trash2 按钮 → confirm dialog → `clearKey()` → toast。`189-203, 300-316`。
  - 成功/失败反馈：toast（`184-186`）；isSaving 时 Loader2 +「保存中」文案（`318-323`）。
  - 控制台外链：`https://aigc.xindong.com`。`288`。
  - 注释明确：「没有测试连接(mivo client 无廉价 ping 端点)」。`159-160`、`useMivoApiKey.ts` 头注。
- `LocalApiKeySubsection`（Brave / Tavily，`ApiKeySection.tsx:335-498`）：
  - 泛化组件，props: `storageKey / i18nKey / sourceUrl / isComplete`。`328-333`。
  - Brave 完整性 `/^BSA[a-zA-Z0-9_-]{10,}$/ || length>=24`（`111-113`）；Tavily `startsWith('tvly-') && length>=12`（`115-117`）。
  - 同样走 `useAutoSaveApiKey` + `useLocalApiKey({ storageKey })` + Eye + Trash2 + confirm + toast。
  - 外链：Brave `https://api-dashboard.search.brave.com/app/keys`、Tavily `https://app.tavily.com/home`。`139, 151`。

### 2.4 自定义供应商弹窗（CustomProviderDialog）

- 入口：`ProvidersSection.tsx:1029-1040` `<CustomProviderDialog initial existingIds onClose onSaved />`。
- 模式：`{mode:'create'}` 或 `{mode:'edit', config}`。`ProvidersSection.tsx:930-932`。
- 编辑回填密钥：`readCustomProviderKey(providerId, agent)` 明文回显（`customProviders.ts:26-40`）。
- 表单校验/重名 reject：`createCustomProvider` 先写配置，IPC 在重名/非法时 reject 才存密钥（`customProviders.ts:51-56`）。`existingIds` 传给弹窗做唯一性校验。

---

## 3. 设置数据的状态管理与持久化路径

### 3.1 key 的状态管理（renderer 侧 hooks）

三套并行的 key hook，范式一致（reconcile on mount → save → clear → 广播）：

| hook | 用途 | 文件 |
|---|---|---|
| `useApiKey` | XD 网关 key（`sk-`，带 test connection） | `apps/desktop/src/renderer/hooks/useApiKey.ts` |
| `useMivoApiKey` | Mivo key（`mivo_`，无 test） | `apps/desktop/src/renderer/hooks/useMivoApiKey.ts` |
| `useLocalApiKey` | Brave/Tavily 搜索 key（泛化 storageKey） | `apps/desktop/src/renderer/hooks/useLocalApiKey.ts` |

- `useApiKey` 的跨实例同步：模块级 `apiKeyChangeListeners` Set + `broadcastApiKeyChange`，save/clear 成功后广播给所有挂载实例（ApiKeySection / ProvidersSection / ChatInput pre-check）。`useApiKey.ts:95-105, 299, 379`。
- 模块级 reconcile 去重：`initialReconcileInFlight` promise 缓存，save/clear 后 `invalidateReconcileCache`。`useApiKey.ts:50-81`。
- 切账号防污染：`onAuthStateChange` → logout 广播 null / login 重读。`useApiKey.ts:115-130`。
- `useMivoApiKey` / `useLocalApiKey` 更轻：无广播、无 test，仅 mount 读 + save/clear。`useMivoApiKey.ts` 全文、`useLocalApiKey.ts` 全文。

### 3.2 key 的持久化路径（本地 only，从不上云）

- **SSoT 存储键名**：`apps/desktop/src/shared/providerSecrets.ts`。
  - `ProviderSecretId = 'xd' | 'mivo' | 'brave' | 'tavily' | 'xai'`（`providerSecrets.ts:27`）。
  - 映射：`xd → 'api_key'`、`mivo → 'mivo_api_key'`、`brave → 'brave_search_api_key'`、`tavily → 'tavily_api_key'`、`xai → 'provider_key_xai'`（`providerSecrets.ts:34-46`）。
  - 自定义供应商 per-runtime：`customProviderSecretStorageKey(id, agent) = 'provider_key_<id>_<agent>'`（`providerSecrets.ts:62-67`）。
- **存储介质**：Electron `safeStorage`（OS keychain/DPAPI 加密的 `.enc` 文件，目录 `userData/safe-storage/<key>.enc`）。
  - main 端封装：`apps/desktop/src/main/secrets/providerSecretStore.ts:30-60`（`secretDir = userData/safe-storage`，`electronSecretIo` 用 `safeStorage.encryptString/decryptString` + base64 fs）。
  - renderer 经 IPC 读写：`window.electronAPI.safeStorageRead/Store/Remove`（`useApiKey.ts:60, 248, 286, 354`；`useMivoApiKey.ts`；`useLocalApiKey.ts`）。
  - preload 暴露：`apps/desktop/src/preload/preload.ts`（`safeStorage*` + `testApiKeyConnection`，`preload.ts:1401-1402`）。
- **测试连通性**：`api-key:test-connection` IPC handler —— `net.fetch('https://llm-proxy.tapsvc.com/v1/models', { headers: { Authorization: 'Bearer '+key } })`，200=success / 401=「Key 无效」/ 其它=「服务异常 HTTP N」/ 网络错=「网络连接失败」。`apps/desktop/src/main/bootstrap-electron.ts:3031-3051`。
- **账号边界**：`provider_secret_owner` 标记键记录密钥归属账号，同机换账号时清旧密钥。`providerSecretStore.ts:14-19`。

### 3.3 非密钥设置（供应商配置等）

- 自定义供应商配置（baseUrl/models/headers，不含密钥）走 maker IPC 写入 `localDb`：`window.electronAPI.maker.createCustomProvider/updateCustomProvider/deleteCustomProvider`。`customProviders.ts:51-66`。
- 密钥与配置分离：配置在 localDb，密钥在 safeStorage。`customProviders.ts:1-10` 注释。
- 变更生效：
  - key 写入 safeStorage 后 **热生效**（下次 main 路由 resolve 读出即用），无需重启；`useApiKey.ts:289-299`。
  - 供应商配置变更后 main 广播 `PROVIDER_CHANGED` → `useProviders()` 自动 refetch。`ProvidersSection.tsx:957, 1034-1038`。
  - `providerSecretStore.ts` 注释：set/remove 不触发副作用（如 Codex 重建），那是 safe-storage IPC 层 `onApiKeyChangedMaybeRestartCodex` 的职责（`providerSecretStore.ts:24-30`）。即某些 runtime 可能需重启 Codex。

---

## 4. 设置界面的组件依赖（可移植性评估）

- **样式体系**：Tailwind + CSS 变量（`var(--settings-*)`、`var(--confirm-btn-*)`、`var(--error-*)`），深浅色由 globals.css 同名变量切换。`XdGatewayKeyDialog.tsx:60-160`、`ApiKeySection.tsx:213-258`。
- `cn` 工具：`clsx` + `extendTailwindMerge`。`apps/desktop/src/renderer/lib/utils.ts:1-20`。
- **通用组件**：
  - `ConfirmDialog`（基于 `@radix-ui/react-alert-dialog`）+ `useConfirmDialog()` provider。`apps/desktop/src/renderer/components/ui/confirm-dialog.tsx:1-60`。破坏性操作（清除/断开/删除）一律走 confirm。
  - `toast`（`apps/desktop/src/renderer/lib/toast.ts`）—— success/error 反馈。
  - `lucide-react` 图标（Eye/EyeOff/Trash2/Loader2/CircleAlert/ExternalLink/ArrowLeft/ChevronRight）。
  - `useTranslation()`（react-i18next）—— 全部文案 i18n 化。
- **Electron 依赖**（搬到 MivoCanvas 需替换）：
  - `window.electronAPI.safeStorageRead/Store/Remove` —— 加密存储。
  - `window.electronAPI.testApiKeyConnection` —— 连通性测试（main 端 fetch）。
  - `window.electronAPI.openExternal` —— 打开外链。
  - `window.electronAPI.onAuthStateChange` —— 账号切换广播。
  - `window.electronAPI.maker.*` —— 自定义供应商配置 CRUD。
- **状态库**：React `useState/useEffect` + 模块级单例（listener Set / promise 缓存），**未用 Zustand/Redux**。key hook 是自包含的，移植时连同 hook 一起搬即可。

---

## 5. 多 key / 多 provider 管理范式总结

maker 的 key 管理是「**按 providerId 分桶，每桶一个 key + 一个连接态**」，不是多 key 列表式管理：

- **增**：内置 provider 走 OAuth 登录或弹窗录入（XD）；自定义 provider 走 `CustomProviderDialog` 填 baseUrl + per-runtime key。
- **删**：内置 = 断开（clearKey / OAuth logout，confirm 二次确认）；自定义 = 删除（deleteCustomProvider，删配置 + 清密钥，confirm 二次确认）。`ProvidersSection.tsx:947-965`。
- **改**：XD = 「更换 key」重开弹窗；自定义 = 编辑弹窗（密钥留空 = 不改）。`customProviders.ts:58-63`。
- **查**：`useProviders()` 返回 `ProviderView[]`，`provider.connected` 为连接态。`ProvidersSection.tsx:925, 935-939`。
- **默认项切换**：maker 没有显式「默认 provider」概念——模型可见性按 per-model 开关控制（`ModelListPanel` + `useModelVisibilityVersion`，`ProvidersSection.tsx:222-360`），路由在 main 端按 provider + agent resolve。
- **掩码**：XD 行 `sk-••••••<末4位>`（`ProvidersSection.tsx:678-682`）；输入框 `password` type + Eye 切换（`XdGatewayKeyDialog.tsx:95-119`）。
- **状态徽标**：`needs-config` / `saved` / `connected` / `error` 四态（`useApiKey.ts:132`），`ApiKeySection` 的 mivo/brave/tavily 简化为 `needs-config` / `saved` 两态（`useMivoApiKey.ts` `MivoApiKeyStatus`）。
- **反馈三层**：按钮内 Loader2 spin（进行中）+ 文案徽标（状态）+ toast（结果）。清除/断开/删除等破坏性操作加 confirm dialog。

---

## 复用判定素材（给 MivoCanvas 第一版设置界面）

MivoCanvas 第一版只需管理 **2 个 key**：个人网关 key（`sk-`，对应 maker 的 XD 网关 key）+ mivo MCP api key（`mivo_`，对应 maker 的 Mivo key）。maker 侧这两个 key 的形态、校验、存储键名都已现成。

### 直接借鉴复刻（高价值，省设计）

1. **存储键名 SSoT 模式** —— `providerSecrets.ts:27-46` 的 `ProviderSecretId → 存储 key` 映射。MivoCanvas 直接抄两层结构：`xd → 'api_key'`、`mivo → 'mivo_api_key'`，键名与 maker 一致，未来若共用 safeStorage 可互通。
   - 痛点：避免 MivoCanvas 自己重新起名导致跨工具无法对齐。
2. **`useMivoApiKey` hook 整体复刻** —— `useMivoApiKey.ts` 全文。Mivo key 的 `mivo_` 前缀校验、mount 读 + save/clear、无 test connection 的范式，与 MivoCanvas 的 mivo MCP api key 需求**完全一致**，几乎可逐字搬。
   - 痛点：MivoCanvas 不用 Electron，需把 `safeStorageRead/Store/Remove` 换成浏览器侧的加密存储/IndexedDB（Zustand persist 已是项目栈，见 MivoCanvas `src/store`）。
3. **`useApiKey` 的 test-then-save 链路** —— `useApiKey.ts:272-314`。个人网关 key 需要「先 test 通过才落盘」的语义（调 `/v1/models` 验 Bearer key），maker 的 `api-key:test-connection` handler（`bootstrap-electron.ts:3031-3051`）逻辑可直接抄成 MivoCanvas BFF 的一条 `/api/keys/test` 路由。
   - 痛点：直接保存坏 key 会误显示「已保存」，后续请求用坏 token；test 门槛挡住误存。
4. **`XdGatewayKeyDialog` 弹窗 UI** —— `XdGatewayKeyDialog.tsx` 全文。`sk-` 前缀本地校验 + Eye 掩码 + Enter 提交 + Loader2 + 成功后 1.5s onSaved 关窗 + 「打开控制台」外链，这套交互直接复刻成 MivoCanvas 的「个人网关 key」录入弹窗。
   - 痛点：避免重新设计弹窗交互细节（掩码/校验/反馈）。
5. **`useAutoSaveApiKey` 防抖自动保存** —— `ApiKeySection.tsx:44-105`。Mivo key 这类「无 test connection」的 key 用 700ms 防抖 + blur 触发自动保存，比手动「保存」按钮更顺手。
   - 痛点：手动保存按钮多一次点击，且用户易忘点保存。
6. **状态徽标 + 颜色 dot** —— `ApiKeySection.tsx:212-233, 24-32`。`needs-config`/`saved` 两态徽标 + 灰度 dot，用 CSS 变量 `--settings-badge-*`。
   - 痛点：用户看不出 key 是否已配。
7. **破坏性操作 confirm + toast 三层反馈** —— `ApiKeySection.tsx:189-203`、`ProvidersSection.tsx:692-702`。清除 key 走 confirm dialog + 结果 toast。
   - 痛点：误触清除 key 不可逆。

### 过重可砍掉（第一版不需要）

1. **多供应商/自定义供应商管理** —— `ProvidersSection.tsx` 的 `AnthropicRow`/`OpenAiRow`/`XaiRow`/`CustomProviderRow`/`AddCustomRow`/`CustomProviderDialog` + `useProviders()` + per-model 可见性开关 + `ModelListPanel`。MivoCanvas 第一版只 2 个固定 key，不需要 provider CRUD、模型列表、per-runtime 密钥。
   - 价值：低；直接砍。
2. **OAuth 登录/登出链路** —— `useCodexAuth()`、Anthropic/OpenAI/xAI 的 OAuth 流程。MivoCanvas 两个 key 都是 API key 录入型，无 OAuth。
3. **跨实例广播 + 模块级 reconcile 去重** —— `useApiKey.ts:95-130` 的 `apiKeyChangeListeners` + `initialReconcileInFlight` + `onAuthStateChange`。这是 maker 多 consumer（设置页 + 供应商页 + ChatInput pre-check + useVendorReadiness）才需要的；MivoCanvas 第一版 key consumer 少，单 hook 实例就够，不需要广播。
   - 价值：低；第一版砍，等 consumer 变多再加。
4. **账号边界 / 切账号防污染** —— `providerSecretStore.ts:14-19` 的 `provider_secret_owner` + `useApiKey.ts:115-130` 的 `handleAuthStateChangeForApiKey`。MivoCanvas 第一版无多账号登录场景。
5. **`testApiKeyConnection` 的 Electron main 端 fetch** —— `bootstrap-electron.ts:3031-3051`。逻辑保留（抄成 BFF 路由），但 Electron `net.fetch` + IPC 这层不需要，MivoCanvas 走 Vite BFF（hono，见 `server/`）。
6. **i18n 全量化** —— maker 所有文案走 `t('settings.apiKey.*')`。MivoCanvas 第一版可先硬编码中文，后续再接 i18n。
7. **Tailwind + 大量 CSS 变量主题体系** —— maker 用 `var(--settings-*)` 全套。MivoCanvas 已有自己的 React + Zustand 栈，样式按项目既有约定走即可，只借鉴「徽标 dot + 掩码 input + confirm/toast」交互模式，不照搬变量名。

### 关键复用决策

- **两个 hook 直接抄**：`useMivoApiKey`（无 test）+ `useApiKey`（带 test），把 `window.electronAPI.safeStorage*` 换成 MivoCanvas 的持久层（Zustand persist + IndexedDB，见 `src/store`），`testApiKeyConnection` 换成 BFF `/api/keys/test`。
- **一个弹窗 + 一个 section 卡直接抄**：`XdGatewayKeyDialog`（网关 key 弹窗）+ `MivoApiKeySubsection`（mivo key 卡），去掉 Electron 依赖后即可用。
- **砍掉整块 ProvidersSection 的多供应商 UI**，只保留「单 key 卡 + 状态徽标 + 清除按钮」这一垂直组合。

---

## 附：关键文件索引

| 主题 | 文件 |
|---|---|
| 设置 IA / tab 路由 | `apps/desktop/src/renderer/components/settings/SettingsView.tsx` |
| tab 定义 | `apps/desktop/src/renderer/lib/tabLabels.ts` |
| XD 网关 key 弹窗 | `apps/desktop/src/renderer/components/settings/XdGatewayKeyDialog.tsx` |
| 供应商管理（多 provider） | `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx` |
| API 密钥页（mivo/brave/tavily） | `apps/desktop/src/renderer/components/settings/ApiKeySection.tsx` |
| 自定义供应商弹窗 | `apps/desktop/src/renderer/components/settings/CustomProviderDialog.tsx` |
| XD key hook（带 test） | `apps/desktop/src/renderer/hooks/useApiKey.ts` |
| Mivo key hook（无 test） | `apps/desktop/src/renderer/hooks/useMivoApiKey.ts` |
| 搜索 key hook（泛化） | `apps/desktop/src/renderer/hooks/useLocalApiKey.ts` |
| 自定义供应商 CRUD 编排 | `apps/desktop/src/renderer/lib/customProviders.ts` |
| 存储键名 SSoT | `apps/desktop/src/shared/providerSecrets.ts` |
| safeStorage main 端封装 | `apps/desktop/src/main/secrets/providerSecretStore.ts` |
| testApiKeyConnection IPC | `apps/desktop/src/main/bootstrap-electron.ts:3031-3051` |
| preload 暴露 | `apps/desktop/src/preload/preload.ts:1401-1402` |
| confirm dialog UI | `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx` |
| toast | `apps/desktop/src/renderer/lib/toast.ts` |
| cn 工具 | `apps/desktop/src/renderer/lib/utils.ts` |
