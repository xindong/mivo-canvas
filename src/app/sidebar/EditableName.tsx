// EditableName — inline rename input (Phase 3 / A5).
//
// Triggered by the parent (double-click / menu). On enter: focus + select-all.
// Enter or Blur commits (trim; empty → onCancel, never writes an empty name).
// Escape cancels. committedRef prevents the blur-after-Enter double-submit.
//
// State-reset on entering edit mode uses the render-time "adjust state when a prop
// changed" pattern (React docs) rather than setState-in-an-effect, to satisfy the
// react-hooks/set-state-in-effect rule. Focus/select is a ref-driven effect (no
// setState).
import { useEffect, useRef, useState } from 'react'

export function EditableName(props: {
  value: string
  editing: boolean
  onSubmit: (next: string) => void
  onCancel: () => void
}) {
  const { value, editing, onSubmit, onCancel } = props
  const [draft, setDraft] = useState(value)
  const [prevEditing, setPrevEditing] = useState(editing)
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)

  // Render-time adjustment: when `editing` flips, reset the draft + commit guard.
  // React re-renders this same commit with prevEditing === editing, so it stabilizes.
  if (editing !== prevEditing) {
    setPrevEditing(editing)
    if (editing) {
      setDraft(value)
    }
  }

  useEffect(() => {
    if (!editing) return
    committedRef.current = false
    const id = requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    })
    return () => cancelAnimationFrame(id)
  }, [editing])

  if (!editing) return null

  const commit = () => {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = draft.trim()
    if (!trimmed) {
      onCancel()
      return
    }
    onSubmit(trimmed)
  }

  const cancel = () => {
    if (committedRef.current) return
    committedRef.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      className="sidebar-editable-name"
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
    />
  )
}
