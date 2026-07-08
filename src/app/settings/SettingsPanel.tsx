// src/app/settings/SettingsPanel.tsx
// Modal settings panel (two sections: Account + API Keys). Uses the same
// createPortal + backdrop + panel pattern as ChangelogPanel/DebugLog so it stays
// inside the project's existing panel vocabulary — no Tailwind, no new CSS framework.
//
// Account section consumes the E1 auth contract (user / logout). API Keys section
// owns the gateway key row inline (masked key + replace/disconnect) and renders
// MivoKeySection below it; the gateway key editor is GatewayKeyDialog (opened on
// "replace"/"configure").
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, X } from 'lucide-react'
import { useAuthStore } from '../../store/authSlice'
import { useSettingsStore, selectGatewayKeyMasked, selectHasGatewayKey } from '../../store/settingsSlice'
import { debugLogger } from '../../store/debugLogStore'
import { toastFeedback } from '../../store/toastStore'
import { GatewayKeyDialog } from './GatewayKeyDialog'
import { MivoKeySection } from './MivoKeySection'

type SettingsPanelProps = {
  onClose: () => void
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)

  const hasGatewayKey = useSettingsStore(selectHasGatewayKey)
  const gatewayMasked = useSettingsStore(selectGatewayKeyMasked)
  const clearGatewayKey = useSettingsStore((state) => state.clearGatewayKey)

  const [gatewayDialogOpen, setGatewayDialogOpen] = useState(false)

  const handleLogout = () => {
    debugLogger.log('Auth', 'Logout requested from settings panel')
    logout()
    toastFeedback.info('已登出')
    onClose()
  }

  const handleDisconnectGateway = () => {
    debugLogger.log('Settings', 'Gateway key disconnect requested')
    clearGatewayKey()
  }

  return createPortal(
    <div
      className="settings-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
        <header className="settings-panel-header">
          <strong>设置</strong>
          <button type="button" aria-label="关闭设置" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="settings-panel-body">
          <section className="settings-section">
            <h4>账号</h4>
            <div className="settings-account-row">
              <span className="user-chip-avatar" aria-hidden="true">
                {user?.avatar ? (
                  <img src={user.avatar} alt="" />
                ) : (
                  <span className="user-chip-avatar-fallback">{(user?.name || '?').slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              <div className="settings-account-info">
                <span className="settings-account-name">{user?.name || '未登录'}</span>
                <span className="settings-account-sub">XD.Inc · 飞书身份</span>
              </div>
              <button type="button" className="settings-logout-btn" onClick={handleLogout}>
                <LogOut size={15} /> 登出
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h4>API Keys</h4>
            <div className="gateway-key-row">
              <div className="gateway-key-row-info">
                <span className="gateway-key-row-title">XD 网关 Key</span>
                <span className="gateway-key-row-meta">
                  {hasGatewayKey ? `当前: ${gatewayMasked}` : '未配置 — 用于 AI 生图与增强'}
                </span>
              </div>
              <div className="gateway-key-row-actions">
                <button type="button" className="btn-pill btn-pill-secondary" onClick={() => setGatewayDialogOpen(true)}>
                  {hasGatewayKey ? '更换' : '配置'}
                </button>
                {hasGatewayKey ? (
                  <button type="button" className="gateway-key-disconnect" onClick={handleDisconnectGateway}>
                    断开
                  </button>
                ) : null}
              </div>
            </div>
            <MivoKeySection />
          </section>
        </div>
      </section>
      {gatewayDialogOpen ? <GatewayKeyDialog onClose={() => setGatewayDialogOpen(false)} /> : null}
    </div>,
    document.body,
  )
}
