// src/app/settings/MivoKeyDialog.tsx
// Mivo key (mivo_) entry dialog. 镜像 GatewayKeyDialog 的弹窗流程(用户实测 2026-07-08
// 要求 mivo key 与网关 key 交互一致),但**不做连通性测试** —— mivo 无廉价 ping,有效性
// 在首次工具调用时懒验证。保存时只做 mivo_ 前缀 + 长度校验(复用 keyFormat.isMivoKey)。
//   - mivo_ 前缀 + 长度>=12 本地校验
//   - Eye/EyeOff mask toggle
//   - "打开控制台" 外链(aigc.xindong.com)
//   - 保存成功关窗(setMivoKey 内部 log tail + toast)
// 复用 gateway-key-dialog 的 CSS class(同款 UI)。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, Eye, EyeOff, ExternalLink, X } from 'lucide-react'
import { useSettingsStore } from '../../store/settingsSlice'
import { debugLogger } from '../../store/debugLogStore'
import { isMivoKey, keyTail } from '../../lib/keyFormat'

const MIVO_CONSOLE_URL = 'https://aigc.xindong.com'

type MivoKeyDialogProps = {
  onClose: () => void
}

export function MivoKeyDialog({ onClose }: MivoKeyDialogProps) {
  const setMivoKey = useSettingsStore((state) => state.setMivoKey)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // mivo_ 前缀 + 长度>=12(isMivoKey)。无连通性测试,故无 isSaving 态。
  const canSave = isMivoKey(key.trim())

  const save = (): void => {
    setErrorMessage(null)
    const trimmed = key.trim()
    if (!trimmed.startsWith('mivo_')) {
      setErrorMessage('Key 需以 mivo_ 开头')
      return
    }
    if (!isMivoKey(trimmed)) {
      setErrorMessage('Key 格式无效(需 mivo_ 前缀 + 至少 12 字符)')
      return
    }
    // 无连通性测试:格式校验通过即保存。setMivoKey 内部 log tail + toast。
    setMivoKey(trimmed)
    debugLogger.log('Settings', `mivo key saved (no probe, format-only): tail=${keyTail(trimmed)}`)
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && canSave) {
      event.preventDefault()
      save()
    }
    if (event.key === 'Escape') onClose()
  }

  return createPortal(
    <div
      className="settings-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section className="gateway-key-dialog" role="dialog" aria-modal="true" aria-label="配置 Mivo Key" tabIndex={-1}>
        <header className="gateway-key-dialog-header">
          <strong>Mivo Key</strong>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="gateway-key-dialog-desc">用于 Mivo MCP 工具调用（无连通性测试，首次调用时验证）。在 Mivo 控制台创建 Key 后粘贴到此处。</p>
        <div className="gateway-key-input-wrap">
          <input
            ref={inputRef}
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="mivo_..."
            aria-label="Mivo Key"
            className={errorMessage ? 'gateway-key-input error' : 'gateway-key-input'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="gateway-key-eye"
            aria-label={showKey ? '隐藏 Key' : '显示 Key'}
            onClick={() => setShowKey((current) => !current)}
          >
            {showKey ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </div>
        {errorMessage ? (
          <p className="gateway-key-error" role="alert">
            <CircleAlert size={14} /> {errorMessage}
          </p>
        ) : null}
        <button
          type="button"
          className="gateway-key-console-link"
          onClick={() => window.open(MIVO_CONSOLE_URL, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={13} /> 打开控制台
        </button>
        <footer className="gateway-key-dialog-actions">
          <button type="button" className="btn-pill btn-pill-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn-pill btn-pill-primary" onClick={save} disabled={!canSave}>
            保存
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
