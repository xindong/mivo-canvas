import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DebugReportsPage } from './app/DebugReportsPage.tsx'
import { useCanvasStore } from './store/canvasStore'
import { useChatStore } from './store/chatStore'
import { useAuthStore } from './store/authSlice'

declare global {
  interface Window {
    __MIVO_E2E__?: {
      useCanvasStore: typeof useCanvasStore
      useChatStore: typeof useChatStore
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
  window.__MIVO_E2E__ = { useCanvasStore, useChatStore }
}

// SSO 网关方案:启动水合登录态(GET /api/auth/me,网关提供 / dev 桩)。
// 不阻塞渲染 —— 用户 chip 在 status='unknown' 时显示占位,水合完成后更新。
// TODO: SSO 网关登录失败时可能回跳带 error query(端点/参数待 ops 确认),届时补 toast。
void useAuthStore.getState().hydrate()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {rootElement}
  </StrictMode>,
)
