# 需求单：maker 内置浏览器向 mivo 页面注入 makerBridge（路线 A · 单用户）

> 发起方：mivo-canvas 团队 ｜ 2026-07-11
> 目标版本参照：maker v0.0.148（调研基线，升版需复核）
> 性质：小改（一个 preload 文件 + 一个 will-attach-webview 分支 + 一组 ipcMain handler），maker 代码库内已有两个同模式先例（browserCommentPreload / ghostPreload）

## 一、背景与目标（为什么）

mivo-canvas 正在把输入框 agent 化：高频出图操作在 mivo 内完成（不依赖 maker）；**复杂/跨系统任务（飞书、Jira、资产库工作流）希望委派给 maker 会话执行**，继承 maker 的全套 MCP 工具生态，不重造。

方案：用户在 maker 内置浏览器里打开 mivo，maker 向该页面注入 `window.makerBridge`，mivo 前端经它驱动 maker 会话（建会话 / 发消息 / 收完成通知），实现"mivo 画布 ↔ maker 会话"1:1 映射。

**本期为路线 A（单用户）**：bridge 只服务"在自己 maker 里打开 mivo"的本人，用本人凭据与会话。不涉及多租户。

## 二、改动清单（改什么，三件套）

### 1. `mivoPreload.js`（新增 preload 文件）

照 `ghostPreload.js` 的模式（`contextBridge.exposeInMainWorld`），暴露白名单 API：

```js
contextBridge.exposeInMainWorld("makerBridge", {
  // 握手与能力检测（mivo 渐进增强的探测点：无此对象 = 普通浏览器，深水道功能不亮）
  getContext: () => ipcRenderer.invoke("mivo-bridge:get-context"),
  // → { bridgeVersion, makerVersion, currentWorkdir }

  // 会话生命周期
  createSession: (opts) => ipcRenderer.invoke("mivo-bridge:create-session", opts),
  // opts: { title, initialMessage?, agent?, model? } → { sessionId }
  // 语义：等价 send_to_session(create) / create_worker；继承 maker 当前 workdir 即可（路线 A 接受）

  sendMessage: (opts) => ipcRenderer.invoke("mivo-bridge:send-message", opts),
  // opts: { sessionId, message } → { wakeKind }  // 复用现有撞忙入队语义（queued）

  renameSession: (opts) => ipcRenderer.invoke("mivo-bridge:rename-session", opts),
  // opts: { sessionId, title } → { ok }          // 复用 rename_sessions 内部实现

  archiveSession: (opts) => ipcRenderer.invoke("mivo-bridge:archive-session", opts),
  // opts: { sessionId } → { ok }

  // 事件下行（v1 最低要求：完成/失败通知；流式不在本期）
  onSessionEvent: (cb) => { /* 订阅 turn 完成/失败/归档事件，返回取消函数 */ },
  // event: { sessionId, kind: "turn-done" | "turn-error" | "archived", finalText? }
  // 实现建议：复用 orca worker "完成后自动 push lead" 的同一通知源
})
```

### 2. `will-attach-webview` 增加 mivo 识别分支

现有钩子（bootstrap-electron @ ~9783023）已按 partition 前缀路由 ghost / 默认 comment preload。增加一个分支：

- 识别方式二选一（maker 团队定）：**src 域名 allowlist**（mivo 部署域，建议做成可配置）或**专用 partition 前缀**（如 `mivo-bridge-`）
- 命中 → `webPreferences.preload = mivoPreload.js` 路径
- **保持现有 hardening 不变**：`sandbox:true / contextIsolation:true / nodeIntegration:false / webSecurity:true`（调研确认该加固下 preload 注入依然可用）

### 3. `ipcMain.handle("mivo-bridge:*")` handler 组

- 路由到 maker 既有 session 能力（与 `send_to_session` / `rename_sessions` / 归档同一内部实现，不新造逻辑）
- **安全边界**：仅处理来自 mivo 分支 webview 的调用（校验 sender webContents）；参数 schema 校验；未识别 channel 一律拒绝
- 撞忙语义沿用现有持久化入队（`wake_kind=queued`），不新增 BUSY 分支

## 三、明确不在本期范围（路线 B，另行评估）

1. 多租户 / impersonation（多个 mivo 用户共用一个 maker）
2. 指定 workdir 创建会话（本期接受"继承当前 workdir"）
3. 流式输出 / turn 进度订阅（本期只要完成/失败通知）
4. Fork / Rewind 的编程式接口

## 四、验收标准

| # | 场景 | 预期 |
|---|------|------|
| 1 | maker 内置浏览器打开 mivo 域页面 | `window.makerBridge` 存在，`getContext()` 返回版本信息 |
| 2 | mivo 调 `createSession` | maker 侧出现新会话（当前 workdir 下），返回 sessionId |
| 3 | `sendMessage` 到运行中会话 | 返回 `wakeKind:"queued"`，turn 结束后消息被处理（不丢、不拒） |
| 4 | 会话 turn 完成 | mivo 侧 `onSessionEvent` 收到 `turn-done` + 最终文本 |
| 5 | `renameSession` / `archiveSession` | maker UI 同步可见 |
| 6 | 普通 Chrome 打开同一 mivo 页面 | 无 `makerBridge`，页面正常（mivo 自动降级） |
| 7 | 非 allowlist 域名的 webview | 不注入 mivoPreload，`mivo-bridge:*` 调用被拒 |

## 五、版本协商要求

`getContext()` 必须返回 `bridgeVersion`（语义化版本）。maker 后续升级若变更 bridge API，bump 该版本号；mivo 按版本做兼容降级，避免 maker 自动更新静默打断集成。

## 六、调研依据（供 maker 团队核对）

以下均出自 maker v0.0.148 `app.asar` 静态分析（路径 @ 字节偏移可提供）：

- `will-attach-webview` 钩子改写 `webPreferences.preload` 的既有实现：`bootstrap-electron-CYWwfDQS.js` @ ~9783023，`applyWebviewHardening` / `getBrowserCommentPreloadPath`
- preload 注入先例一：`browserCommentPreload.js`（14.6KB，标注/截图/设计预览，ipcRenderer 双向）
- preload 注入先例二：`ghostPreload.js`（307B，`exposeInMainWorld("cindy", {ping/send/onHostMessage})`），配 ghost partition 路由（`cindy-ghost-` 前缀，飞书 /ctr 接管的底座）
- 撞忙入队语义既有实现：`agent_input_queue_snapshots` 持久化队列 + `wake_kind=queued`

即：本需求 = 把 ghostPreload 模式复刻一份给 mivo 域 + handler 接到既有 session 能力上，无新架构。
