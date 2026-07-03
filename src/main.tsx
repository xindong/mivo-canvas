import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DebugReportsPage } from './app/DebugReportsPage.tsx'

const debugReportsRequested =
  window.location.pathname === '/debug-reports' ||
  window.location.hash === '#/debug-reports' ||
  new URLSearchParams(window.location.search).has('debugReports')
const rootElement = debugReportsRequested ? <DebugReportsPage /> : <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {rootElement}
  </StrictMode>,
)
