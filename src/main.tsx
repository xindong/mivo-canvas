import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DebugReportsPage } from './app/DebugReportsPage.tsx'
import { useCanvasStore } from './store/canvasStore'
import { useChatStore } from './store/chatStore'
import { useAuthStore } from './store/authSlice'
import { getPersistUserId, namespacedKey } from './lib/persistUserId'
import { isLegacyKernel } from './app/kernelMode'
import { documentKey, sessionKey } from './kernel/docKernelPersistAdapter'
import { installRollbackTrigger } from './kernel/rollbackTrigger'

declare global {
  interface Window {
    __MIVO_E2E__?: {
      useCanvasStore: typeof useCanvasStore
      useChatStore: typeof useChatStore
      /** Current cache-namespace user id (FX-6). Exposed so the e2e harness can
       *  resolve the same namespaced IDB key the app writes WITHOUT a browser-side
       *  /src/lib/persistUserId.ts import — which 404s under the prod static dist
       *  server and trips the console-error MIME guard (mainfix R3). */
      getPersistUserId: typeof getPersistUserId
      /** Kernel mode flag (T1.2 dual-track). Exposed so the e2e harness can branch
       *  on kernel WITHOUT hardcoding — single source of truth is the app's own
       *  kernelMode.ts resolution (?kernel= / VITE_MIVO_KERNEL). */
      getKernelMode: () => 'new' | 'legacy'
      /** Physical IDB key the app's canvas persist layer uses for the DOCUMENT
       *  domain (canvases/projects/sceneId live here). Legacy kernel OR anonymous
       *  namespace → the single-blob key (where canvases always lived); kernel=new
       *  → the :document split key (docKernelPersistAdapter.documentKey).
       *  The e2e harness reads canvas persist through this so it observes the SAME
       *  physical key the app writes — no harness-side replication of the v11 split
       *  key layout (mask-hydration SC-15 was red under kernel=new because the
       *  harness read the legacy single-blob key while the app wrote :document). */
      getCanvasPersistDocumentKey: (name: string) => string
      /** Physical IDB key for the canvas persist SESSION domain (top-level
       *  selection/tools). Legacy/anonymous → single-blob key (same as document —
       *  legacy stores everything in one blob); kernel=new → :session split key. */
      getCanvasPersistSessionKey: (name: string) => string
    }
    __MIVO_E2E_ENABLED__?: boolean
    /** e2e opt-out: set via addInitScript to suppress first-login auto-prompt
     *  (AutoPromptSettings) in scenarios that don't test the prompt flow. */
    __MIVO_E2E_DISABLE_AUTO_PROMPT__?: boolean
  }
}

const debugReportsRequested =
  window.location.pathname === '/debug-reports' ||
  window.location.hash === '#/debug-reports' ||
  new URLSearchParams(window.location.search).has('debugReports')
const rootElement = debugReportsRequested ? <DebugReportsPage /> : <App />

if (window.__MIVO_E2E_ENABLED__ === true) {
  // getCanvasPersistDocumentKey/SessionKey route through the app's OWN key layout
  // (namespacedKey + docKernelPersistAdapter documentKey/sessionKey) so the harness
  // resolves the same physical IDB key the app writes under EITHER kernel — zero
  // hardcoding of the :document/:session suffix or the kernel flag on the harness side.
  window.__MIVO_E2E__ = {
    useCanvasStore,
    useChatStore,
    getPersistUserId,
    getKernelMode: () => (isLegacyKernel ? 'legacy' : 'new'),
    getCanvasPersistDocumentKey: (name: string) => (isLegacyKernel ? namespacedKey(name) : documentKey(name)),
    getCanvasPersistSessionKey: (name: string) => (isLegacyKernel ? namespacedKey(name) : sessionKey(name)),
  }
}

// T1.2 S6c:rollbackFromV11 诊断口子(仅 DEV——installRollbackTrigger 内 import.meta.env.DEV
// 正向门控,生产 if(false) tree-shake,零 window 写)。console 用:
// window.__MIVO_KERNEL_ROLLBACK__.run({ confirm: true })
installRollbackTrigger()

// SSO 网关方案:启动水合登录态(GET /api/auth/me,网关提供 / dev 桩)。
// 不阻塞渲染 —— 用户 chip 在 status='unknown' 时显示占位,水合完成后更新。
// TODO: SSO 网关登录失败时可能回跳带 error query(端点/参数待 ops 确认),届时补 toast。
void useAuthStore.getState().hydrate()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {rootElement}
  </StrictMode>,
)
