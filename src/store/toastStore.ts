import { create } from 'zustand'

export type ToastFeedbackLevel = 'success' | 'info' | 'warning' | 'error'

export type ToastFeedbackEntry = {
  id: string
  level: ToastFeedbackLevel
  message: string
  durationMs: number
}

type ToastFeedbackInput = {
  message: string
  durationMs?: number
}

type ToastFeedbackState = {
  entries: ToastFeedbackEntry[]
  addToast: (level: ToastFeedbackLevel, input: ToastFeedbackInput) => string
  dismissToast: (id: string) => void
  clearToasts: () => void
}

const maxToasts = 4
const defaultDurationMs = 3600
let nextToastId = 0

export const useToastStore = create<ToastFeedbackState>()((set) => ({
  entries: [],
  addToast: (level, input) => {
    const id = `toast-${Date.now()}-${nextToastId++}`

    set((state) => ({
      entries: [
        ...state.entries,
        {
          id,
          level,
          message: input.message,
          durationMs: input.durationMs ?? defaultDurationMs,
        },
      ].slice(-maxToasts),
    }))

    return id
  },
  dismissToast: (id) =>
    set((state) => ({
      entries: state.entries.filter((entry) => entry.id !== id),
    })),
  clearToasts: () => set({ entries: [] }),
}))

const addToast = (level: ToastFeedbackLevel, message: string, durationMs?: number) =>
  useToastStore.getState().addToast(level, { message, durationMs })

export const toastFeedback = {
  success: (message: string, durationMs?: number) => addToast('success', message, durationMs),
  info: (message: string, durationMs?: number) => addToast('info', message, durationMs),
  warn: (message: string, durationMs?: number) => addToast('warning', message, durationMs),
  error: (message: string, durationMs?: number) => addToast('error', message, durationMs),
  dismiss: (id: string) => useToastStore.getState().dismissToast(id),
  clear: () => useToastStore.getState().clearToasts(),
}
