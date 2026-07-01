import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react'
import { useEffect } from 'react'
import { useToastStore, type ToastFeedbackEntry } from '../store/toastStore'

const levelLabels: Record<ToastFeedbackEntry['level'], string> = {
  success: 'Success',
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
}

const levelIcons = {
  success: CheckCircle2,
  info: Info,
  warning: TriangleAlert,
  error: XCircle,
}

function ToastItem({ entry, onDismiss }: { entry: ToastFeedbackEntry; onDismiss: (id: string) => void }) {
  const Icon = levelIcons[entry.level]

  useEffect(() => {
    if (entry.durationMs <= 0) return

    const timeout = window.setTimeout(() => onDismiss(entry.id), entry.durationMs)
    return () => window.clearTimeout(timeout)
  }, [entry.durationMs, entry.id, onDismiss])

  return (
    <li className={`toast-item ${entry.level}`} role="status" aria-live="polite">
      <Icon size={16} />
      <span className="toast-message">
        <b>{levelLabels[entry.level]}</b>
        {entry.message}
      </span>
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(entry.id)}>
        <X size={14} />
      </button>
    </li>
  )
}

export function ToastViewport() {
  const entries = useToastStore((state) => state.entries)
  const dismissToast = useToastStore((state) => state.dismissToast)

  if (!entries.length) return null

  return (
    <ol className="toast-viewport" aria-label="Notifications">
      {entries.map((entry) => (
        <ToastItem key={entry.id} entry={entry} onDismiss={dismissToast} />
      ))}
    </ol>
  )
}
