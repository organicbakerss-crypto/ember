import { useCallback, useEffect, useId, useState } from 'react'
import { api, useIpcEvent } from '../api'
import { flushAll } from '../saving'
import { usePane } from './PaneContext'

/**
 * One place edits a document at a time (a chapter, an entry's page); see
 * docLeases in main. `editing` is null while asking, then true here or
 * false (another window or pane has it: show it read-only and kept live).
 * `take` moves editing here: the other place saves and stops first, then
 * `before` runs (to load the saved text), then this place edits.
 */
export function useDocLease(key: string) {
  const pane = usePane()
  const holder = `${pane.id}:${useId()}`
  const [state, setState] = useState<{ key: string; editing: boolean | null }>({
    key,
    editing: null,
  })
  if (state.key !== key) setState({ key, editing: null })
  const editing = state.key === key ? state.editing : null

  useEffect(() => {
    let live = true
    api.invoke('doc:claim', { key, pane: holder, take: false }).then(
      (r) => live && setState({ key, editing: r.editing }),
      // Without an answer, edit (as before multiple windows): never block writing.
      () => live && setState({ key, editing: true }),
    )
    return () => {
      live = false
      void api.invoke('doc:release', { key, pane: holder }).catch(() => {})
    }
  }, [key, holder])

  // Another place takes over: save everything, stop editing, then say so.
  useIpcEvent('doc:yield', (request) => {
    if (request.key !== key || request.pane !== holder) return
    void flushAll().finally(() => {
      setState({ key, editing: false })
      void api.invoke('doc:yielded', { key, pane: holder })
    })
  })

  const take = useCallback(
    async (before?: () => Promise<void>) => {
      await api.invoke('doc:claim', { key, pane: holder, take: true })
      await before?.()
      setState({ key, editing: true })
    },
    [key, holder],
  )

  return { editing, take }
}
