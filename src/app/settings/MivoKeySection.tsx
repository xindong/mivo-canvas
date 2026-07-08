// src/app/settings/MivoKeySection.tsx
// Mivo MCP key (mivo_) row — collapsed masked chip + "更换/配置" + "断开",
// 镜像网关 key 行的交互(用户实测 2026-07-08 要求一致)。点"配置/更换"开 MivoKeyDialog
// (弹窗输入 + mivo_ 格式校验,无连通性测试)。"断开"走 settingsSlice.clearMivoKey。
// 旧的内联自动保存 UI(useAutoSaveApiKey 那套)已删,统一弹窗流程。
import { useState } from 'react'
import {
  selectHasMivoKey,
  selectMivoKeyMasked,
  useSettingsStore,
} from '../../store/settingsSlice'
import { MivoKeyDialog } from './MivoKeyDialog'

export function MivoKeySection() {
  const hasMivoKey = useSettingsStore(selectHasMivoKey)
  const masked = useSettingsStore(selectMivoKeyMasked)
  const clearMivoKey = useSettingsStore((state) => state.clearMivoKey)
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div className="gateway-key-row mivo-key-row">
      <div className="gateway-key-row-info">
        <span className="gateway-key-row-title">Mivo Key</span>
        <span className="gateway-key-row-meta">
          {hasMivoKey ? `当前: ${masked}` : '未配置 — 用于 Mivo MCP 工具调用'}
        </span>
      </div>
      <div className="gateway-key-row-actions">
        <button
          type="button"
          className="btn-pill btn-pill-secondary"
          onClick={() => setDialogOpen(true)}
        >
          {hasMivoKey ? '更换' : '配置'}
        </button>
        {hasMivoKey ? (
          <button
            type="button"
            className="gateway-key-disconnect"
            onClick={clearMivoKey}
          >
            断开
          </button>
        ) : null}
      </div>
      {dialogOpen ? <MivoKeyDialog onClose={() => setDialogOpen(false)} /> : null}
    </div>
  )
}
