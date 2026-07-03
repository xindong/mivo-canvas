import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DebugReportsPage } from './app/DebugReportsPage.tsx'
import { useCanvasStore } from './store/canvasStore'
import { useChatStore } from './store/chatStore'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {rootElement}
  </StrictMode>,
)
