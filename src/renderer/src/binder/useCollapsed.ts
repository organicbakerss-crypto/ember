import { useCallback, useState } from 'react'

const key = (arcId: string) => `binder.collapsed.${arcId}`

function read(arcId: string): boolean | null {
  try {
    const value = localStorage.getItem(key(arcId))
    return value === null ? null : value === 'true'
  } catch {
    return null
  }
}

/**
 * Which arcs are folded. Device-only view state, kept in this window's
 * storage. Finished arcs start folded until the user opens them.
 */
export function useCollapsed() {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  const isCollapsed = useCallback(
    (arcId: string, finished: boolean) => overrides[arcId] ?? read(arcId) ?? finished,
    [overrides],
  )

  const setCollapsed = useCallback((arcId: string, collapsed: boolean) => {
    setOverrides((o) => ({ ...o, [arcId]: collapsed }))
    try {
      localStorage.setItem(key(arcId), String(collapsed))
    } catch {
      // Storage unavailable: the choice lasts until the window closes.
    }
  }, [])

  return { isCollapsed, setCollapsed }
}
