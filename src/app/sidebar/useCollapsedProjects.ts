// useCollapsedProjects — collapse persistence for project nodes (Phase 2 / A4·B13).
//
// localStorage key mivo.sidebar.collapsedProjects stores ONLY the collapsed
// project.id array (default expanded). Read/write is try/catch-silent so a
// unavailable / full storage never breaks the UI. The pure load/save helpers are
// exported so the invariants (key, only-collapsed-ids, default expanded, silent)
// are testable in vitest's node env without a DOM; the hook wraps them with
// useState/useEffect for the React surface.
import { useCallback, useEffect, useState } from 'react'

export const COLLAPSED_PROJECTS_STORAGE_KEY = 'mivo.sidebar.collapsedProjects'

/** Load the collapsed set from localStorage; empty set on missing/corrupt/error. */
export const loadCollapsedProjects = (): Set<string> => {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/** Persist the collapsed set to localStorage; silent no-op on error. */
export const saveCollapsedProjects = (collapsed: Set<string>): void => {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...collapsed]))
  } catch {
    // silent — storage unavailable / quota; the in-memory state still drives the UI.
  }
}

/** React hook: collapsed set + toggle/setCollapsed, persisted to localStorage. */
export const useCollapsedProjects = () => {
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => loadCollapsedProjects())

  useEffect(() => {
    saveCollapsedProjects(collapsed)
  }, [collapsed])

  const toggle = useCallback((id: string) => {
    setCollapsedState((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const setCollapsed = useCallback((id: string, isCollapsed: boolean) => {
    setCollapsedState((prev) => {
      const next = new Set(prev)
      if (isCollapsed) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  return { collapsed, toggle, setCollapsed }
}
