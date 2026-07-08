import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DebugReportsPage } from './app/DebugReportsPage.tsx'
import { useCanvasStore } from './store/canvasStore'
import { useChatStore } from './store/chatStore'
import { useAuthStore } from './store/authSlice'
import { toastFeedback } from './store/toastStore'

declare global {
  interface Window {
    __MIVO_E2E__?: {
      useCanvasStore: typeof useCanvasStore
      useChatStore: typeof useChatStore
    }
    __MIVO_E2E_ENABLED__?: boolean
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

// feat/auth-feishu-login: 启动水合登录态(GET /api/auth/me,cookie 自动带)。
// 不阻塞渲染 —— 用户 chip 在 status='unknown' 时显示占位,水合完成后更新。
void useAuthStore.getState().hydrate()

// OAuth 回调失败时 BFF 302 到 /?auth_error=<reason>,这里 toast 提示并清掉 query。
const authError = new URLSearchParams(window.location.search).get('auth_error')
if (authError) {
  toastFeedback.warn(`登录失败:${authError}`)
  window.history.replaceState({}, '', window.location.pathname)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {rootElement}
  </StrictMode>,
)
