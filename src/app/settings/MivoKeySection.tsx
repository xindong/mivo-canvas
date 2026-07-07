// src/app/settings/MivoKeySection.tsx
// Mivo MCP key (mivo_) card. Ported from XDMaker ApiKeySection MivoApiKeySubsection:
//   - mivo_ prefix + length>=12 validation (no test-connection endpoint — mivo has
//     no cheap ping, validity is lazy-checked on first tool call)
//   - 700ms debounce auto-save (useAutoSaveApiKey pattern) + immediate save on blur
//   - needs-config / saved status badge with color dot
//   - Eye mask toggle, clear (Trash2) with the settingsSlice clear path
// Persistence is browser-side (settingsSlice → IDB); the BFF reads it per-request
// via X-Mivo-Api-Key.
//
// The input value is derived during render (isEditing ? draft : mivoKey) rather
// than synced via useEffect+setDraft — that avoids the react-hooks/set-state-in-
// effect rule and lets hydration / external clears flow into the field naturally.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Eye, EyeOff, Trash2 } from 'lucide-react'
import {
  selectHasMivoKey,
  selectMivoKeyMasked,
  useSettingsStore,
} from '../../store/settingsSlice'
import { isMivoKey } from '../../lib/keyFormat'

const MIVO_CONSOLE_URL = 'https://aigc.xindong.com'
const AUTOSAVE_DEBOUNCE_MS = 700

export function MivoKeySection() {
  const mivoKey = useSettingsStore((state) => state.mivoKey)
  const setMivoKey = useSettingsStore((state) => state.setMivoKey)
  const clearMivoKey = useSettingsStore((state) => state.clearMivoKey)
  const hasSavedKey = useSettingsStore(selectHasMivoKey)
  const masked = useSettingsStore(selectMivoKeyMasked)

  const [draft, setDraft] = useState(mivoKey)
  const [isEditing, setIsEditing] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSubmittedRef = useRef<string | null>(mivoKey || null)

  // Clear the debounce timer on unmount so a pending save doesn't fire after the
  // settings panel closes mid-edit. No setState here — just a teardown.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const submit = (value: string): void => {
    if (!isMivoKey(value)) return
    if (lastSubmittedRef.current === value) return
    lastSubmittedRef.current = value
    // setMivoKey is synchronous (store set) + logs the tail internally. No toast on
    // auto-save (too frequent); the clear path surfaces a toast via settingsSlice.
    setMivoKey(value)
  }

  const scheduleAutosave = (value: string): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const trimmed = value.trim()
    if (!isMivoKey(trimmed)) return
    if (mivoKey === trimmed) {
      lastSubmittedRef.current = trimmed
      return
    }
    if (lastSubmittedRef.current === trimmed) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      submit(trimmed)
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  const onBlur = (): void => {
    setIsEditing(false)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const trimmed = draft.trim()
    if (isMivoKey(trimmed)) submit(trimmed)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setIsEditing(false)
      setDraft(mivoKey)
      lastSubmittedRef.current = mivoKey || null
      event.currentTarget.blur()
    }
  }

  const handleClear = (): void => {
    clearMivoKey()
    setDraft('')
    setIsEditing(false)
    lastSubmittedRef.current = null
  }

  // While not editing, the field reflects the store (so hydration / external clears
  // show immediately). Once the user types, it reflects the local draft until blur.
  const inputValue = isEditing ? draft : mivoKey
  const validationError =
    inputValue.length > 0 && !inputValue.startsWith('mivo_') ? 'Key 需以 mivo_ 开头' : null

  return (
    <div className="mivo-key-section">
      <div className="mivo-key-head">
        <span className="mivo-key-title">Mivo Key</span>
        <span className={hasSavedKey ? 'mivo-key-badge saved' : 'mivo-key-badge needs-config'} role="status">
          <span className="mivo-key-dot" aria-hidden="true" />
          {hasSavedKey ? '已保存' : '未配置'}
        </span>
      </div>
      <p className="mivo-key-desc">用于 Mivo MCP 工具调用（无连通性测试，首次调用时验证）。</p>
      <div className="mivo-key-input-wrap">
        <input
          type={showKey ? 'text' : 'password'}
          value={inputValue}
          onChange={(event) => {
            setIsEditing(true)
            setDraft(event.target.value)
            scheduleAutosave(event.target.value)
          }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder="mivo_..."
          aria-label="Mivo Key"
          className={validationError ? 'mivo-key-input error' : 'mivo-key-input'}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="mivo-key-eye"
          aria-label={showKey ? '隐藏 Key' : '显示 Key'}
          onClick={() => setShowKey((current) => !current)}
        >
          {showKey ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
      </div>
      <div className="mivo-key-foot">
        {validationError ? (
          <span className="mivo-key-error" role="alert">
            {validationError}
          </span>
        ) : hasSavedKey ? (
          <span className="mivo-key-masked">当前: {masked}</span>
        ) : (
          <button
            type="button"
            className="mivo-key-console-link"
            onClick={() => window.open(MIVO_CONSOLE_URL, '_blank', 'noopener,noreferrer')}
          >
            打开控制台
          </button>
        )}
        {hasSavedKey ? (
          <button type="button" className="mivo-key-clear" aria-label="清除 Mivo Key" onClick={handleClear}>
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
