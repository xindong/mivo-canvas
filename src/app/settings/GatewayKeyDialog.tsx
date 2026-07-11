// src/app/settings/GatewayKeyDialog.tsx
// Gateway key (sk-) entry dialog. Ported from XDMaker XdGatewayKeyDialog:
//   - sk- prefix local validation
//   - Eye/EyeOff mask toggle
//   - test-then-save: POST /api/keys/test (BFF probes llm-proxy /v1/models) before
//     persisting; a 401 never writes the key
//   - Loader2 spinner while saving, success closes the dialog
//   - "打开控制台" external link to the XD gateway console (window.open, no Electron)
// Persistence is browser-side (settingsSlice → IDB); the BFF only probes.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, Eye, EyeOff, ExternalLink, Loader2, X } from 'lucide-react'
import { useSettingsStore } from '../../store/settingsSlice'
import { debugLogger } from '../../store/debugLogStore'
import { isImeComposing } from '../../lib/imeSafeEnter'
import { keyTail } from '../../lib/keyFormat'

const XD_GATEWAY_CONSOLE_URL = 'https://console.tapsvc.com/nova/#/ai-gateway?tab=keys'

type GatewayKeyDialogProps = {
  onClose: () => void
}

export function GatewayKeyDialog({ onClose }: GatewayKeyDialogProps) {
  const setGatewayKey = useSettingsStore((state) => state.setGatewayKey)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const canSave = key.startsWith('sk-') && !isSaving

  const save = async (): Promise<void> => {
    setErrorMessage(null)
    const trimmed = key.trim()
    if (!trimmed.startsWith('sk-')) {
      setErrorMessage('Key 需以 sk- 开头')
      return
    }
    setIsSaving(true)
    try {
      const res = await fetch('/api/keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
      })
      const result = (await res.json()) as { success: boolean; error?: string }
      if (!result.success) {
        setErrorMessage(result.error || 'Key 无效')
        debugLogger.warn('Settings', `gateway key test failed: tail=${keyTail(trimmed)}`)
        return
      }
      // test passed → persist. settingsSlice logs the tail + emits success toast.
      setGatewayKey(trimmed)
      debugLogger.log('Settings', `gateway key saved after probe: tail=${keyTail(trimmed)}`)
      onClose()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setErrorMessage('网络连接失败，请检查网络')
      debugLogger.error('Settings', `gateway key probe error: ${msg}`)
    } finally {
      setIsSaving(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(event)) return
    if (event.key === 'Enter' && canSave) {
      event.preventDefault()
      void save()
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
      <section className="gateway-key-dialog" role="dialog" aria-modal="true" aria-label="配置 XD 网关 Key" tabIndex={-1}>
        <header className="gateway-key-dialog-header">
          <strong>XD 网关 Key</strong>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <p className="gateway-key-dialog-desc">在 XD 网关控制台创建 Key 后粘贴到此处。保存前会先验证连通性，无效的 Key 不会保存。</p>
        <div className="gateway-key-input-wrap">
          <input
            ref={inputRef}
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="sk-..."
            aria-label="网关 Key"
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
          onClick={() => window.open(XD_GATEWAY_CONSOLE_URL, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink size={13} /> 打开控制台
        </button>
        <footer className="gateway-key-dialog-actions">
          <button type="button" className="btn-pill btn-pill-secondary" onClick={onClose} disabled={isSaving}>
            取消
          </button>
          <button type="button" className="btn-pill btn-pill-primary" onClick={() => void save()} disabled={!canSave}>
            {isSaving ? <Loader2 size={14} className="spin" /> : null}
            保存
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
